from __future__ import annotations

import base64
import codecs
import hashlib
import json
import mimetypes
import os
from pathlib import Path
import queue
import signal
import subprocess
import sys
import threading
import time
from typing import Any, Callable
from urllib.parse import urlparse

import httpx

from .workspace import create_job_workspace, filter_child_environment, resolve_workspace_path, secret_values


LOG_CHUNK_SIZE = 8192
JOB_HEARTBEAT_SECONDS = 10.0
LEASE_SECONDS = 60.0
MAX_STAGED_FILE_BYTES = 64 * 1024 * 1024
MUTATION_RETRY_SECONDS = 0.2
COMPLETION_RETRY_SECONDS = 0.2
LOG_DELIVERY_DRAIN_SECONDS = 0.1
TERMINATION_GRACE_SECONDS = 0.25


class _Interrupted(Exception):
    def __init__(self, status: str) -> None:
        self.status = status


class _BoundaryRedactor:
    def __init__(self, secrets: tuple[str, ...]) -> None:
        self.secrets = tuple(sorted({value for value in secrets if value}, key=len, reverse=True))
        self.pending = {"stdout": "", "stderr": "", "system": ""}

    def feed(self, stream: str, text: str) -> str:
        combined = self.pending[stream] + text
        for secret in self.secrets:
            combined = combined.replace(secret, "[REDACTED]")
        held = 0
        for secret in self.secrets:
            for size in range(min(len(secret) - 1, len(combined)), 0, -1):
                if combined.endswith(secret[:size]):
                    held = max(held, size)
                    break
        self.pending[stream] = combined[-held:] if held else ""
        return combined[:-held] if held else combined

    def flush(self) -> list[dict[str, str]]:
        events = []
        for stream, text in self.pending.items():
            for secret in self.secrets:
                text = text.replace(secret, "[REDACTED]")
            if text:
                events.append({"stream": stream, "text": text})
            self.pending[stream] = ""
        return events


class _LogDelivery:
    def __init__(
        self,
        sink: Callable[[dict[str, str]], None],
        secrets: tuple[str, ...],
        terminal: threading.Event | None = None,
    ) -> None:
        self.sink = sink
        self.redactor = _BoundaryRedactor(secrets)
        self.queue: queue.Queue[dict[str, str]] = queue.Queue(maxsize=64)
        self.stop = terminal or threading.Event()
        self.active = threading.Event()
        self.failed = 0
        self.dropped = 0
        self.discarded = 0
        self.thread = threading.Thread(target=self._run, name="colab-job-logs", daemon=True)
        self.thread.start()

    def _enqueue(self, stream: str, text: str) -> None:
        for offset in range(0, len(text), LOG_CHUNK_SIZE):
            try:
                self.queue.put_nowait({"stream": stream, "text": text[offset:offset + LOG_CHUNK_SIZE]})
            except queue.Full:
                self.dropped += 1

    def emit(self, event: dict[str, str]) -> None:
        text = self.redactor.feed(event["stream"], event["text"])
        if text:
            self._enqueue(event["stream"], text)

    def _run(self) -> None:
        while not self.stop.is_set():
            try:
                event = self.queue.get(timeout=0.02)
            except queue.Empty:
                continue
            if self.stop.is_set():
                self.discarded += 1
                self.queue.task_done()
                break
            self.active.set()
            try:
                self.sink(event)
            except Exception:
                self.failed += 1
            finally:
                self.active.clear()
                self.queue.task_done()

    def close(self) -> tuple[bool, int]:
        for event in self.redactor.flush():
            self._enqueue(event["stream"], event["text"])

        def pending() -> int:
            with self.queue.all_tasks_done:
                return self.queue.unfinished_tasks

        deadline = time.monotonic() + LOG_DELIVERY_DRAIN_SECONDS
        while pending() and time.monotonic() < deadline:
            time.sleep(0.005)
        drained = pending() == 0
        self.stop.set()
        while True:
            try:
                self.queue.get_nowait()
            except queue.Empty:
                break
            self.discarded += 1
            self.queue.task_done()
        self.thread.join(timeout=0)
        incomplete = not drained or self.failed > 0 or self.dropped > 0 or self.discarded > 0
        outstanding = self.dropped + self.failed + self.discarded + int(self.active.is_set())
        return not incomplete, outstanding


def _failure(error_code: str, *, exit_code: int | None = None) -> dict[str, Any]:
    return {"status": "failed", "result": None, "exit_code": exit_code,
            "error_code": error_code, "artifacts": []}


