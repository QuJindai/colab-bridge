from __future__ import annotations

import json
from pathlib import Path
import shutil
import subprocess
import time
import uuid

from ..workspace import resolve_workspace_path
from .common import RecipeError, atomic_json, files, fingerprint, publish, sha256


def run_pipeline(spec: dict, workspace: Path) -> dict:
    from .launcher import dispatch
    from ..jobs import _builtin_recipe, _validate_recipe, _artifact_manifest, _stage_file
    steps = spec['steps']
    definition = fingerprint(steps)
    completed, saved_paths = [], set()
    checkpoint_path = spec.get('checkpoint_path')
    if checkpoint_path:
        try:
            state = json.loads(resolve_workspace_path(workspace, checkpoint_path).read_text())
            if state['version'] != 1 or state['definition_sha256'] != definition:
                raise ValueError('definition mismatch')
            completed = state['completed']
            if not isinstance(completed, list) or not 1 <= len(completed) <= len(steps):
                raise ValueError('invalid completed steps')
            if [item['id'] for item in completed] != [step['id'] for step in steps[:len(completed)]]:
                raise ValueError('invalid completed step order')
            # Validate every hash before restoring anything.
            for entry in state['files']:
                source = resolve_workspace_path(workspace, entry['snapshot'])
                resolve_workspace_path(workspace, entry['path'])
                if source.is_symlink() or sha256(source) != entry['sha256']:
                    raise ValueError('checkpoint integrity mismatch')
            for entry in state['files']:
                source = resolve_workspace_path(workspace, entry['snapshot'])
                destination = resolve_workspace_path(workspace, entry['path'], create_parent=True)
                shutil.copyfile(source, destination)
                saved_paths.add(entry['path'])
            completed = [{**item, 'resumed': True} for item in completed]
        except (OSError, ValueError, TypeError, KeyError) as error:
            raise RecipeError('CHECKPOINT_INVALID', 'pipeline checkpoint missing, invalid, or incompatible') from error
    if checkpoint_path and len(completed) == len(steps):
        closure = [checkpoint_path] + [entry['snapshot'] for entry in state['files']]
        publish(workspace, closure)
        saved_paths.update(closure)
    run_id = uuid.uuid4().hex
    latest = checkpoint_path
    for index, step in enumerate(steps[len(completed):], start=len(completed)):
        kind, child_spec = step['kind'], step['spec']
        # Explicit inputs are snapshotted, including arbitrary-code inputs unknown to adapters.
        input_paths = list(step.get('inputs', []))
        for key in ('model_path', 'data_path', 'adapter_path', 'source_path', 'checkpoint_path'):
            if key in child_spec:
                input_paths.append(child_spec[key])
        inputs = files(workspace, input_paths)
        if kind in {'python', 'shell', 'pip'}:
            descriptor = _builtin_recipe(step, workspace)
            argv, cwd, env = _validate_recipe(descriptor, workspace)
            # Inherit the outer process group so worker timeout kills the entire pipeline.
            process = subprocess.run(argv, cwd=cwd, env=env, check=False)
            if process.returncode:
                raise RecipeError('PIPELINE_STEP_FAILED', 'pipeline step failed: ' + step['id'])
            _artifact_manifest(workspace, descriptor.get('artifacts', []))
            value = None
            if descriptor.get('result_path'):
                value = json.loads(resolve_workspace_path(workspace, descriptor['result_path']).read_text())
                if not isinstance(value, dict):
                    raise RecipeError('OUTPUT_INVALID', 'step result must be a JSON object')
            outcome = {'result': value, 'artifacts': descriptor.get('artifacts', [])}
        elif kind == 'file':
            staged = _stage_file(child_spec, workspace, time.monotonic() + 3600, lambda: False)
            outcome = {**staged['result'], 'artifacts': [child_spec['path']]}
        else:
            outcome = dispatch(kind, child_spec, workspace)
        paths = files(workspace, outcome.get('artifacts', []))
        saved_paths.update(inputs + paths)
        completed.append({'id': step['id'], 'kind': kind, 'result': outcome, 'resumed': False})
        folder = f'.colab-bridge/checkpoints/pipeline-{run_id}/step-{index + 1:04d}'
        entries = []
        for relative in sorted(saved_paths):
            source = resolve_workspace_path(workspace, relative)
            snapshot = folder + '/files/' + relative
            destination = resolve_workspace_path(workspace, snapshot, create_parent=True)
            shutil.copyfile(source, destination)
            entries.append({'path': relative, 'snapshot': snapshot, 'sha256': sha256(destination)})
        latest = folder + '/checkpoint.json'
        atomic_json(resolve_workspace_path(workspace, latest, create_parent=True),
                    {'version': 1, 'definition_sha256': definition, 'completed': completed, 'files': entries})
        publish(workspace, [folder])
        print(json.dumps({'event': 'pipeline_checkpoint', 'step': step['id'], 'checkpoint_path': latest}), flush=True)
    return {'steps': completed, 'checkpoint_path': latest, 'artifacts': sorted(saved_paths)}
