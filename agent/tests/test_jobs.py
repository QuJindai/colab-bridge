from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import time
import uuid

import httpx
import pytest

from colab_bridge_agent.client import AgentClient
from colab_bridge_agent.config import AgentConfig
from colab_bridge_agent.jobs import JobRunner, execute_job
from colab_bridge_agent.workspace import filter_child_environment, resolve_workspace_path


def job(kind, spec, *, timeout_seconds=5):
    return {
        "id": "11111111-1111-4111-8111-111111111111",
        "kind": kind,
        "spec": spec,
        "project": "tests",
        "timeout_seconds": timeout_seconds,
        "attempt": 1,
        "lease_token": "22222222-2222-4222-8222-222222222222",
    }


def test_python_result(tmp_path):
    events = []
    result = execute_job(
        job("python", {"code": 'print("bridge-ok")'}),
        tmp_path,
        events.append,
        lambda: False,
    )
    assert result["status"] == "succeeded"
    assert any("bridge-ok" in event["text"] for event in events)


def test_timeout_kills_group(tmp_path):
    result = execute_job(
        job("python", {"code": "import time; time.sleep(30)"}, timeout_seconds=1),
        tmp_path,
        lambda event: None,
        lambda: False,
    )
    assert result["status"] == "timed_out"


def test_timeout_kills_descendant_after_process_leader_exits(tmp_path):
    started = time.monotonic()
    result = execute_job(
        job("shell", {"command": "sleep 30 & exit 0"}, timeout_seconds=1),
        tmp_path,
        lambda event: None,
        lambda: False,
    )
    assert result["status"] == "timed_out"
    assert time.monotonic() - started < 3


def test_termination_escalates_for_term_ignoring_descendant(tmp_path):
    command = (
        "python -c \"import signal,time; "
        "signal.signal(signal.SIGTERM, lambda *args: open('term-seen', 'w').write('yes')); "
        "open('ready', 'w').write('yes'); time.sleep(30)\" & "
        "while [ ! -f ready ]; do sleep .01; done; exit 0"
    )
    started = time.monotonic()
    result = execute_job(
        job("shell", {"command": command}, timeout_seconds=1),
        tmp_path,
        lambda event: None,
        lambda: False,
    )
    assert result["status"] == "timed_out"
    assert (tmp_path / "term-seen").read_text() == "yes"
    assert time.monotonic() - started < 3


def test_shell_streams_stderr_and_reports_nonzero_exit(tmp_path):
    events = []
    result = execute_job(
        job("shell", {"command": "echo broken >&2; exit 7"}),
        tmp_path,
        events.append,
        lambda: False,
    )
    assert result["status"] == "failed"
    assert result["exit_code"] == 7
    assert result["error_code"] == "PROCESS_EXIT"
    assert any(event["stream"] == "stderr" and "broken" in event["text"] for event in events)


def test_cancellation_kills_descendant_process(tmp_path):
    started = time.monotonic()
    result = execute_job(
        job("shell", {"command": "sleep 30 & echo $! > child.pid; wait"}),
        tmp_path,
        lambda event: None,
        lambda: time.monotonic() - started > 0.2,
    )
    assert result["status"] == "cancelled"
    child_pid = int((tmp_path / "child.pid").read_text())
    deadline = time.monotonic() + 1
    while time.monotonic() < deadline:
        try:
            os.kill(child_pid, 0)
        except ProcessLookupError:
            break
        time.sleep(0.01)
    else:
        pytest.fail("descendant process survived cancellation")


def test_log_chunks_are_bounded(tmp_path):
    events = []
    result = execute_job(
        job("python", {"code": "print('x' * 20000)"}),
        tmp_path,
        events.append,
        lambda: False,
    )
    assert result["status"] == "succeeded"
    assert max(len(event["text"]) for event in events) <= 8192
    assert sum(len(event["text"]) for event in events) == 20001