def _reader(stream, name: str, output: queue.Queue[tuple[str, str | None]]) -> None:
    decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
    try:
        while True:
            data = os.read(stream.fileno(), LOG_CHUNK_SIZE)
            if not data:
                break
            text = decoder.decode(data)
            if text:
                output.put((name, text))
        tail = decoder.decode(b"", final=True)
        if tail:
            output.put((name, tail))
    finally:
        output.put((name, None))


def _terminate_group(proc: subprocess.Popen[str]) -> None:
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    deadline = time.monotonic() + TERMINATION_GRACE_SECONDS
    while time.monotonic() < deadline:
        try:
            os.killpg(proc.pid, 0)
        except ProcessLookupError:
            break
        proc.poll()
        time.sleep(0.01)
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    if proc.poll() is None:
        try:
            proc.wait(timeout=TERMINATION_GRACE_SECONDS)
        except subprocess.TimeoutExpired:
            pass


def _builtin_recipe(job: dict[str, Any], workspace: Path) -> dict[str, Any] | None:
    kind = job.get("kind")
    spec = job.get("spec")
    if not isinstance(spec, dict):
        raise ValueError("job spec must be an object")
    artifacts = spec.get("artifacts", [])
    if not isinstance(artifacts, list) or not all(isinstance(path, str) for path in artifacts):
        raise ValueError("artifacts must be a list of paths")
    common = {"cwd": str(workspace), "env": spec.get("env", {}), "artifacts": artifacts}
    if "result_path" in spec:
        common["result_path"] = spec["result_path"]
    if kind == "python":
        code = spec.get("code")
        if not isinstance(code, str):
            raise ValueError("python code must be a string")
        script = resolve_workspace_path(workspace, ".colab_bridge_python.py", create_parent=True)
        script.write_text(code, encoding="utf-8")
        return {**common, "argv": [sys.executable, "-u", str(script)]}
    if kind == "shell":
        command = spec.get("command")
        if not isinstance(command, str):
            raise ValueError("shell command must be a string")
        return {**common, "argv": ["/bin/bash", "-euo", "pipefail", "-c", command]}
    if kind == "pip":
        packages = spec.get("packages")
        if not isinstance(packages, list) or not packages or not all(isinstance(item, str) and item for item in packages):
            raise ValueError("pip packages must be a non-empty string list")
        return {**common, "argv": [sys.executable, "-m", "pip", "install", *packages]}
    return None


def _external_recipe(job: dict[str, Any], workspace: Path) -> dict[str, Any]:
    try:
        from .recipes import build_recipe
    except ModuleNotFoundError as error:
        if error.name == f"{__package__}.recipes":
            raise ValueError(f"unsupported job kind: {job.get('kind')}") from error
        raise
    return build_recipe(job, workspace)


def _validate_recipe(recipe: dict[str, Any], workspace: Path) -> tuple[list[str], Path, dict[str, str]]:
    if not isinstance(recipe, dict):
        raise ValueError("recipe must be an object")
    argv = recipe.get("argv")
    if not isinstance(argv, list) or not argv or not all(isinstance(arg, str) and arg for arg in argv):
        raise ValueError("recipe argv must be a non-empty string list")
    raw_cwd = recipe.get("cwd", str(workspace))
    if not isinstance(raw_cwd, str):
        raise ValueError("recipe cwd must be a string")
    root = workspace.resolve()
    cwd_path = Path(raw_cwd)
    cwd = cwd_path.resolve() if cwd_path.is_absolute() else resolve_workspace_path(root, raw_cwd).resolve()
    if not cwd.is_relative_to(root) or not cwd.is_dir():
        raise ValueError("recipe cwd must be an existing directory under the workspace")
    overrides = recipe.get("env", {})
    if not isinstance(overrides, dict):
        raise ValueError("recipe env must be an object")
    return argv, cwd, filter_child_environment(overrides=overrides)


