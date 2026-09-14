from __future__ import annotations

from dataclasses import dataclass
import os
import uuid


@dataclass(frozen=True)
class AgentConfig:
    agent_url: str
    agent_key: str
    label: str = "colab-runtime"
    heartbeat_seconds: int = 20
    runtime_id: str | None = None
    execution_enabled: bool = False
    workspace_root: str = "/content/colab-bridge"
    job_poll_seconds: float = 2.0

    def __post_init__(self) -> None:
        if self.runtime_id is not None:
            try:
                uuid.UUID(self.runtime_id)
            except (ValueError, AttributeError) as error:
                raise ValueError("runtime_id must be a UUID") from error
        if self.heartbeat_seconds < 1:
            raise ValueError("heartbeat_seconds must be positive")
        if self.job_poll_seconds <= 0:
            raise ValueError("job_poll_seconds must be positive")

    @classmethod
    def from_env(cls) -> "AgentConfig":
        return cls(
            agent_url=os.environ["COLAB_BRIDGE_AGENT_URL"].rstrip("/"),
            agent_key=os.environ["COLAB_BRIDGE_AGENT_KEY"],
            label=os.environ.get("COLAB_BRIDGE_LABEL", "colab-runtime"),
            heartbeat_seconds=int(os.environ.get("COLAB_BRIDGE_HEARTBEAT_SECONDS", "20")),
            runtime_id=os.environ.get("COLAB_BRIDGE_RUNTIME_ID") or None,
            execution_enabled=os.environ.get("COLAB_BRIDGE_EXECUTION_ENABLED") == "1",
            workspace_root=os.environ.get("COLAB_BRIDGE_WORKSPACE_ROOT", "/content/colab-bridge"),
            job_poll_seconds=float(os.environ.get("COLAB_BRIDGE_JOB_POLL_SECONDS", "2")),
        )