def test_output_is_emitted_while_process_is_still_running(tmp_path):
    seen_at = []
    started = time.monotonic()
    result = execute_job(
        job("python", {"code": "import time; print('early', flush=True); time.sleep(.25)"}),
        tmp_path,
        lambda event: seen_at.append((time.monotonic(), event)),
        lambda: False,
    )
    assert result["status"] == "succeeded"
    assert any("early" in event["text"] for _, event in seen_at)
    assert seen_at[0][0] - started < 0.2


def test_slow_log_sink_does_not_delay_timeout(tmp_path):
    def slow_emit(event):
        time.sleep(2.4)

    started = time.monotonic()
    result = execute_job(
        job("python", {"code": "print('first', flush=True); import time; time.sleep(30)"}, timeout_seconds=1),
        tmp_path,
        slow_emit,
        lambda: False,
    )
    assert result["status"] == "timed_out"
    assert time.monotonic() - started < 1.8
    assert result["logs_complete"] is False
    assert result["dropped_log_chunks"] >= 0


def test_log_delivery_discards_queued_chunks_after_close_budget(tmp_path):
    calls = []

    def slow_sink(event):
        calls.append(event)
        time.sleep(0.3)

    result = execute_job(
        job("python", {"code": "import os; os.write(1, b'x' * (8192 * 5))"}),
        tmp_path,
        slow_sink,
        lambda: False,
    )
    calls_at_return = len(calls)
    time.sleep(0.7)
    assert result["status"] == "succeeded"
    assert result["logs_complete"] is False
    assert result["dropped_log_chunks"] >= 4
    assert calls_at_return == 1
    assert len(calls) == calls_at_return


def test_pip_adapter_runs_real_argument_list(tmp_path):
    events = []
    result = execute_job(
        job("pip", {"packages": ["--help"]}),
        tmp_path,
        events.append,
        lambda: False,
    )
    assert result["status"] == "succeeded"
    assert any("Usage" in event["text"] for event in events)


def test_environment_redacts_secrets_from_child_and_logs(tmp_path, monkeypatch):
    monkeypatch.setenv("COLAB_BRIDGE_AGENT_KEY", "agent-super-secret")
    monkeypatch.setenv("ORDINARY_SETTING", "visible")
    events = []
    result = execute_job(
        job(
            "python",
            {
                "code": (
                    "import os; "
                    "print(os.environ.get('COLAB_BRIDGE_AGENT_KEY', 'missing')); "
                    "print(os.environ['ORDINARY_SETTING'])"
                )
            },
        ),
        tmp_path,
        events.append,
        lambda: False,
    )
    output = "".join(event["text"] for event in events)
    assert result["status"] == "succeeded"
    assert "agent-super-secret" not in output
    assert "missing" in output
    assert "visible" in output


def test_environment_secret_is_redacted_across_stdout_and_stderr_boundaries(tmp_path, monkeypatch):
    monkeypatch.setenv("SERVICE_TOKEN", "split-test-credential")
    events = []
    code = (
        "import os,time; "
        "os.write(1, b'split-test-'); time.sleep(.05); os.write(1, b'credential\\n'); "
        "os.write(2, b'split-test-'); time.sleep(.05); os.write(2, b'credential\\n')"
    )
    result = execute_job(job("python", {"code": code}), tmp_path, events.append, lambda: False)
    output = "".join(event["text"] for event in events)
    assert result["status"] == "succeeded"
    assert "split-test-credential" not in output
    assert sum("[REDACTED]" in event["text"] for event in events) >= 2


def test_secret_environment_override_is_rejected():
    with pytest.raises(ValueError, match="sensitive"):
        filter_child_environment({}, {"API_TOKEN": "do-not-pass"})


def test_workspace_path_rejects_traversal_and_symlink_escape(tmp_path):
    outside = tmp_path.parent / "outside.txt"
    outside.write_text("private")
    (tmp_path / "link").symlink_to(outside)
    with pytest.raises(ValueError):
        resolve_workspace_path(tmp_path, "../outside.txt")
    with pytest.raises(ValueError):
        resolve_workspace_path(tmp_path, "link")


