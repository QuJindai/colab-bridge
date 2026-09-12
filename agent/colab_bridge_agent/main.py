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
    import time
    import uuid

    from .client import AgentClient
    from .probes import collect_gpu_snapshot, collect_process_snapshot, collect_runtime_snapshot

    active_client = client or AgentClient(config.agent_url, config.agent_key)
    active_probes = probes or {
        "refresh_gpu": collect_gpu_snapshot,
        "refresh_runtime": collect_runtime_snapshot,
        "refresh_processes": collect_process_snapshot,
    }
    runtime_id = str(uuid.uuid4())
    runtime_payload = active_probes["refresh_runtime"]()
    active_client.register(runtime_id, config.label, runtime_payload)

    cycles = 0
    while True:
        if stop_event is not None and stop_event.is_set():
            break

        runtime_payload = active_probes["refresh_runtime"]()
        gpu_payload = active_probes["refresh_gpu"]()
        processes_payload = active_probes["refresh_processes"]()
        active_client.snapshot(runtime_id, "runtime", runtime_payload)
        active_client.snapshot(runtime_id, "gpu", gpu_payload)
        active_client.snapshot(runtime_id, "processes", processes_payload)
        active_client.heartbeat(
            runtime_id,
            {
                "accelerator": gpu_payload.get("accelerator", "unknown"),
                "telemetry_available": gpu_payload.get("telemetry_available", True),
            },
        )

        poll_response = active_client.poll(runtime_id)
        for command in poll_response.get("commands", []):
            outcome = execute_command(command, probes=active_probes)
            active_client.result(
                runtime_id,
                outcome["command_id"],
                outcome["status"],
                outcome["payload"],
                outcome["error_code"],
            )

        cycles += 1
        if max_cycles is not None and cycles >= max_cycles:
            break
        time.sleep(config.heartbeat_seconds)

    return runtime_id
