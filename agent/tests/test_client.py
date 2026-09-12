import json

import httpx
import pytest

from colab_bridge_agent.config import AgentConfig
from colab_bridge_agent.client import AgentClient, PayloadTooLarge
from colab_bridge_agent.main import execute_command


def test_agent_config_reads_required_environment(monkeypatch):
    monkeypatch.setenv("COLAB_BRIDGE_AGENT_URL", "https://example.test/agent")
    monkeypatch.setenv("COLAB_BRIDGE_AGENT_KEY", "agent-secret")
    monkeypatch.setenv("COLAB_BRIDGE_LABEL", "gpu-lab")
    cfg = AgentConfig.from_env()
    assert cfg.agent_url == "https://example.test/agent"
    assert cfg.agent_key == "agent-secret"
    assert cfg.label == "gpu-lab"
    assert cfg.heartbeat_seconds == 20


def test_client_sends_agent_key_and_operation_payload():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["headers"] = request.headers
        seen["json"] = json.loads(request.content)
        return httpx.Response(200, json={"ok": True})

    transport = httpx.MockTransport(handler)
    client = AgentClient(
        "https://example.test/agent",
        "agent-secret",
        http_client=httpx.Client(transport=transport),
    )
    response = client.heartbeat("runtime-1", {"accelerator": "cpu"})
    assert response == {"ok": True}
    assert seen["headers"]["X-Colab-Agent-Key"] == "agent-secret"
    assert seen["json"] == {
        "op": "heartbeat",
        "runtime_id": "runtime-1",
        "payload": {"accelerator": "cpu"},
    }


def test_client_rejects_oversized_payload_before_network_call():
    called = False

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal called
        called = True
        return httpx.Response(200, json={"ok": True})

    client = AgentClient(
        "https://example.test/agent",
        "agent-secret",
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
        max_payload_bytes=128,
    )
    with pytest.raises(PayloadTooLarge):
        client.snapshot("runtime-1", "gpu", {"blob": "x" * 1000})
    assert called is False


def test_execute_command_rejects_unknown_command_without_calling_probes():
    called = []

    def probe():
        called.append(True)
        return {"ok": True}

    result = execute_command(
        {"id": "cmd-1", "command_type": "shell", "payload": {"cmd": "whoami"}},
        probes={
            "refresh_gpu": probe,
            "refresh_runtime": probe,
            "refresh_processes": probe,
        },
    )
    assert result == {
        "command_id": "cmd-1",
        "status": "rejected",
        "error_code": "UNKNOWN_COMMAND",
        "payload": None,
    }
    assert called == []


def test_execute_command_dispatches_only_allowlisted_probe():
    result = execute_command(
        {"id": "cmd-2", "command_type": "refresh_gpu", "payload": {}},
        probes={
            "refresh_gpu": lambda: {"gpus": [{"name": "NVIDIA L4"}]},
            "refresh_runtime": lambda: {"runtime": True},
            "refresh_processes": lambda: {"processes": []},
        },
    )
    assert result == {
        "command_id": "cmd-2",
        "status": "completed",
        "error_code": None,
        "payload": {"gpus": [{"name": "NVIDIA L4"}]},
    }


def test_client_register_poll_and_result_have_fixed_shapes():
    bodies = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        bodies.append(body)
        if body["op"] == "poll":
            return httpx.Response(200, json={"ok": True, "commands": []})
        return httpx.Response(200, json={"ok": True})

    client = AgentClient(
        "https://example.test/agent",
        "agent-secret",
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
    )
    client.register("runtime-1", "gpu-lab", {"python_version": "3.12"})
    assert client.poll("runtime-1") == {"ok": True, "commands": []}
    client.result("runtime-1", "cmd-1", "completed", {"gpus": []}, None)
    assert bodies == [
        {
            "op": "register",
            "runtime_id": "runtime-1",
            "label": "gpu-lab",
            "payload": {"python_version": "3.12"},
        },
        {"op": "poll", "runtime_id": "runtime-1"},
        {
            "op": "result",
            "runtime_id": "runtime-1",
            "command_id": "cmd-1",
            "status": "completed",
            "payload": {"gpus": []},
            "error_code": None,
        },
    ]


def test_run_agent_executes_one_complete_cycle(monkeypatch):
    from colab_bridge_agent.main import run_agent

    events = []

    class FakeClient:
        def register(self, runtime_id, label, payload):
            events.append(("register", runtime_id, label, payload))
            return {"ok": True}

        def snapshot(self, runtime_id, kind, payload):
            events.append(("snapshot", runtime_id, kind, payload))
            return {"ok": True}

        def heartbeat(self, runtime_id, payload):
            events.append(("heartbeat", runtime_id, payload))
            return {"ok": True}

        def poll(self, runtime_id):
            events.append(("poll", runtime_id))
            return {"ok": True, "commands": [{"id": "cmd-1", "command_type": "refresh_gpu", "payload": {}}]}

        def result(self, runtime_id, command_id, status, payload, error_code):
            events.append(("result", runtime_id, command_id, status, payload, error_code))
            return {"ok": True}

    cfg = AgentConfig("https://example.test/agent", "secret", label="test", heartbeat_seconds=20)
    runtime_id = run_agent(
        cfg,
        client=FakeClient(),
        max_cycles=1,
        probes={
            "refresh_gpu": lambda: {"accelerator": "nvidia_gpu", "gpus": [{"name": "L4"}]},
            "refresh_runtime": lambda: {"python_version": "3.12"},
            "refresh_processes": lambda: {"processes": []},
        },
    )
    assert runtime_id
    kinds = [event[0] for event in events]
    assert kinds == ["register", "snapshot", "snapshot", "snapshot", "heartbeat", "poll", "result"]
    assert events[-1][3] == "completed"
    assert events[-1][4] == {"accelerator": "nvidia_gpu", "gpus": [{"name": "L4"}]}