def test_file_staging_and_artifact_checksum(tmp_path):
    result = execute_job(
        job("file", {"path": "inputs/hello.txt", "text": "hello bridge"}),
        tmp_path,
        lambda event: None,
        lambda: False,
    )
    assert result["status"] == "succeeded"
    assert (tmp_path / "inputs/hello.txt").read_text() == "hello bridge"
    assert result["artifacts"] == [
        {
            "path": "inputs/hello.txt",
            "bytes": 12,
            "sha256": hashlib.sha256(b"hello bridge").hexdigest(),
            "mime_type": "text/plain",
        }
    ]


def test_result_path_is_loaded_as_json(tmp_path):
    result = execute_job(
        job(
            "python",
            {
                "code": "import json; open('result.json', 'w').write(json.dumps({'score': 3}))",
                "result_path": "result.json",
                "artifacts": ["result.json"],
            },
        ),
        tmp_path,
        lambda event: None,
        lambda: False,
    )
    assert result["status"] == "succeeded"
    assert result["result"] == {"score": 3}
    assert result["artifacts"][0]["sha256"] == hashlib.sha256(
        json.dumps({"score": 3}).encode()
    ).hexdigest()


class RecordingClient:
    def __init__(self, claimed_job):
        self.claimed_job = claimed_job
        self.calls = []

    def job_claim(self, runtime_id):
        self.calls.append(("claim", runtime_id))
        claimed, self.claimed_job = self.claimed_job, None
        return {"ok": True, "job": claimed}

    def job_heartbeat(self, runtime_id, job_id, lease_token):
        self.calls.append(("heartbeat", runtime_id, job_id, lease_token))
        return {"ok": True, "lease_valid": True, "cancel_requested": False}

    def job_log(self, runtime_id, job_id, lease_token, seq, stream, text):
        self.calls.append(("log", seq, stream, text))
        return {"ok": True}

    def artifact_prepare(self, runtime_id, job_id, lease_token, **manifest):
        self.calls.append(("prepare", manifest))
        return {
            "ok": True,
            "artifact_id": "33333333-3333-4333-8333-333333333333",
            "upload_url": "https://storage.test/upload",
            "upload_method": "PUT",
        }

    def upload_artifact(self, upload_url, data, mime_type):
        self.calls.append(("upload", upload_url, data, mime_type))

    def artifact_complete(self, runtime_id, job_id, lease_token, artifact_id):
        self.calls.append(("artifact_complete", artifact_id))
        return {"ok": True}

    def job_complete(self, runtime_id, job_id, lease_token, status, result, exit_code, error_code):
        self.calls.append(("job_complete", status, result, exit_code, error_code))
        return {"ok": True}


def test_runner_persists_logs_artifact_then_completion(tmp_path):
    claimed = job(
        "python",
        {"code": "open('out.txt', 'w').write('saved'); print('logged')", "artifacts": ["out.txt"]},
    )
    client = RecordingClient(claimed)
    config = AgentConfig(
        "https://example.test/agent",
        "secret",
        execution_enabled=True,
        workspace_root=str(tmp_path),
    )
    assert JobRunner(config, client, "runtime-1").run_once() is True
    kinds = [call[0] for call in client.calls]
    assert "log" in kinds
    assert kinds.index("prepare") < kinds.index("upload") < kinds.index("artifact_complete")
    assert kinds.index("artifact_complete") < kinds.index("job_complete")
    completion = next(call for call in client.calls if call[0] == "job_complete")
    assert completion[1:] == ("succeeded", None, 0, None)


def test_restore_download_is_verified_before_execution(tmp_path):
    payload = b"restored input"
    claimed = job(
        "python",
        {"code": "print(open('input.txt').read())"},
    )
    claimed["restore_artifacts"] = [{
        "path": "input.txt",
        "bytes": len(payload),
        "sha256": hashlib.sha256(payload).hexdigest(),
        "mime_type": "text/plain",
        "download_url": "https://storage.test/download",
    }]
    client = RecordingClient(claimed)
    client.download_artifact = lambda url: payload
    config = AgentConfig(
        "https://example.test/agent",
        "secret",
        execution_enabled=True,
        workspace_root=str(tmp_path),
    )
    JobRunner(config, client, "runtime-1").run_once()
    assert any(call[0] == "log" and "restored input" in call[3] for call in client.calls)


