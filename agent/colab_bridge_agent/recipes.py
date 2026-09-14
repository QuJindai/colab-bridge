"""Validated recipe descriptors. SDKs are loaded only in child recipe processes."""
from __future__ import annotations

import math
from pathlib import Path
import sys
from urllib.parse import urlparse
import uuid

from .workspace import resolve_workspace_path
from .recipes_impl.common import RecipeError, atomic_json

KINDS = {'git', 'model_download', 'benchmark', 'lora', 'export', 'drive_export', 'pipeline'}
REPO_HOSTS = frozenset({'github.com', 'gitlab.com', 'huggingface.co', 'cnb.cool'})

SPEC_FIELDS = {
    'git': {'url', 'revision', 'output_dir'},
    'model_download': {'provider', 'model_id', 'revision', 'output_dir', 'allow_patterns'},
    'benchmark': {'model_path', 'adapter_path', 'device', 'dtype', 'cpu_threads', 'prompt', 'max_new_tokens', 'stop_on_eos', 'warmup_runs', 'warmup_tokens'},
    'lora': {'model_path', 'data_path', 'output_dir', 'checkpoint_path', 'device', 'dtype', 'cpu_threads', 'max_steps', 'checkpoint_every', 'rank', 'alpha', 'target_modules', 'learning_rate', 'max_length', 'seed'},
    'export': {'model_path', 'adapter_path', 'format', 'output_path', 'converter_path', 'outtype', 'sample_text', 'cpu_threads'},
    'drive_export': {'mode', 'source_path', 'destination', 'name', 'parent_id'},
    'pipeline': {'steps', 'resume', 'checkpoint_path'},
    'python': {'code', 'env', 'artifacts', 'result_path'},
    'shell': {'command', 'env', 'artifacts', 'result_path'},
    'pip': {'packages', 'env', 'artifacts', 'result_path'},
    'file': {'path', 'text', 'base64', 'source_url', 'sha256'},
}
REQUIRED_FIELDS = {
    'git': {'url', 'revision'}, 'model_download': {'model_id', 'revision'},
    'benchmark': {'model_path'}, 'lora': {'model_path', 'data_path'},
    'export': {'model_path', 'format'}, 'drive_export': {'source_path'},
    'pipeline': {'steps'}, 'python': {'code'}, 'shell': {'command'},
    'pip': {'packages'}, 'file': {'path'},
}


def validate_repo_url(url: str) -> str:
    parsed = urlparse(url)
    if (parsed.scheme != 'https' or parsed.hostname not in REPO_HOSTS or parsed.username
            or parsed.password or parsed.port not in (None, 443) or parsed.query or parsed.fragment
            or not parsed.path.strip('/')):
        raise ValueError('repository must use credential-free HTTPS on an allowlisted host')
    return url


def validate_export(architecture: str, format: str) -> None:
    if format not in {'onnx', 'gguf'}:
        raise RecipeError('UNSUPPORTED_FORMAT', 'supported export formats: onnx, gguf')
    supported = {'onnx': {'gpt2', 'llama'}, 'gguf': {'llama', 'gpt2'}}
    if architecture not in supported[format]:
        raise RecipeError('UNSUPPORTED_ARCHITECTURE', 'architecture is not supported by this export adapter')


def benchmark_metrics(*, first_token_seconds: float, total_seconds: float, generated_tokens: int) -> dict:
    if first_token_seconds < 0 or total_seconds < first_token_seconds or generated_tokens < 1:
        raise ValueError('invalid benchmark measurements')
    decode = total_seconds - first_token_seconds
    return {'first_token_seconds': first_token_seconds, 'total_seconds': total_seconds,
            'generated_tokens': generated_tokens,
            'decode_tokens_per_second': (generated_tokens - 1) / decode if generated_tokens > 1 and decode > 0 else None,
            'overall_tokens_per_second': generated_tokens / total_seconds if total_seconds > 0 else None}


