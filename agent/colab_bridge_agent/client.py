from __future__ import annotations

import json
from typing import Any

import httpx


class PayloadTooLarge(ValueError):
    pass


class AgentClient:
    def __init__(
        self,
        agent_url: str,
        agent_key: str,
        *,
        http_client: httpx.Client | None = None,
        max_payload_bytes: int = 256 * 1024,
        timeout_seconds: float = 10.0,
    ) -> None:
        self.agent_url = agent_url.rstrip("/")
        self.agent_key = agent_key
        self.http = http_client or httpx.Client()
        self.max_payload_bytes = max_payload_bytes
        self.timeout_seconds = timeout_seconds

    def _post(self, body: dict[str, Any]) -> dict[str, Any]:
        encoded = json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        if len(encoded) > self.max_payload_bytes:
            raise PayloadTooLarge(f"payload exceeds {self.max_payload_bytes} bytes")
        response = self.http.post(
            self.agent_url,
            content=encoded,
            headers={
                "Content-Type": "application/json",
                "X-Colab-Agent-Key": self.agent_key,
            },
            timeout=self.timeout_seconds,
        )
        response.raise_for_status()
        value = response.json()
        if not isinstance(value, dict):
            raise ValueError("agent API returned non-object JSON")
        return value

    def heartbeat(self, runtime_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        return self._post({"op": "heartbeat", "runtime_id": runtime_id, "payload": payload})

    def snapshot(self, runtime_id: str, kind: str, payload: dict[str, Any]) -> dict[str, Any]:
        return self._post({"op": "snapshot", "runtime_id": runtime_id, "kind": kind, "payload": payload})

    def register(self, runtime_id: str, label: str, payload: dict[str, Any]) -> dict[str, Any]:
        return self._post({"op": "register", "runtime_id": runtime_id, "label": label, "payload": payload})

    def poll(self, runtime_id: str) -> dict[str, Any]:
        return self._post({"op": "poll", "runtime_id": runtime_id})

    def result(
        self,
        runtime_id: str,
        command_id: str,
        status: str,
        payload: dict[str, Any] | None,
        error_code: str | None,
    ) -> dict[str, Any]:
        return self._post({
            "op": "result",
            "runtime_id": runtime_id,
            "command_id": command_id,
            "status": status,
            "payload": payload,
            "error_code": error_code,
        })