def test_failed_restore_completes_job_without_running(tmp_path):
    claimed = job("python", {"code": "raise AssertionError('must not run')"})
    claimed["restore_artifacts"] = [{
        "path": "input.txt",
        "bytes": 3,
        "sha256": hashlib.sha256(b"good").hexdigest(),
        "mime_type": "text/plain",
        "download_url": "https://storage.test/download",
    }]
    client = RecordingClient(claimed)
    client.download_artifact = lambda url: b"bad"
    config = AgentConfig(
        "https://example.test/agent", "secret", execution_enabled=True, workspace_root=str(tmp_path)
    )
    JobRunner(config, client, "runtime-1").run_once()
    completion = next(call for call in client.calls if call[0] == "job_complete")
    assert completion[1] == "failed"
    assert completion[4] == "RESTORE_FAILED"


def test_cancellation_during_restore_keeps_renewing_and_never_starts_code(tmp_path, monkeypatch):
    monkeypatch.setattr("colab_bridge_agent.jobs.JOB_HEARTBEAT_SECONDS", 0.02)
    payload = b"input"
    claimed = job("python", {"code": "open('user-side-effect', 'w').write('ran')"})
    claimed["restore_artifacts"] = [{
        "path": "input.txt",
        "bytes": len(payload),
        "sha256": hashlib.sha256(payload).hexdigest(),
        "mime_type": "text/plain",
        "download_url": "https://storage.test/download",
    }]

    class CancelDuringRestoreClient(RecordingClient):
        heartbeat_count = 0

        def job_heartbeat(self, runtime_id, job_id, lease_token):
            self.heartbeat_count += 1
            self.calls.append(("heartbeat", runtime_id, job_id, lease_token))
            return {"ok": True, "lease_valid": True, "cancel_requested": True}

        def download_artifact(self, url):
            time.sleep(0.12)
            return payload

    client = CancelDuringRestoreClient(claimed)
    config = AgentConfig(
        "https://example.test/agent", "secret", execution_enabled=True, workspace_root=str(tmp_path)
    )
    JobRunner(config, client, "runtime-1").run_once()
    completion = next(call for call in client.calls if call[0] == "job_complete")
    assert completion[1] == "cancelled"
    assert client.heartbeat_count >= 3
    assert not any(tmp_path.rglob("user-side-effect"))


def test_runner_redacts_direct_config_agent_key(tmp_path):
    claimed = job("python", {"code": "print('direct-agent-secret')"})
    client = RecordingClient(claimed)
    config = AgentConfig(
        "https://example.test/agent",
        "direct-agent-secret",
        execution_enabled=True,
        workspace_root=str(tmp_path),
    )
    JobRunner(config, client, "runtime-1").run_once()
    logs = "".join(call[3] for call in client.calls if call[0] == "log")
    assert "direct-agent-secret" not in logs
    assert "[REDACTED]" in logs


def test_transient_job_heartbeat_failure_does_not_abort_job(tmp_path, monkeypatch):
    monkeypatch.setattr("colab_bridge_agent.jobs.JOB_HEARTBEAT_SECONDS", 0.02)
    monkeypatch.setattr("colab_bridge_agent.jobs.LEASE_SECONDS", 0.3)

    class TransientClient(RecordingClient):
        heartbeat_count = 0

        def job_heartbeat(self, runtime_id, job_id, lease_token):
            self.heartbeat_count += 1
            if self.heartbeat_count == 1:
                raise OSError("temporary network failure")
            return super().job_heartbeat(runtime_id, job_id, lease_token)

    client = TransientClient(job("python", {"code": "import time; time.sleep(.12)"}))
    config = AgentConfig(
        "https://example.test/agent", "secret", execution_enabled=True, workspace_root=str(tmp_path)
    )
    JobRunner(config, client, "runtime-1").run_once()
    completion = next(call for call in client.calls if call[0] == "job_complete")
    assert client.heartbeat_count >= 2
    assert completion[1] == "succeeded"


