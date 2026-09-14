from __future__ import annotations

import json
from pathlib import Path
import sys

from ..workspace import resolve_workspace_path
from .common import RecipeError, atomic_json


def dispatch(kind: str, spec: dict, workspace: Path) -> dict:
    if kind == 'git':
        from .repository import checkout
        return checkout(spec, workspace)
    if kind == 'model_download':
        from .repository import download
        return download(spec, workspace)
    if kind == 'benchmark':
        from .models import benchmark
        return benchmark(spec, workspace)
    if kind == 'lora':
        from .models import lora
        return lora(spec, workspace)
    if kind == 'export':
        from .exports import export_model
        return export_model(spec, workspace)
    if kind == 'drive_export':
        from .drive import export_drive
        return export_drive(spec, workspace)
    if kind == 'pipeline':
        from .pipeline import run_pipeline
        return run_pipeline(spec, workspace)
    if kind == 'file':
        import time
        from ..jobs import _stage_file
        outcome = _stage_file(spec, workspace, time.monotonic() + 3600, lambda: False)
        return {**outcome['result'], 'artifacts': [spec['path']]}
    raise ValueError('unsupported recipe kind')


def main() -> None:
    request = json.loads(Path(sys.argv[1]).read_text())
    workspace = Path(request['workspace'])
    result_path = resolve_workspace_path(workspace, request['result_path'])
    try:
        result = dispatch(request['kind'], request['spec'], workspace)
        atomic_json(result_path, result)
    except Exception as error:
        if isinstance(error, RecipeError):
            code, message = error.code, str(error)
        elif isinstance(error, (ImportError, ModuleNotFoundError)):
            code, message = 'MISSING_DEPENDENCY', 'install the optional recipe dependencies in the Agent Python environment'
        elif isinstance(error, MemoryError) or 'out of memory' in str(error).lower():
            code, message = 'OUT_OF_MEMORY', 'model operation exhausted available memory'
        else:
            # External SDK exceptions can contain URLs or credentials; never serialize them.
            code, message = 'RECIPE_FAILED', 'recipe operation failed (' + type(error).__name__ + ')'
        atomic_json(result_path, {'error': {'code': code, 'message': message}})
        print(json.dumps({'error_code': code, 'message': message}), file=sys.stderr, flush=True)
        raise SystemExit(1)