def _artifact_manifest(workspace: Path, requested: Any) -> list[dict[str, Any]]:
    if not isinstance(requested, list) or not all(isinstance(path, str) for path in requested):
        raise ValueError("recipe artifacts must be a list of paths")
    files: list[tuple[str, Path]] = []
    for relative in requested:
        path = resolve_workspace_path(workspace, relative)
        if not path.exists() or path.is_symlink():
            raise FileNotFoundError(relative)
        if path.is_dir():
            for child in sorted(path.rglob("*")):
                if child.is_symlink():
                    raise ValueError("artifact directory contains a symlink")
                if child.is_file():
                    files.append((child.relative_to(workspace).as_posix(), child))
        elif path.is_file():
            files.append((relative, path))
        else:
            raise ValueError("artifact is not a regular file")
    manifests = []
    for relative, path in files:
        digest = hashlib.sha256()
        size = 0
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                size += len(chunk)
                digest.update(chunk)
        manifests.append({"path": relative, "bytes": size, "sha256": digest.hexdigest(),
                          "mime_type": mimetypes.guess_type(relative)[0] or "application/octet-stream"})
    return manifests


def _check_interrupted(deadline: float, cancelled: Callable[[], bool]) -> None:
    if cancelled():
        raise _Interrupted("cancelled")
    if time.monotonic() >= deadline:
        raise _Interrupted("timed_out")


def _stage_file(
    spec: dict[str, Any],
    workspace: Path,
    deadline: float,
    cancelled: Callable[[], bool],
) -> dict[str, Any]:
    relative = spec.get("path")
    if not isinstance(relative, str):
        raise ValueError("file path must be a string")
    sources = [key for key in ("text", "base64", "source_url") if key in spec]
    if len(sources) != 1:
        raise ValueError("file job requires exactly one content source")
    source = sources[0]
    _check_interrupted(deadline, cancelled)
    destination = resolve_workspace_path(workspace, relative, create_parent=True)
    temporary = resolve_workspace_path(workspace, relative + ".part", create_parent=True)
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(temporary, flags, 0o600)
    digest = hashlib.sha256()
    size = 0
    if source == "text":
        if not isinstance(spec[source], str):
            os.close(descriptor)
            temporary.unlink(missing_ok=True)
            raise ValueError("file text must be a string")
        data = spec[source].encode("utf-8")
    elif source == "base64":
        if not isinstance(spec[source], str):
            os.close(descriptor)
            temporary.unlink(missing_ok=True)
            raise ValueError("file base64 must be a string")
        try:
            data = base64.b64decode(spec[source], validate=True)
        except Exception:
            os.close(descriptor)
            temporary.unlink(missing_ok=True)
            raise
    else:
        url = spec[source]
        if not isinstance(url, str) or urlparse(url).scheme != "https":
            os.close(descriptor)
            temporary.unlink(missing_ok=True)
            raise ValueError("file source_url must use HTTPS")
        done = threading.Event()
        abort = threading.Event()
        transfer: dict[str, Any] = {"bytes": 0, "sha256": None, "error": None}

        def download() -> None:
            transfer_digest = hashlib.sha256()
            transferred = 0
            try:
                timeout = httpx.Timeout(connect=10, read=1, write=10, pool=10)
                with os.fdopen(descriptor, "wb") as handle:
                    with httpx.stream("GET", url, timeout=timeout, follow_redirects=True) as response:
                        response.raise_for_status()
                        for chunk in response.iter_bytes():
                            if abort.is_set():
                                return
                            transferred += len(chunk)
                            if transferred > MAX_STAGED_FILE_BYTES:
                                raise ValueError("staged file exceeds the size limit")
                            handle.write(chunk)
                            transfer_digest.update(chunk)
                transfer["bytes"] = transferred
                transfer["sha256"] = transfer_digest.hexdigest()
            except Exception as error:
                transfer["error"] = error
            finally:
                done.set()

        worker = threading.Thread(target=download, name="colab-file-download", daemon=True)
        worker.start()
        try:
            while not done.wait(0.02):
                _check_interrupted(deadline, cancelled)
            _check_interrupted(deadline, cancelled)
            if transfer["error"] is not None:
                raise ValueError("staged file download failed")
            size = transfer["bytes"]
            actual = transfer["sha256"]
        except BaseException:
            abort.set()
            temporary.unlink(missing_ok=True)
            raise
    if source != "source_url":
        try:
            if len(data) > MAX_STAGED_FILE_BYTES:
                raise ValueError("staged file exceeds the size limit")
            with os.fdopen(descriptor, "wb") as handle:
                for offset in range(0, len(data), 1024 * 1024):
                    _check_interrupted(deadline, cancelled)
                    chunk = data[offset:offset + 1024 * 1024]
                    handle.write(chunk)
                    digest.update(chunk)
                    size += len(chunk)
            actual = digest.hexdigest()
        except BaseException:
            temporary.unlink(missing_ok=True)
            raise
    try:
        _check_interrupted(deadline, cancelled)
        if spec.get("sha256") is not None and spec["sha256"] != actual:
            raise ValueError("staged file checksum mismatch")
        temporary.replace(destination)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    return {"status": "succeeded", "result": {"path": relative, "bytes": size, "sha256": actual},
            "exit_code": 0, "error_code": None, "artifacts": _artifact_manifest(workspace, [relative])}


