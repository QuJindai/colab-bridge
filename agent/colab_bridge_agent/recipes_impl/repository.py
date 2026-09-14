from __future__ import annotations

from pathlib import Path
import subprocess
import re

from ..workspace import resolve_workspace_path
from .common import RecipeError, atomic_json, files, fingerprint, sha256


def checkout(spec: dict, workspace: Path, *, transport=lambda url: url) -> dict:
    from ..recipes import validate_repo_url
    url = validate_repo_url(spec['url'])
    revision = spec['revision']
    if not revision or revision.startswith('-'):
        raise ValueError('revision is required')
    relative = spec.get('output_dir', 'repo')
    output = resolve_workspace_path(workspace, relative, create_parent=True)
    if output.exists():
        raise RecipeError('OUTPUT_EXISTS', 'repository output already exists')
    subprocess.run(['git', '-c', 'credential.helper=', '-c', 'http.followRedirects=false', 'clone', '--no-checkout', '--', transport(url), str(output)], check=True)
    subprocess.run(['git', '-C', str(output), 'checkout', '--detach', revision, '--'], check=True)
    commit = subprocess.check_output(['git', '-C', str(output), 'rev-parse', 'HEAD'], text=True).strip()
    # Do not persist Git internals or hooks. The resolved source tree is the artifact.
    import shutil
    shutil.rmtree(output / '.git')
    result = {'url': url, 'requested_revision': revision, 'resolved_revision': commit, 'output_path': relative, 'artifacts': [relative]}
    atomic_json(output / '.colab-bridge-revision.json', result)
    return result


def download(spec: dict, workspace: Path, *, hf_api=None, hf_download=None, ms_api=None, ms_download=None) -> dict:
    provider = spec.get('provider', 'huggingface')
    model_id, revision = spec['model_id'], spec.get('revision')
    if not isinstance(model_id, str) or not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', model_id):
        raise ValueError('model_id must be owner/name')
    patterns = spec.get('allow_patterns')
    if patterns is not None and (not isinstance(patterns, list) or not patterns or not all(isinstance(p, str) and p for p in patterns)):
        raise ValueError('allow_patterns must be a non-empty string list')
    if not isinstance(revision, str) or not revision:
        raise ValueError('model download requires an explicit revision')
    relative = spec.get('output_dir', 'model')
    output = resolve_workspace_path(workspace, relative, create_parent=True)
    if output.exists():
        raise RecipeError('OUTPUT_EXISTS', 'model download output already exists')
    if provider == 'huggingface':
        if hf_api is None or hf_download is None:
            from huggingface_hub import HfApi, snapshot_download
            hf_api, hf_download = HfApi(token=False), snapshot_download
        commit = hf_api.model_info(model_id, revision=revision).sha
        hf_download(repo_id=model_id, revision=commit, local_dir=str(output), allow_patterns=patterns, token=False, max_workers=1)
    elif provider == 'modelscope':
        if ms_api is None or ms_download is None:
            from modelscope.hub.api import HubApi
            from modelscope import snapshot_download
            ms_api, ms_download = HubApi(), snapshot_download
        if re.fullmatch(r'[a-fA-F0-9]{40}', revision):
            commit = revision.lower()
        else:
            detail = ms_api.get_valid_revision_detail(model_id, revision=revision)
            commit = detail.get('Sha')
            if not commit:
                # Current SDK branch details have no commit hash. Resolve the public Git ref.
                refs = subprocess.check_output(
                    ['git', '-c', 'credential.helper=', '-c', 'http.followRedirects=false', 'ls-remote',
                     'https://www.modelscope.cn/' + model_id + '.git', 'refs/heads/' + revision,
                     'refs/tags/' + revision, 'refs/tags/' + revision + '^{}'], text=True, timeout=60)
                rows = [line.split() for line in refs.splitlines() if line.strip()]
                peeled = [row for row in rows if row[1].endswith('^{}')]
                selected = peeled or rows
                if len(selected) != 1:
                    raise RecipeError('REVISION_UNRESOLVED', 'ModelScope revision is missing or ambiguous')
                commit = selected[0][0]
        if not isinstance(commit, str) or not re.fullmatch(r'[a-fA-F0-9]{40}', commit):
            raise RecipeError('REVISION_UNRESOLVED', 'ModelScope did not resolve an immutable revision')
        ms_download(model_id=model_id, revision=commit, local_dir=str(output), allow_patterns=patterns, cookies={}, max_workers=1)
    else:
        raise ValueError('provider must be huggingface or modelscope')
    result = {'provider': provider, 'model_id': model_id, 'requested_revision': revision,
              'resolved_revision': commit, 'output_path': relative, 'artifacts': [relative]}
    result['content_sha256'] = fingerprint({str(Path(path).relative_to(relative)): sha256(workspace / path) for path in files(workspace, [relative])})
    if patterns is not None:
        result['allow_patterns'] = patterns
    atomic_json(output / '.colab-bridge-revision.json', result)
    return result