def test_lease_loss_terminates_process_without_stale_completion(tmp_path, monkeypatch):
    monkeypatch.setattr("colab_bridge_agent.jobs.JOB_HEARTBEAT_SECONDS", 0.02)

    class LostLeaseClient(RecordingClient):
        def job_heartbeat(self, runtime_id, job_id, lease_token):
            return {"ok": True, "lease_valid": False, "cancel_requested": False}

    client = LostLeaseClient(job("python", {"code": "import time; time.sleep(30)"}))
    config = AgentConfig(
        "https://example.test/agent", "secret", execution_enabled=True, workspace_root=str(tmp_path)
    )
    started = time.monotonic()
    JobRunner(config, client, "runtime-1").run_once()
    assert time.monotonic() - started < 1
    assert not any(call[0] == "job_complete" for call in client.calls)


def test_lease_renews_during_restore_and_artifact_upload(tmp_path, monkeypatch):
    monkeypatch.setattr("colab_bridge_agent.jobs.JOB_HEARTBEAT_SECONDS", 0.02)
    payload = b"input"
    claimed = job(
        "python",
        {"code": "open('out.txt', 'w').write(open('input.txt').read())", "artifacts": ["out.txt"]},
    )
    claimed["restore_artifacts"] = [{
        "path": "input.txt",
        "bytes": len(payload),
        "sha256": hashlib.sha256(payload).hexdigest(),
        "mime_type": "text/plain",
        "download_url": "https://storage.test/download",
    }]

    class SlowTransferClient(RecordingClient):
        heartbeat_count = 0

        def job_heartbeat(self, runtime_id, job_id, lease_token):
            self.heartbeat_count += 1
            return super().job_heartbeat(runtime_id, job_id, lease_token)

        def download_artifact(self, url):
            time.sleep(0.07)
            return payload

        def upload_artifact(self, upload_url, data, mime_type):
            time.sleep(0.07)
            return super().upload_artifact(upload_url, data, mime_type)

    client = SlowTransferClient(claimed)
    config = AgentConfig(
        "https://example.test/agent", "secret", execution_enabled=True, workspace_root=str(tmp_path)
    )
    JobRunner(config, client, "runtime-1").run_once()
    assert client.heartbeat_count >= 4


def test_transient_log_failure_retries_same_sequence(tmp_path, monkeypatch):
    monkeypatch.setattr("colab_bridge_agent.jobs.MUTATION_RETRY_SECONDS", 0)

    class FlakyLogClient(RecordingClient):
        attempts = []

        def job_log(self, runtime_id, job_id, lease_token, seq, stream, text):
            self.attempts.append(seq)
            if len(self.attempts) == 1:
                raise OSError("temporary")
            return super().job_log(runtime_id, job_id, lease_token, seq, stream, text)

    client = FlakyLogClient(job("python", {"code": "print('persisted-log')"}))
    config = AgentConfig(
        "https://example.test/agent", "secret", execution_enabled=True, workspace_root=str(tmp_path)
    )
    JobRunner(config, client, "runtime-1").run_once()
    assert client.attempts[:2] == [0, 0]
    assert any(call[0] == "log" and "persisted-log" in call[3] for call in client.calls)


def test_rejected_log_delivery_is_reported_in_persisted_result(tmp_path, monkeypatch):
    monkeypatch.setattr("colab_bridge_agent.jobs.MUTATION_RETRY_SECONDS", 0)

    class RejectLogClient(RecordingClient):
        def job_log(self, runtime_id, job_id, lease_token, seq, stream, text):
            return {"ok": False, "error_code": "BACKEND_ERROR"}

    client = RejectLogClient(job("python", {"code": "print('not-persisted')"}))
    config = AgentConfig(
        "https://example.test/agent", "secret", execution_enabled=True, workspace_root=str(tmp_path)
    )
    JobRunner(config, client, "runtime-1").run_once()
    completion = next(call for call in client.calls if call[0] == "job_complete")
    assert completion[2]["_colab_bridge"]["logs_complete"] is False
    assert completion[2]["_colab_bridge"]["dropped_log_chunks"] >= 1