def execute_job(job: dict[str, Any], workspace: str | Path, emit: Callable[[dict[str, str]], None],
                cancelled: Callable[[], bool]) -> dict[str, Any]:
    workspace_path = Path(workspace).resolve()
    workspace_path.mkdir(parents=True, exist_ok=True)
    extra_secrets = getattr(emit, "_colab_bridge_secrets", ())
    log_terminal = getattr(emit, "_colab_bridge_terminal", None)
    delivery = _LogDelivery(emit, secret_values() + tuple(extra_secrets), log_terminal)

    def finish(outcome: dict[str, Any]) -> dict[str, Any]:
        logs_complete, dropped = delivery.close()
        outcome["logs_complete"] = logs_complete
        outcome["dropped_log_chunks"] = dropped
        return outcome

    try:
        timeout_seconds = int(job.get("timeout_seconds", 900))
        if not 1 <= timeout_seconds <= 3600:
            raise ValueError("timeout_seconds must be from 1 through 3600")
        deadline = time.monotonic() + timeout_seconds
        spec = job.get("spec")
        if not isinstance(spec, dict):
            raise ValueError("job spec must be an object")
        _check_interrupted(deadline, cancelled)
        if job.get("kind") == "file":
            return finish(_stage_file(spec, workspace_path, deadline, cancelled))
        recipe = _builtin_recipe(job, workspace_path) or _external_recipe(job, workspace_path)
        argv, cwd, child_env = _validate_recipe(recipe, workspace_path)
    except _Interrupted as interrupted:
        error_code = "CANCELLED" if interrupted.status == "cancelled" else "TIMEOUT"
        return finish({"status": interrupted.status, "result": None, "exit_code": None,
                       "error_code": error_code, "artifacts": []})
    except Exception:
        delivery.emit({"stream": "system", "text": "Job validation failed\n"})
        return finish(_failure("INVALID_JOB"))

    try:
        _check_interrupted(deadline, cancelled)
        proc = subprocess.Popen(argv, cwd=cwd, env=child_env, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, start_new_session=True, text=True)
    except _Interrupted as interrupted:
        error_code = "CANCELLED" if interrupted.status == "cancelled" else "TIMEOUT"
        return finish({"status": interrupted.status, "result": None, "exit_code": None,
                       "error_code": error_code, "artifacts": []})
    except OSError:
        delivery.emit({"stream": "system", "text": "Could not start process\n"})
        return finish(_failure("PROCESS_START_FAILED"))
    output: queue.Queue[tuple[str, str | None]] = queue.Queue(maxsize=64)
    assert proc.stdout is not None and proc.stderr is not None
    readers = [threading.Thread(target=_reader, args=(proc.stdout, "stdout", output), daemon=True),
               threading.Thread(target=_reader, args=(proc.stderr, "stderr", output), daemon=True)]
    for thread in readers:
        thread.start()
    status, error_code, closed = "succeeded", None, 0
    drain_deadline = None
    while proc.poll() is None or closed < 2:
        try:
            stream, text = output.get(timeout=0.05)
            if text is None:
                closed += 1
            else:
                delivery.emit({"stream": stream, "text": text})
        except queue.Empty:
            pass
        if status == "succeeded" and cancelled():
            status, error_code = "cancelled", "CANCELLED"
            _terminate_group(proc)
            drain_deadline = time.monotonic() + TERMINATION_GRACE_SECONDS
        elif status == "succeeded" and time.monotonic() >= deadline:
            status, error_code = "timed_out", "TIMEOUT"
            _terminate_group(proc)
            drain_deadline = time.monotonic() + TERMINATION_GRACE_SECONDS
        if drain_deadline is not None and time.monotonic() >= drain_deadline:
            break
    try:
        returncode = proc.wait(timeout=TERMINATION_GRACE_SECONDS if drain_deadline is not None else None)
    except subprocess.TimeoutExpired:
        returncode = None
    if status == "succeeded" and returncode != 0:
        status, error_code = "failed", "PROCESS_EXIT"
    result_value = None
    manifests: list[dict[str, Any]] = []
    if status == "succeeded":
        try:
            manifests = _artifact_manifest(workspace_path, recipe.get("artifacts", []))
            result_path = recipe.get("result_path")
            if result_path is not None:
                if not isinstance(result_path, str):
                    raise ValueError("result_path must be a string")
                with resolve_workspace_path(workspace_path, result_path).open(encoding="utf-8") as handle:
                    result_value = json.load(handle)
        except FileNotFoundError:
            delivery.emit({"stream": "system", "text": "An expected output is missing\n"})
            status, error_code = "failed", "ARTIFACT_MISSING"
        except (ValueError, OSError, json.JSONDecodeError):
            delivery.emit({"stream": "system", "text": "Could not collect job outputs\n"})
            status, error_code = "failed", "OUTPUT_INVALID"
    return finish({"status": status, "result": result_value, "exit_code": returncode,
                   "error_code": error_code, "artifacts": manifests})


