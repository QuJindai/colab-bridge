from __future__ import annotations

import hashlib
import json
from pathlib import Path
import uuid

from ..workspace import resolve_workspace_path


class RecipeError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def atomic_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    temporary.write_text(json.dumps(value, sort_keys=True, allow_nan=False), encoding='utf-8')
    temporary.replace(path)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def files(workspace: Path, paths: list[str]) -> list[str]:
    found = set()
    for relative in paths:
        target = resolve_workspace_path(workspace, relative)
        if target.is_symlink() or not target.exists():
            raise ValueError('output missing or symlinked')
        for path in sorted(target.rglob('*')) if target.is_dir() else [target]:
            checked = resolve_workspace_path(workspace, str(path.relative_to(workspace)))
            if checked.is_symlink():
                raise ValueError('symlinked outputs are not supported')
            if checked.is_file():
                found.add(str(checked.relative_to(workspace)))
    return sorted(found)


def publish(workspace: Path, paths: list[str]) -> None:
    immutable = files(workspace, paths)
    if len(immutable) > 10000:
        raise RecipeError('CHECKPOINT_TOO_LARGE', 'checkpoint has too many files')
    atomic_json(resolve_workspace_path(workspace, '.colab-bridge/publish/' + uuid.uuid4().hex + '.json', create_parent=True),
                {'version': 1, 'artifacts': immutable})


def fingerprint(value) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def model_identity(workspace: Path, relative: str) -> dict:
    paths = files(workspace, [relative])
    # Full content fingerprint makes local fixture and resumed model provenance explicit.
    entries = {str(Path(path).relative_to(relative)): sha256(workspace / path) for path in paths}
    config = resolve_workspace_path(workspace, relative + '/config.json')
    metadata = json.loads(config.read_text()) if config.exists() else {}
    revision_file = resolve_workspace_path(workspace, relative + '/.colab-bridge-revision.json')
    revision = json.loads(revision_file.read_text()).get('resolved_revision') if revision_file.exists() else metadata.get('_commit_hash')
    return {'model_path': relative, 'resolved_revision': revision,
            'content_sha256': fingerprint(entries)}