def test_log_retry_stops_when_delivery_closes(tmp_path, monkeypatch):
    monkeypatch.setattr("colab_bridge_agent.jobs.MUTATION_RETRY_SECONDS", 0.3)

    class FailingLogClient(RecordingClient):
        attempts = 0

        def job_log(self, runtime_id, job_id, lease_token, seq, stream, text):
            self.attempts += 1
            raise OSError("blocked backend")

    client = FailingLogClient(job("python", {"code": "print('one-log')"}))
    config = AgentConfig(
        "https://example.test/agent", "secret", execution_enabled=True, workspace_root=str(tmp_path)
    )
    JobRunner(config, client, "runtime-1").run_once()
    attempts_at_return = client.attempts
    time.sleep(0.4)
    completion = next(call for call in client.calls if call[0] == "job_complete")
    assert attempts_at_return == 1
    assert client.attempts == attempts_at_return
    assert completion[2]["_colab_bridge"]["logs_complete"] is False


@pytest.mark.parametrize("restore_failure", [False, True])
def test_transient_completion_failure_retries_exact_outcome(tmp_path, monkeypatch, restore_failure):
    monkeypatch.setattr("colab_bridge_agent.jobs.COMPLETION_RETRY_SECONDS", 0.03)
    monkeypatch.setattr("colab_bridge_agent.jobs.JOB_HEARTBEAT_SECONDS", 0.01)
    claimed = job("python", {"code": "print('once')"})
    if restore_failure:
        claimed["restore_artifacts"] = [{
            "path": "bad.txt",
            "bytes": 4,
            "sha256": hashlib.sha256(b"good").hexdigest(),
            "mime_type": "text/plain",
            "download_url": "https://storage.test/download",
        }]

    class FlakyCompleteClient(RecordingClient):
        completions = []
        heartbeat_count = 0

        def download_artifact(self, url):
            return b"bad"

        def job_complete(self, *args):
            self.completions.append(args)
            if len(self.completions) < 3:
                raise OSError("temporary completion failure")
            return super().job_complete(*args)

        def job_heartbeat(self, runtime_id, job_id, lease_token):
            self.heartbeat_count += 1
            return super().job_heartbeat(runtime_id, job_id, lease_token)

    client = FlakyCompleteClient(claimed)
    config = AgentConfig(
        "https://example.test/agent", "secret", execution_enabled=True, workspace_root=str(tmp_path)
    )
    JobRunner(config, client, "runtime-1").run_once()
    assert len(client.completions) == 3
    assert client.completions[0] == client.completions[1] == client.completions[2]
    assert client.heartbeat_count >= 2


@pytest.mark.parametrize("mode", ["timeout", "cancel"])
def test_file_download_obeys_deadline_and_cancellation_without_partial_commit(tmp_path, monkeypatch, mode):
    class SlowResponse:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def raise_for_status(self):
            return None

        def iter_bytes(self):
            for _ in range(30):
                time.sleep(0.1)
                yield b"x"

    monkeypatch.setattr("colab_bridge_agent.jobs.httpx.stream", lambda *args, **kwargs: SlowResponse())
    started = time.monotonic()
    cancelled = lambda: mode == "cancel" and time.monotonic() - started >= 0.2
    result = execute_job(
        job("file", {"path": "slow.bin", "source_url": "https://files.test/slow"}, timeout_seconds=1),
        tmp_path,
        lambda event: None,
        cancelled,
    )
    assert result["status"] == ("cancelled" if mode == "cancel" else "timed_out")
    assert time.monotonic() - started < 1.5
    assert not (tmp_path / "slow.bin").exists()
    assert not (tmp_path / "slow.bin.part").exists()

