from __future__ import annotations

import os
from pathlib import Path
import re
from typing import Mapping


_SAFE_COMPONENT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_SENSITIVE_NAME = re.compile(
    r"(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|AUTH|DATABASE_URL|DSN)",
    re.IGNORECASE,
)


def is_sensitive_environment_name(name: str) -> bool:
    return bool(_SENSITIVE_NAME.search(name))


def filter_child_environment(
    source: Mapping[str, str] | None = None,
    overrides: Mapping[str, str] | None = None,
) -> dict[str, str]:
    environment = {
        str(name): str(value)
        for name, value in (source if source is not None else os.environ).items()
        if not is_sensitive_environment_name(str(name))
    }
    for name, value in (overrides or {}).items():
        if not isinstance(name, str) or not isinstance(value, str):
            raise ValueError("environment overrides must contain strings")
        if is_sensitive_environment_name(name):
            raise ValueError(f"sensitive environment override is not allowed: {name}")
        environment[name] = value
    environment["PYTHONUNBUFFERED"] = "1"
    return environment


def secret_values(source: Mapping[str, str] | None = None) -> tuple[str, ...]:
    values = {
        str(value)
        for name, value in (source if source is not None else os.environ).items()
        if is_sensitive_environment_name(str(name)) and len(str(value)) >= 4
    }
    return tuple(sorted(values, key=len, reverse=True))


def resolve_workspace_path(
    workspace: str | Path,
    relative_path: str,
    *,
    create_parent: bool = False,
) -> Path:
    if (
        not isinstance(relative_path, str)
        or not relative_path
        or "\0" in relative_path
        or "\\" in relative_path
        or Path(relative_path).is_absolute()
    ):
        raise ValueError("workspace path must be a non-empty relative POSIX path")
    if any(part in {"", ".", ".."} for part in relative_path.split("/")):
        raise ValueError("workspace path contains an unsafe component")
    root = Path(workspace).resolve()
    candidate = root.joinpath(*relative_path.split("/"))
    resolved = candidate.resolve(strict=False)
    if not resolved.is_relative_to(root):
        raise ValueError("workspace path escapes the workspace")
    if create_parent:
        candidate.parent.mkdir(parents=True, exist_ok=True)
        if candidate.resolve(strict=False) != resolved:
            raise ValueError("workspace path changed while resolving")
    return candidate


def create_job_workspace(root: str | Path, project: str, job_id: str) -> Path:
    if not isinstance(project, str) or not _SAFE_COMPONENT.fullmatch(project) or project in {".", ".."}:
        raise ValueError("project must be a safe slug")
    if not isinstance(job_id, str) or not _SAFE_COMPONENT.fullmatch(job_id) or job_id in {".", ".."}:
        raise ValueError("job id is not safe for a workspace path")
    workspace = Path(root).expanduser().resolve() / project / job_id
    workspace.mkdir(parents=True, exist_ok=True)
    return workspace
