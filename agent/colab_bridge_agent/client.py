from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlparse

import httpx


class PayloadTooLarge(ValueError):
    pass


class AgentClient:
    _MAX_STORAGE_REDIRECTS = 5

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

    def job_claim(self, runtime_id: str) -> dict[str, Any]:
        return self._post({"op": "job_claim", "runtime_id": runtime_id})

    def job_heartbeat(self, runtime_id: str, job_id: str, lease_token: str) -> dict[str, Any]:
        return self._post({
            "op": "job_heartbeat",
            "runtime_id": runtime_id,
            "job_id": job_id,
            "lease_token": lease_token,
        })

    def job_log(
        self,
        runtime_id: str,
        job_id: str,
        lease_token: str,
        seq: int,
        stream: str,
        text: str,
    ) -> dict[str, Any]:
        return self._post({
            "op": "job_log",
            "runtime_id": runtime_id,
            "job_id": job_id,
            "lease_token": lease_token,
            "seq": seq,
            "stream": stream,
            "text": text,
        })

    def job_complete(
        self,
        runtime_id: str,
        job_id: str,
        lease_token: str,
        status: str,
        result: dict[str, Any] | None,
        exit_code: int | None,
        error_code: str | None,
    ) -> dict[str, Any]:
        return self._post({
            "op": "job_complete",
            "runtime_id": runtime_id,
            "job_id": job_id,
            "lease_token": lease_token,
            "status": status,
            "result": result,
            "exit_code": exit_code,
            "error_code": error_code,
        })

    def artifact_prepare(
        self,
        runtime_id: str,
        job_id: str,
        lease_token: str,
        *,
        path: str,
        bytes: int,
        sha256: str,
        mime_type: str,
    ) -> dict[str, Any]:
        return self._post({
            "op": "artifact_prepare",
            "runtime_id": runtime_id,
            "job_id": job_id,
            "lease_token": lease_token,
            "path": path,
            "bytes": bytes,
            "sha256": sha256,
            "mime_type": mime_type,
        })

    def artifact_complete(
        self,
        runtime_id: str,
        job_id: str,
        lease_token: str,
        artifact_id: str,
    ) -> dict[str, Any]:
        return self._post({
            "op": "artifact_complete",
            "runtime_id": runtime_id,
            "job_id": job_id,
            "lease_token": lease_token,
            "artifact_id": artifact_id,
        })

    def _storage_request(self, method: str, url: str, **kwargs: Any) -> httpx.Request:
        parsed = urlparse(url)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError("signed storage URL must be an HTTPS URL without user information")
        timeout = {
            "connect": self.timeout_seconds,
            "read": self.timeout_seconds,
            "write": self.timeout_seconds,
            "pool": self.timeout_seconds,
        }
        return httpx.Request(method, url, extensions={"timeout": timeout}, **kwargs)

    def _download_response(self, download_url: str, *, stream: bool) -> httpx.Response:
        current_url = download_url
        for redirect_count in range(self._MAX_STORAGE_REDIRECTS + 1):
            request = self._storage_request("GET", current_url)
            response = self.http.send(request, auth=None, follow_redirects=False, stream=stream)
            if response.status_code not in {301, 302, 303, 307, 308}:
                return response
            location = response.headers.get("Location")
            response.close()
            if location is None or redirect_count >= self._MAX_STORAGE_REDIRECTS:
                raise httpx.TooManyRedirects("signed storage redirect limit exceeded", request=request)
            current_url = urljoin(current_url, location)
        raise AssertionError("unreachable")

    def upload_artifact(self, upload_url: str, data: bytes | Path, mime_type: str) -> None:
        if isinstance(data, Path):
            with data.open("rb") as handle:
                request = self._storage_request(
                    "PUT", upload_url, content=handle, headers={"Content-Type": mime_type})
                response = self.http.send(request, auth=None)
                response.raise_for_status()
            return
        request = self._storage_request(
            "PUT", upload_url, content=data, headers={"Content-Type": mime_type})
        response = self.http.send(request, auth=None)
        response.raise_for_status()

    def download_artifact(self, download_url: str) -> bytes:
        response = self._download_response(download_url, stream=False)
        try:
            response.raise_for_status()
            return response.content
        finally:
            response.close()

    def download_artifact_to(self, download_url: str, destination: Path) -> None:
        temporary = destination.with_name(destination.name + ".part")
        try:
            response = self._download_response(download_url, stream=True)
            try:
                response.raise_for_status()
                flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0)
                descriptor = os.open(temporary, flags, 0o600)
                with os.fdopen(descriptor, "wb") as handle:
                    for chunk in response.iter_bytes():
                        handle.write(chunk)
            finally:
                response.close()
            temporary.replace(destination)
        finally:
            temporary.unlink(missing_ok=True)