def test_client_job_and_artifact_operations_have_fenced_shapes(tmp_path):
    bodies = []
    upload_headers = {}
    download_headers = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "PUT":
            upload_headers.update(request.headers)
            assert request.content == b"artifact"
            return httpx.Response(200)
        if request.method == "GET":
            download_headers.update(request.headers)
            return httpx.Response(200, content=b"restored")
        bodies.append(json.loads(request.content))
        if bodies[-1]["op"] == "job_claim":
            return httpx.Response(200, json={"ok": True, "job": None})
        if bodies[-1]["op"] == "artifact_prepare":
            return httpx.Response(200, json={
                "ok": True,
                "artifact_id": "artifact-1",
                "upload_url": "https://storage.test/upload",
                "upload_method": "PUT",
            })
        return httpx.Response(200, json={"ok": True})

    client = AgentClient(
        "https://example.test/agent",
        "agent-secret",
        http_client=httpx.Client(
            transport=httpx.MockTransport(handler),
            headers={"X-Default-Credential": "leak"},
            cookies={"session": "cookie-secret"},
            auth=httpx.BasicAuth("user", "password"),
        ),
    )
    assert client.job_claim("runtime-1") == {"ok": True, "job": None}
    client.job_heartbeat("runtime-1", "job-1", "lease-1")
    client.job_log("runtime-1", "job-1", "lease-1", 4, "stdout", "hello")
    client.job_complete("runtime-1", "job-1", "lease-1", "succeeded", {"score": 1}, 0, None)
    prepared = client.artifact_prepare(
        "runtime-1", "job-1", "lease-1", path="out.txt", bytes=8,
        sha256="a" * 64, mime_type="text/plain",
    )
    upload_path = tmp_path / "artifact.txt"
    upload_path.write_bytes(b"artifact")
    client.upload_artifact(prepared["upload_url"], upload_path, "text/plain")
    assert client.download_artifact("https://storage.test/download") == b"restored"
    download_path = tmp_path / "restored.txt"
    client.download_artifact_to("https://storage.test/download", download_path)
    assert download_path.read_bytes() == b"restored"
    client.artifact_complete("runtime-1", "job-1", "lease-1", prepared["artifact_id"])
    assert bodies == [
        {"op": "job_claim", "runtime_id": "runtime-1"},
        {"op": "job_heartbeat", "runtime_id": "runtime-1", "job_id": "job-1", "lease_token": "lease-1"},
        {"op": "job_log", "runtime_id": "runtime-1", "job_id": "job-1", "lease_token": "lease-1",
         "seq": 4, "stream": "stdout", "text": "hello"},
        {"op": "job_complete", "runtime_id": "runtime-1", "job_id": "job-1", "lease_token": "lease-1",
         "status": "succeeded", "result": {"score": 1}, "exit_code": 0, "error_code": None},
        {"op": "artifact_prepare", "runtime_id": "runtime-1", "job_id": "job-1", "lease_token": "lease-1",
         "path": "out.txt", "bytes": 8, "sha256": "a" * 64, "mime_type": "text/plain"},
        {"op": "artifact_complete", "runtime_id": "runtime-1", "job_id": "job-1", "lease_token": "lease-1",
         "artifact_id": "artifact-1"},
    ]
    assert upload_headers["content-type"] == "text/plain"
    assert "x-colab-agent-key" not in upload_headers
    assert "x-colab-agent-key" not in download_headers
    for headers in (upload_headers, download_headers):
        assert "authorization" not in headers
        assert "cookie" not in headers
        assert "x-default-credential" not in headers


def test_config_reads_execution_workspace_and_validated_runtime_id(monkeypatch):
    runtime_id = str(uuid.uuid4())
    monkeypatch.setenv("COLAB_BRIDGE_AGENT_URL", "https://example.test/agent")
    monkeypatch.setenv("COLAB_BRIDGE_AGENT_KEY", "secret")
    monkeypatch.setenv("COLAB_BRIDGE_RUNTIME_ID", runtime_id)
    monkeypatch.setenv("COLAB_BRIDGE_EXECUTION_ENABLED", "1")
    monkeypatch.setenv("COLAB_BRIDGE_WORKSPACE_ROOT", "/tmp/bridge-work")
    config = AgentConfig.from_env()
    assert config.runtime_id == runtime_id
    assert config.execution_enabled is True
    assert config.workspace_root == "/tmp/bridge-work"
    with pytest.raises(ValueError, match="UUID"):
        AgentConfig("https://example.test", "secret", runtime_id="not-a-uuid")