class JobRunner:
    def __init__(self, config, client, runtime_id: str, stop_event=None) -> None:
        self.config = config
        self.client = client
        self.runtime_id = runtime_id
        self.stop_event = stop_event or threading.Event()

    def _restore(self, job: dict[str, Any], workspace: Path) -> None:
        artifacts = job.get("restore_artifacts", [])
        if not isinstance(artifacts, list):
            raise ValueError("restore_artifacts must be a list")
        for artifact in artifacts:
            if not isinstance(artifact, dict):
                raise ValueError("restore artifact must be an object")
            relative, url = artifact.get("path"), artifact.get("download_url")
            if not isinstance(relative, str) or not isinstance(url, str):
                raise ValueError("restore artifact is missing its path or URL")
            destination = resolve_workspace_path(workspace, relative, create_parent=True)
            if hasattr(self.client, "download_artifact_to"):
                self.client.download_artifact_to(url, destination)
            else:
                destination.write_bytes(self.client.download_artifact(url))
            digest = hashlib.sha256()
            size = 0
            with destination.open("rb") as handle:
                for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                    size += len(chunk)
                    digest.update(chunk)
            if size != artifact.get("bytes") or digest.hexdigest() != artifact.get("sha256"):
                destination.unlink(missing_ok=True)
                raise ValueError("restore artifact integrity check failed")

    def run_once(self) -> bool:
        try:
            response = self.client.job_claim(self.runtime_id)
        except Exception:
            return False
        if response.get("ok") is not True or not isinstance(response.get("job"), dict):
            return False
        job = response["job"]
        job_id, lease_token = job.get("id"), job.get("lease_token")
        if not isinstance(job_id, str) or not isinstance(lease_token, str):
            return False
        cancellation, lease_lost, monitor_stop = threading.Event(), threading.Event(), threading.Event()
        lease_lock = threading.Lock()
        lease_deadline = [time.monotonic() + LEASE_SECONDS]

        def monitor_lease() -> None:
            while not monitor_stop.wait(JOB_HEARTBEAT_SECONDS):
                try:
                    heartbeat = self.client.job_heartbeat(self.runtime_id, job_id, lease_token)
                    if heartbeat.get("ok") is True and heartbeat.get("lease_valid") is False:
                        lease_lost.set()
                        return
                    if heartbeat.get("ok") is True and heartbeat.get("lease_valid") is True:
                        with lease_lock:
                            lease_deadline[0] = time.monotonic() + LEASE_SECONDS
                        if heartbeat.get("cancel_requested") is True:
                            cancellation.set()
                except Exception:
                    pass
                with lease_lock:
                    expired = time.monotonic() >= lease_deadline[0]
                if expired:
                    lease_lost.set()
                    return
        monitor = threading.Thread(target=monitor_lease, name="colab-job-lease", daemon=True)
        monitor.start()
        sequence = 0
        sequence_lock = threading.Lock()
        log_terminal = threading.Event()

        def send_log(stream: str, text: str) -> None:
            nonlocal sequence
            for offset in range(0, len(text), LOG_CHUNK_SIZE):
                chunk = text[offset:offset + LOG_CHUNK_SIZE]
                with sequence_lock:
                    current, sequence = sequence, sequence + 1
                last_error: Exception | None = None
                for attempt in range(3):
                    if log_terminal.is_set() or lease_lost.is_set():
                        raise RuntimeError("job log delivery ended")
                    try:
                        response = self.client.job_log(
                            self.runtime_id, job_id, lease_token, current, stream, chunk)
                        if response.get("ok") is True:
                            last_error = None
                            break
                        last_error = RuntimeError("job log was rejected")
                    except Exception as error:
                        last_error = error
                    if attempt < 2:
                        if log_terminal.wait(MUTATION_RETRY_SECONDS) or lease_lost.is_set():
                            raise RuntimeError("job log delivery ended") from None
                if last_error is not None:
                    raise RuntimeError("job log delivery failed") from None

        def emit(event: dict[str, str]) -> None:
            send_log(event["stream"], event["text"])

        emit._colab_bridge_secrets = (self.config.agent_key,)  # type: ignore[attr-defined]
        emit._colab_bridge_terminal = log_terminal  # type: ignore[attr-defined]

        def complete(outcome: dict[str, Any]) -> bool:
            result = outcome["result"]
            if outcome.get("logs_complete") is False:
                log_report = {
                    "logs_complete": False,
                    "dropped_log_chunks": outcome.get("dropped_log_chunks", 0),
                }
                if isinstance(result, dict):
                    result = {**result, "_colab_bridge": log_report}
                else:
                    result = {"value": result, "_colab_bridge": log_report}
            envelope = (
                self.runtime_id, job_id, lease_token, outcome["status"], result,
                outcome["exit_code"], outcome["error_code"],
            )
            attempts = 0
            retry_deadline = time.monotonic() + LEASE_SECONDS
            definitive = {"LEASE_INVALID", "STALE_LEASE", "LEASE_LOST", "INVALID_LEASE"}
            while not lease_lost.is_set():
                attempts += 1
                try:
                    completed = self.client.job_complete(*envelope)
                    if completed.get("ok") is True:
                        return True
                    if completed.get("error_code") in definitive:
                        lease_lost.set()
                        return False
                except Exception:
                    pass
                if self.stop_event.is_set() and attempts > 0:
                    return False
                with lease_lock:
                    remaining = min(lease_deadline[0], retry_deadline) - time.monotonic()
                if remaining <= 0:
                    lease_lost.set()
                    return False
                monitor_stop.wait(min(COMPLETION_RETRY_SECONDS, remaining))
            return False

        try:
            try:
                workspace = create_job_workspace(self.config.workspace_root, job.get("project"), job_id)
                self._restore(job, workspace)
            except Exception:
                if not lease_lost.is_set():
                    complete({"status": "failed", "result": None, "exit_code": None,
                              "error_code": "RESTORE_FAILED", "artifacts": []})
                return True
            if lease_lost.is_set():
                return True
            outcome = execute_job(
                job,
                workspace,
                emit,
                lambda: cancellation.is_set() or lease_lost.is_set() or self.stop_event.is_set(),
            )
            if lease_lost.is_set():
                return True
            if self.stop_event.is_set() and outcome["status"] == "cancelled":
                outcome["error_code"] = "AGENT_STOPPED"
            if outcome["status"] == "succeeded":
                try:
                    for manifest in outcome["artifacts"]:
                        if lease_lost.is_set() or cancellation.is_set():
                            break
                        prepared = self.client.artifact_prepare(self.runtime_id, job_id, lease_token, **manifest)
                        if (prepared.get("ok") is not True or prepared.get("upload_method") != "PUT"
                                or not isinstance(prepared.get("artifact_id"), str)
                                or not isinstance(prepared.get("upload_url"), str)):
                            raise RuntimeError("artifact preparation failed")
                        path = resolve_workspace_path(workspace, manifest["path"])
                        self.client.upload_artifact(prepared["upload_url"], path, manifest["mime_type"])
                        if lease_lost.is_set():
                            return True
                        completed = self.client.artifact_complete(
                            self.runtime_id, job_id, lease_token, prepared["artifact_id"])
                        if completed.get("ok") is not True:
                            raise RuntimeError("artifact registration failed")
                    if cancellation.is_set():
                        outcome.update(status="cancelled", result=None, error_code="CANCELLED")
                except Exception:
                    outcome.update(status="failed", result=None, error_code="ARTIFACT_UPLOAD_FAILED")
            if lease_lost.is_set():
                return True
            complete(outcome)
            return True
        finally:
            monitor_stop.set()
            monitor.join(timeout=JOB_HEARTBEAT_SECONDS + 1)

    def run_forever(self) -> None:
        while not self.stop_event.is_set():
            try:
                self.run_once()
            except Exception:
                pass
            self.stop_event.wait(self.config.job_poll_seconds)
