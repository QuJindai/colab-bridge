from __future__ import annotations

from datetime import datetime, timezone


def classify_runtime_age(age_seconds: float) -> str:
    if age_seconds <= 60:
        return "live"
    if age_seconds <= 300:
        return "stale"
    return "offline"


def runtime_status_from_heartbeat(last_heartbeat: str, *, now: datetime | None = None) -> dict:
    current = now or datetime.now(timezone.utc)
    heartbeat = datetime.fromisoformat(last_heartbeat.replace("Z", "+00:00"))
    age = max(0.0, (current - heartbeat).total_seconds())
    return {"status": classify_runtime_age(age), "age_seconds": age}