def test_run_agent_retries_transient_registration_and_probe_errors(monkeypatch):
    from colab_bridge_agent.main import run_agent

    runtime_id = str(uuid.uuid4())
    register_ids = []
    heartbeat_payloads = []

    class FlakyClient:
        def register(self, current_runtime_id, label, payload):
            register_ids.append(current_runtime_id)
            if len(register_ids) == 1:
                raise httpx.ConnectError("temporary")
            assert payload["agent_version"] == "0.2.0"
            assert payload["execution_enabled"] is False
            return {"ok": True}

        def snapshot(self, *args):
            return {"ok": True}

        def heartbeat(self, current_runtime_id, payload):
            heartbeat_payloads.append(payload)
            return {"ok": True}

        def poll(self, runtime_id):
            return {"ok": True, "commands": []}

    gpu_calls = 0

    def flaky_gpu():
        nonlocal gpu_calls
        gpu_calls += 1
        if gpu_calls == 1:
            raise RuntimeError("probe unavailable")
        return {"accelerator": "cpu", "telemetry_available": True}

    monkeypatch.setattr("time.sleep", lambda seconds: None)
    config = AgentConfig("https://example.test", "secret", runtime_id=runtime_id)
    assert run_agent(
        config,
        client=FlakyClient(),
        max_cycles=2,
        probes={
            "refresh_gpu": flaky_gpu,
            "refresh_runtime": lambda: {"python_version": "3.12"},
            "refresh_processes": lambda: {"processes": []},
        },
    ) == runtime_id
    assert register_ids == [runtime_id, runtime_id]
    assert len(heartbeat_payloads) == 2
    assert heartbeat_payloads[-1]["agent_version"] == "0.2.0"


@pytest.mark.parametrize('checkpoint', [False, True])
def test_terminal_only_publication_obeys_deadline(tmp_path, monkeypatch, checkpoint):
    import threading
    import colab_bridge_agent.jobs as jobs
    from colab_bridge_agent.recipes_impl.common import publish
    release = threading.Event()
    uploaded = threading.Event()
    monkeypatch.setattr(jobs, 'PUBLICATION_DRAIN_SECONDS', .05)
    def terminal_job(job, workspace, emit, cancelled):
        relative = 'checkpoint/checkpoint.json' if checkpoint else 'output.txt'
        path = workspace / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('{}')
        if checkpoint:
            publish(workspace, [relative])
        return {'status': 'succeeded', 'result': {}, 'exit_code': 0, 'error_code': None,
                'artifacts': jobs._artifact_manifest(workspace, [relative])}
    monkeypatch.setattr(jobs, 'execute_job', terminal_job)
    class Slow(RecordingClient):
        def upload_artifact(self, *args):
            uploaded.set()
            release.wait(.5)
            super().upload_artifact(*args)
    client = Slow(job('python', {'code': ''}))
    started = time.monotonic()
    JobRunner(AgentConfig('https://example.test/agent', 'secret', workspace_root=str(tmp_path)), client, 'runtime').run_once()
    elapsed = time.monotonic() - started
    release.set()
    assert elapsed < .2
    assert uploaded.is_set()
    terminal = next(call for call in client.calls if call[0] == 'job_complete')
    assert terminal[1] == 'failed' and terminal[4] == 'ARTIFACT_UPLOAD_FAILED'
    assert terminal[2]['checkpoint_publication'] == {'complete': False}
    time.sleep(.1)
    assert not any(call[0] == 'artifact_complete' for call in client.calls)
    assert len([call for call in client.calls if call[0] == 'prepare']) == 1
