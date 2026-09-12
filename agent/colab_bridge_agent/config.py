from __future__ import annotations

from dataclasses import dataclass
import os


@dataclass(frozen=True)
class AgentConfig:
    agent_url: str
    agent_key: str
    label: str = "colab-runtime"
    heartbeat_seconds: int = 20

    @classmethod
    def from_env(cls) -> "AgentConfig":
        return cls(
            agent_url=os.environ["COLAB_BRIDGE_AGENT_URL"].rstrip("/"),
            agent_key=os.environ["COLAB_BRIDGE_AGENT_KEY"],
            label=os.environ.get("COLAB_BRIDGE_LABEL", "colab-runtime"),
            heartbeat_seconds=int(os.environ.get("COLAB_BRIDGE_HEARTBEAT_SECONDS", "20")),
        )