def validate_spec(kind: str, spec: dict, workspace: Path) -> None:
    if not isinstance(spec, dict):
        raise ValueError('spec must be an object')
    if kind not in SPEC_FIELDS or set(spec) - SPEC_FIELDS[kind] or REQUIRED_FIELDS[kind] - set(spec):
        raise ValueError('unsupported, missing, or credential-bearing recipe fields')
    for key, low, high in [('warmup_runs', 1, 100), ('warmup_tokens', 1, 4096), ('max_new_tokens', 1, 4096), ('max_steps', 1, 100000), ('checkpoint_every', 1, 100000), ('rank', 1, 256), ('max_length', 2, 65536), ('cpu_threads', 1, 64), ('seed', 0, 2**32 - 1)]:
        if key in spec and (type(spec[key]) is not int or not low <= spec[key] <= high):
            raise ValueError(key + ' is outside its allowed integer range')
    for key in ('alpha', 'learning_rate'):
        if key in spec and (type(spec[key]) not in (int, float) or not math.isfinite(spec[key]) or spec[key] <= 0):
            raise ValueError(key + ' must be finite and positive')
    if 'target_modules' in spec and (not isinstance(spec['target_modules'], list) or not spec['target_modules'] or not all(isinstance(x, str) and x for x in spec['target_modules'])):
        raise ValueError('target_modules must be a non-empty string list')
    if 'stop_on_eos' in spec and not isinstance(spec['stop_on_eos'], bool):
        raise ValueError('stop_on_eos must be boolean')
    for key in ('model_path', 'output_dir', 'output_path', 'data_path', 'checkpoint_path', 'adapter_path', 'source_path'):
        if key in spec:
            resolve_workspace_path(workspace, spec[key])
    if kind == 'git':
        validate_repo_url(spec['url'])
        if not isinstance(spec.get('revision'), str) or not spec['revision'] or spec['revision'].startswith('-'):
            raise ValueError('git requires a revision')
    if kind == 'pipeline':
        steps = spec.get('steps')
        if not isinstance(steps, list) or not 1 <= len(steps) <= 100:
            raise ValueError('pipeline requires 1..100 steps')
        ids = set()
        for step in steps:
            if not isinstance(step, dict) or not isinstance(step.get('id'), str) or step['id'] in ids:
                raise ValueError('pipeline step ids must be unique strings')
            ids.add(step['id'])
            if step.get('kind') == 'pipeline':
                raise ValueError('nested pipelines are not supported')
            validate_spec(step.get('kind'), step.get('spec'), workspace)
            if set(step) - {'id', 'kind', 'spec', 'inputs'} or not isinstance(step.get('inputs', []), list):
                raise ValueError('pipeline step supports id, kind, spec and inputs:list[str]')
            for path in step.get('inputs', []):
                resolve_workspace_path(workspace, path)
        if not isinstance(spec.get('resume', False), bool):
            raise ValueError('resume must be boolean')
        if 'checkpoint_path' in spec and spec.get('resume') is not True:
            raise ValueError('checkpoint_path requires explicit resume=true')
    if kind not in KINDS | {'python', 'shell', 'pip', 'file'}:
        raise ValueError('unsupported recipe kind')


def build_recipe(job: dict, workspace: str | Path) -> dict:
    workspace = Path(workspace).resolve()
    kind, spec = job.get('kind'), job.get('spec')
    validate_spec(kind, spec, workspace)
    if kind == "pipeline" and spec.get("resume") and not spec.get("checkpoint_path") and (job.get("parent_job_id") or job.get("attempt", 1) > 1 or job.get("restore_artifacts")):
        raise RecipeError("CHECKPOINT_INVALID", "retry/resume requires an explicit published checkpoint_path; no code was replayed")
    if kind in {'python', 'shell', 'pip'}:
        from .jobs import _builtin_recipe
        return _builtin_recipe(job, workspace)
    run_id = uuid.uuid4().hex
    folder = '.colab-bridge/runs/' + run_id
    request = resolve_workspace_path(workspace, folder + '/request.json', create_parent=True)
    result = folder + '/result.json'
    atomic_json(request, {'kind': kind, 'spec': spec, 'workspace': str(workspace), 'result_path': result})
    launcher = resolve_workspace_path(workspace, folder + '/launch.py')
    package_root = str(Path(__file__).resolve().parent.parent)
    launcher.write_text('import sys\nsys.path.insert(0, ' + repr(package_root) + ')\nfrom colab_bridge_agent.recipes_impl.launcher import main\nmain()\n')
    return {'argv': [sys.executable, '-u', str(launcher), str(request)], 'cwd': str(workspace),
            'env': {}, 'artifacts': [result], 'result_path': result}
