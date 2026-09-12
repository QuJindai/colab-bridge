from datetime import datetime, timezone, timedelta

from colab_bridge_agent.models import classify_runtime_age, runtime_status_from_heartbeat


def test_classify_runtime_age_live_through_60_seconds():
    assert classify_runtime_age(0) == "live"
    assert classify_runtime_age(60) == "live"


def test_classify_runtime_age_stale_after_60_through_300_seconds():
    assert classify_runtime_age(60.001) == "stale"
    assert classify_runtime_age(300) == "stale"


def test_classify_runtime_age_offline_after_300_seconds():
    assert classify_runtime_age(300.001) == "offline"


def test_runtime_status_from_heartbeat_returns_age_and_status():
    now = datetime(2026, 9, 12, 10, 0, 0, tzinfo=timezone.utc)
    heartbeat = now - timedelta(seconds=42)
    result = runtime_status_from_heartbeat(heartbeat.isoformat(), now=now)
    assert result == {"status": "live", "age_seconds": 42.0}
