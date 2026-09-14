from __future__ import annotations

from typing import Callable


ALLOWED_COMMANDS = {"refresh_gpu", "refresh_runtime", "refresh_processes"}


def execute_command(command: dict, *, probes: dict[str, Callable[[], dict]]) -> dict:
    command_id = str(command.get("id", ""))
    command_type = command.get("command_type")
    if command_type not in ALLOWED_COMMANDS or command_type not in probes:
        return {
            "command_id": command_id,
            "status": "rejected",
            "error_code": "UNKNOWN_COMMAND",
            "payload": None,
        }
    try:
        payload = probes[command_type]()
    except Exception:
        return {
            "command_id": command_id,
            "status": "failed",
            "error_code": "TELEMETRY_UNAVAILABLE",
            "payload": None,
        }
    return {
        "command_id": command_id,
        "status": "completed",
        "error_code": None,
        "payload": payload,
    }


def run_agent(
    config,
    *,
    client=None,
    stop_event=None,
    max_cycles: int | None = None,
    probes: dict[str, Callable[[], dict]] | None = None,
) -> str:
    import threading
    import time
    import uuid

    from . import __version__
    from .client import AgentClient
    from .jobs import JobRunner
    from .probes import collect_gpu_snapshot, collect_process_snapshot, collect_runtime_snapshot

    active_client = client or AgentClient(config.agent_url, config.agent_key)
    active_probes = probes or {
        "refresh_gpu": collect_gpu_snapshot,
        "refresh_runtime": collect_runtime_snapshot,
        "refresh_processes": collect_process_snapshot,
    }
    runtime_id = config.runtime_id or str(uuid.uuid4())

    def safe_probe(kind: str) -> dict:
        try:
            value = active_probes[kind]()
            return value if isinstance(value, dict) else {"telemetry_available": False}
        except Exception:
            return {"telemetry_available": False, "error_code": "TELEMETRY_UNAVAILABLE"}

    def agent_metadata(payload: dict) -> dict:
        return {
            **payload,
            "agent_version": __version__,
            "execution_enabled": config.execution_enabled,
        }

    registered = False

    def try_register() -> None:
        nonlocal registered
        if registered:
            return
        try:
            response = active_client.register(
                runtime_id,
                config.label,
                agent_metadata(safe_probe("refresh_runtime")),
            )
            registered = response.get("ok") is True
        except Exception:
            pass

    try_register()
    worker_stop = threading.Event()
    worker = None
    if config.execution_enabled:
        worker = threading.Thread(
            target=JobRunner(config, active_client, runtime_id, worker_stop).run_forever,
            name="colab-job-runner",
            daemon=True,
        )
        worker.start()

    cycles = 0
    while True:
        if stop_event is not None and stop_event.is_set():
            break

        try_register()
        runtime_payload = safe_probe("refresh_runtime")
        gpu_payload = safe_probe("refresh_gpu")
        processes_payload = safe_probe("refresh_processes")
        for kind, payload in (
            ("runtime", runtime_payload),
            ("gpu", gpu_payload),
            ("processes", processes_payload),
        ):
            try:
                active_client.snapshot(runtime_id, kind, payload)
            except Exception:
                pass
        try:
            active_client.heartbeat(
                runtime_id,
                agent_metadata({
                    "accelerator": gpu_payload.get("accelerator", "unknown"),
                    "telemetry_available": gpu_payload.get("telemetry_available", True),
                }),
            )
        except Exception:
            pass

        try:
            poll_response = active_client.poll(runtime_id)
        except Exception:
            poll_response = {"commands": []}
        commands = poll_response.get("commands", []) if isinstance(poll_response, dict) else []
        if not isinstance(commands, list):
            commands = []
        for command in commands:
            outcome = execute_command(command, probes=active_probes)
            try:
                active_client.result(
                    runtime_id,
                    outcome["command_id"],
                    outcome["status"],
                    outcome["payload"],
                    outcome["error_code"],
                )
            except Exception:
                pass

        cycles += 1
        if max_cycles is not None and cycles >= max_cycles:
            break
        if stop_event is not None:
            stop_event.wait(config.heartbeat_seconds)
        else:
            time.sleep(config.heartbeat_seconds)

    worker_stop.set()
    if worker is not None:
        worker.join(timeout=config.job_poll_seconds + 1)
    return runtime_id
