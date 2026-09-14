import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time

import pytest

from colab_bridge_agent.jobs import execute_job


def run(kind, spec, workspace, timeout=30):
    return execute_job({'kind': kind, 'spec': spec, 'timeout_seconds': timeout}, workspace, lambda event: None, lambda: False)


def test_metric_definitions_and_validation():
    from colab_bridge_agent.recipes import benchmark_metrics, validate_repo_url, validate_export
    assert benchmark_metrics(first_token_seconds=.2, total_seconds=1.2, generated_tokens=11)['decode_tokens_per_second'] == 10.0
    assert benchmark_metrics(first_token_seconds=.2, total_seconds=.2, generated_tokens=1)['decode_tokens_per_second'] is None
    for url in ['file:///etc/passwd', 'https://github.com.evil/x', 'https://user:pass@github.com/x', 'https://github.com:444/x']:
        with pytest.raises(ValueError):
            validate_repo_url(url)
    assert validate_repo_url('https://cnb.cool/team/repo') == 'https://cnb.cool/team/repo'
    with pytest.raises(ValueError):
        validate_export('unknown-model', 'unknown-format')


def test_git_checkout_records_real_commit(tmp_path):
    from colab_bridge_agent.recipes_impl.repository import checkout
    source = tmp_path / 'source'
    source.mkdir()
    subprocess.run(['git', 'init', str(source)], check=True, capture_output=True)
    (source / 'readme.txt').write_text('fixture')
    subprocess.run(['git', '-C', str(source), 'add', '.'], check=True)
    subprocess.run(['git', '-C', str(source), '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture'], check=True, capture_output=True)
    revision = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
    result = checkout({'url': 'https://github.com/example/repo', 'revision': revision, 'output_dir': 'checkout'}, tmp_path, transport=lambda url: str(source))
    assert result['resolved_revision'] == revision
    assert (tmp_path / result['output_path'] / 'readme.txt').read_text() == 'fixture'


def test_descriptor_paths_and_structured_errors(tmp_path):
    from colab_bridge_agent.recipes import build_recipe
    with pytest.raises(ValueError):
        build_recipe({'kind': 'benchmark', 'spec': {'model_path': '../outside'}}, tmp_path)
    outcome = run('export', {'model_path': 'model', 'format': 'tflite', 'output_path': 'out.tflite'}, tmp_path)
    assert outcome['error_code'] == 'UNSUPPORTED_FORMAT'
    assert outcome['result']['error']['code'] == 'UNSUPPORTED_FORMAT'


def test_pipeline_checkpoint_resume_and_missing_source(tmp_path):
    steps = [
        {'id': 'first', 'kind': 'python', 'spec': {'code': "from pathlib import Path\np=Path('count.txt'); p.write_text(str(int(p.read_text())+1) if p.exists() else '1')", 'artifacts': ['count.txt']}},
        {'id': 'second', 'kind': 'python', 'spec': {'code': "from pathlib import Path\nassert Path('gate.txt').exists()\nPath('answer.txt').write_text(Path('count.txt').read_text())", 'artifacts': ['answer.txt']}, 'inputs': ['count.txt']},
    ]
    failed = run('pipeline', {'steps': steps}, tmp_path)
    assert failed['status'] == 'failed'
    checkpoints = list(tmp_path.glob('.colab-bridge/checkpoints/pipeline-*/step-*/checkpoint.json'))
    assert len(checkpoints) == 1
    checkpoint = str(checkpoints[0].relative_to(tmp_path))
    assert checkpoint in {item['path'] for item in failed['artifacts']}
    (tmp_path / 'count.txt').unlink()
    (tmp_path / 'gate.txt').write_text('go')
    resumed = run('pipeline', {'steps': steps, 'resume': True, 'checkpoint_path': checkpoint}, tmp_path)
    assert resumed['status'] == 'succeeded'
    assert (tmp_path / 'answer.txt').read_text() == '1'
    assert resumed['result']['steps'][0]['resumed'] is True
    missing = run('pipeline', {'steps': steps, 'resume': True, 'checkpoint_path': 'absent.json'}, tmp_path)
    assert missing['error_code'] == 'CHECKPOINT_INVALID'
    changed = run('pipeline', {'steps': steps[:1], 'resume': True, 'checkpoint_path': checkpoint}, tmp_path)
    assert changed['error_code'] == 'CHECKPOINT_INVALID'


def test_result_must_be_object(tmp_path):
    outcome = run('python', {'code': "open('result.json','w').write('[1,2]')", 'result_path': 'result.json'}, tmp_path)
    assert outcome['status'] == 'failed'
    assert outcome['error_code'] == 'OUTPUT_INVALID'
    assert outcome['result'] is None or isinstance(outcome['result'], dict)


def test_drive_mount_copy_and_missing_mount(tmp_path, monkeypatch):
    from colab_bridge_agent.recipes_impl.drive import export_drive
    source = tmp_path / 'data.txt'
    source.write_text('durable')
    mount = tmp_path / 'mounted'
    mount.mkdir()
    monkeypatch.setenv('COLAB_BRIDGE_DRIVE_MOUNT', str(mount))
    result = export_drive({'source_path': 'data.txt', 'destination': 'results/data.txt', 'mode': 'mount'}, tmp_path)
    assert (mount / 'results/data.txt').read_text() == 'durable'
    assert result['sha256'] == hashlib.sha256(b'durable').hexdigest()
    monkeypatch.delenv('COLAB_BRIDGE_DRIVE_MOUNT')
    outcome = run('drive_export', {'source_path': 'data.txt', 'destination': 'out.txt'}, tmp_path)
    assert outcome['error_code'] == 'DRIVE_MOUNT_MISSING'


def test_inflight_checkpoint_upload_before_failed_completion(tmp_path):
    from colab_bridge_agent.config import AgentConfig
    from colab_bridge_agent.jobs import JobRunner
    from test_jobs import RecordingClient, job
    steps = [
        {'id': 'checkpoint', 'kind': 'file', 'spec': {'path': 'kept.txt', 'text': 'keep'}},
        {'id': 'fail', 'kind': 'python', 'spec': {'code': 'import time; time.sleep(.5); raise RuntimeError()'}},
    ]
    claimed = job('pipeline', {'steps': steps})
    class Client(RecordingClient):
        def upload_artifact(self, url, path, mime_type):
            self.calls.append(('upload_live', time.monotonic(), Path(path).read_bytes()))
    client = Client(claimed)
    config = AgentConfig('https://example.test/agent', 'secret', execution_enabled=True, workspace_root=str(tmp_path))
    JobRunner(config, client, 'runtime').run_once()
    uploads = [call for call in client.calls if call[0] == 'upload_live']
    assert uploads
    completion = next(call for call in client.calls if call[0] == 'job_complete')
    assert completion[1] == 'failed'
    assert completion[4] == 'PIPELINE_STEP_FAILED'
    # Upload starts while the second process is still running, rather than only at completion.
    assert time.monotonic() - uploads[0][1] > .3
    assert any(call[2] == b'keep' for call in uploads)


def test_terminal_checkpoint_on_timeout(tmp_path):
    outcome = run('pipeline', {'steps': [
        {'id': 'first', 'kind': 'file', 'spec': {'path': 'out.txt', 'text': 'preserved'}},
        {'id': 'slow', 'kind': 'python', 'spec': {'code': 'import time; time.sleep(60)'}},
    ]}, tmp_path, timeout=1)
    assert outcome['status'] == 'timed_out'
    assert any(item['path'].endswith('checkpoint.json') for item in outcome['artifacts'])


def test_download_pins_remote_revision_and_records_output(tmp_path):
    from types import SimpleNamespace
    from colab_bridge_agent.recipes_impl.repository import download
    class API:
        def model_info(self, model_id, revision):
            return SimpleNamespace(sha='a' * 40)
    def fetch(**kwargs):
        assert kwargs['revision'] == 'a' * 40
        out = Path(kwargs['local_dir'])
        out.mkdir()
        (out / 'config.json').write_text('{}')
    result = download({'model_id': 'owner/model', 'revision': 'main'}, tmp_path, hf_api=API(), hf_download=fetch)
    assert result['resolved_revision'] == 'a' * 40
    assert json.loads((tmp_path / 'model/.colab-bridge-revision.json').read_text())['requested_revision'] == 'main'


def test_drive_authorized_provider_upload(tmp_path):
    from colab_bridge_agent.recipes_impl.drive import export_drive
    (tmp_path / 'input.txt').write_text('abc')
    class Provider:
        def upload(self, path, *, name, parent_id):
            assert path.read_text() == 'abc'
            assert name == 'named.txt' and parent_id == 'parent'
            return {'id': 'uploaded'}
    result = export_drive({'mode': 'api', 'source_path': 'input.txt', 'name': 'named.txt', 'parent_id': 'parent'}, tmp_path, provider=Provider())
    assert result['drive']['id'] == 'uploaded'


@pytest.mark.skipif(__import__('os').environ.get('COLAB_BRIDGE_REAL_MODEL_TESTS') != '1', reason='explicit real model fixture environment required')
def test_real_tiny_model_recipes(tmp_path):
    import shutil
    fixtures = Path('/workspace/scratch/203f1bd95405/colab-validation-fixtures')
    python = '/workspace/scratch/203f1bd95405/colab-model-validation/bin/python'
    shutil.copytree(fixtures / 'tiny-causal-lm', tmp_path / 'model')
    shutil.copytree(fixtures / 'tiny-llama', tmp_path / 'llama')
    shutil.copyfile(fixtures / 'tiny-training.jsonl', tmp_path / 'train.jsonl')
    package_root = str(Path(__file__).resolve().parents[1])
    def actual(kind, spec, workspace=tmp_path):
        payload = json.dumps({'kind': kind, 'spec': spec, 'timeout_seconds': 120})
        code = f"import sys,json;sys.path.insert(0,{package_root!r});from colab_bridge_agent.jobs import execute_job;r=execute_job(json.loads({payload!r}),{str(workspace)!r},lambda e:print(e['text'],end='',file=sys.stderr),lambda:False);print(json.dumps(r))"
        process = subprocess.run([python, '-c', code], text=True, capture_output=True, timeout=140)
        assert process.returncode == 0, process.stderr
        result = json.loads(process.stdout)
        assert result['status'] == 'succeeded', (result, process.stderr)
        print(json.dumps({'kind': kind, 'result': result['result']}))
        return result['result']
    benchmark = actual('benchmark', {'model_path': 'model', 'prompt': 'hello', 'max_new_tokens': 8, 'device': 'cpu'})
    assert benchmark['metrics']['generated_tokens'] == 8
    assert benchmark['metrics']['first_token_seconds'] > 0
    assert benchmark['device'] == 'cpu'
    assert benchmark['warmup']['runs'] == 1 and benchmark['warmup']['tokens_per_run'] == 4
    assert benchmark['warmup']['generated_tokens'] == 4 and benchmark['warmup']['elapsed_seconds'] > 0
    assert benchmark['hardware']['gpu'] is None and benchmark['hardware']['cpu_architecture']
    assert benchmark['framework_versions']['transformers'] == '4.57.6'
    assert benchmark['framework_versions']['torch'] == '2.14.0+cpu'
    trained = actual('lora', {'model_path': 'model', 'data_path': 'train.jsonl', 'output_dir': 'adapter', 'max_steps': 2, 'checkpoint_every': 1, 'device': 'cpu', 'target_modules': ['c_attn'], 'rank': 2})
    assert trained['metrics']['completed_steps'] == 2
    restored = tmp_path / 'restored-workspace'
    restored.mkdir()
    for manifest in (tmp_path / '.colab-bridge/publish').glob('*.json'):
        for relative in json.loads(manifest.read_text())['artifacts']:
            destination = restored / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(tmp_path / relative, destination)
    resumed = actual('lora', {'model_path': 'model', 'data_path': 'train.jsonl', 'output_dir': 'adapter-resumed', 'max_steps': 3, 'checkpoint_every': 1, 'device': 'cpu', 'target_modules': ['c_attn'], 'rank': 2, 'checkpoint_path': trained['checkpoint_path']}, workspace=restored)
    assert resumed['metrics']['resumed_from_step'] == 2
    finished = actual('lora', {'model_path': 'model', 'data_path': 'train.jsonl', 'output_dir': 'adapter', 'max_steps': 2, 'checkpoint_every': 1, 'device': 'cpu', 'target_modules': ['c_attn'], 'rank': 2, 'checkpoint_path': trained['checkpoint_path']}, workspace=restored)
    assert finished['metrics']['losses'] == []
    assert any('lora-inputs-' in path for path in finished['artifacts'])
    uninterrupted = actual('lora', {'model_path': 'model', 'data_path': 'train.jsonl', 'output_dir': 'uninterrupted', 'max_steps': 3, 'checkpoint_every': 1, 'device': 'cpu', 'target_modules': ['c_attn'], 'rank': 2})
    assert (tmp_path / uninterrupted['adapter_path'] / 'adapter_model.safetensors').read_bytes() == (restored / resumed['adapter_path'] / 'adapter_model.safetensors').read_bytes()
    actual('export', {'model_path': 'model', 'format': 'onnx', 'output_path': 'export/model.onnx'})
    gguf = actual('export', {'model_path': 'llama', 'format': 'gguf', 'output_path': 'export/model.gguf', 'converter_path': '/workspace/scratch/203f1bd95405/colab-llama-validation/convert_hf_to_gguf.py', 'outtype': 'f32'})
    assert gguf['converter_revision'] == '89fe24240548456477870b2a627cd8021fea1e39'
    assert (tmp_path / 'export/model.gguf').read_bytes()[:4] == b'GGUF'
    assert len(gguf['sha256']) == 64


def test_slow_checkpoint_upload_does_not_delay_timeout(tmp_path):
    from colab_bridge_agent.config import AgentConfig
    from colab_bridge_agent.jobs import JobRunner
    from test_jobs import RecordingClient, job
    claimed = job('pipeline', {'steps': [
        {'id': 'first', 'kind': 'file', 'spec': {'path': 'first.txt', 'text': 'checkpoint'}},
        {'id': 'slow', 'kind': 'python', 'spec': {'code': "import time;time.sleep(1.4);open('too-late.txt','w').write('bad');time.sleep(60)"}},
    ]})
    claimed['timeout_seconds'] = 1
    class Slow(RecordingClient):
        def upload_artifact(self, *args):
            if not any(call[0] == 'upload' for call in self.calls):
                time.sleep(1.5)
            super().upload_artifact(*args)
    client = Slow(claimed)
    JobRunner(AgentConfig('https://example.test/agent', 'secret', workspace_root=str(tmp_path)), client, 'runtime').run_once()
    assert not list(tmp_path.rglob('too-late.txt'))
    assert next(call for call in client.calls if call[0] == 'job_complete')[1] == 'timed_out'
    assert any(call[0] == 'artifact_complete' for call in client.calls)


def test_lost_lease_stops_checkpoint_mutations(tmp_path, monkeypatch):
    import colab_bridge_agent.jobs as jobs
    from colab_bridge_agent.config import AgentConfig
    from test_jobs import RecordingClient, job
    monkeypatch.setattr(jobs, 'JOB_HEARTBEAT_SECONDS', .1)
    claimed = job('pipeline', {'steps': [
        {'id': 'first', 'kind': 'file', 'spec': {'path': 'first.txt', 'text': 'checkpoint'}},
        {'id': 'slow', 'kind': 'python', 'spec': {'code': 'import time;time.sleep(60)'}},
    ]})
    class Lost(RecordingClient):
        uploading = False
        def upload_artifact(self, *args):
            self.uploading = True
            time.sleep(.4)
            super().upload_artifact(*args)
        def job_heartbeat(self, *args):
            return {'ok': True, 'lease_valid': not self.uploading}
    client = Lost(claimed)
    jobs.JobRunner(AgentConfig('https://example.test/agent', 'secret', workspace_root=str(tmp_path)), client, 'runtime').run_once()
    time.sleep(.45)
    assert client.uploading
    assert len([call for call in client.calls if call[0] == 'prepare']) == 1
    assert not any(call[0] in {'artifact_complete', 'job_complete'} for call in client.calls)


def test_checkpoint_publication_failure_is_reported(tmp_path):
    from colab_bridge_agent.config import AgentConfig
    from colab_bridge_agent.jobs import JobRunner
    from test_jobs import RecordingClient, job
    claimed = job('pipeline', {'steps': [
        {'id': 'first', 'kind': 'file', 'spec': {'path': 'first.txt', 'text': 'checkpoint'}},
        {'id': 'bad', 'kind': 'python', 'spec': {'code': 'raise RuntimeError()'}},
    ]})
    class Broken(RecordingClient):
        def artifact_prepare(self, *args, **kwargs):
            return {'ok': False}
    client = Broken(claimed)
    JobRunner(AgentConfig('https://example.test/agent', 'secret', workspace_root=str(tmp_path)), client, 'runtime').run_once()
    terminal = next(call for call in client.calls if call[0] == 'job_complete')
    assert terminal[1] == 'failed' and terminal[4] == 'PIPELINE_STEP_FAILED'
    assert terminal[2]['checkpoint_publication'] == {'complete': False}


def test_invalid_publication_manifest_is_terminal_failure(tmp_path):
    outcome = run('python', {'code': "from pathlib import Path\np=Path('.colab-bridge/publish');p.mkdir(parents=True);(p/'bad.json').write_text('[]')"}, tmp_path)
    assert outcome['status'] == 'failed'
    assert outcome['error_code'] == 'CHECKPOINT_INVALID'


def test_resume_from_parent_without_checkpoint_never_replays(tmp_path):
    job = {'kind': 'pipeline', 'parent_job_id': 'previous', 'spec': {'resume': True, 'steps': [
        {'id': 'code', 'kind': 'python', 'spec': {'code': "open('replayed.txt','w').write('bad')"}}
    ]}}
    outcome = execute_job(job, tmp_path, lambda event: None, lambda: False)
    assert outcome['error_code'] == 'CHECKPOINT_INVALID'
    assert not (tmp_path / 'replayed.txt').exists()


def test_download_modelscope_records_immutable_commit(tmp_path):
    from colab_bridge_agent.recipes_impl.repository import download
    class API:
        def get_valid_revision_detail(self, model_id, revision):
            return {'Revision': 'master', 'Sha': 'b' * 40}
    def fetch(**kwargs):
        assert kwargs['revision'] == 'b' * 40
        output = Path(kwargs['local_dir'])
        output.mkdir()
        (output / 'config.json').write_text('{}')
    result = download({'provider': 'modelscope', 'model_id': 'owner/model', 'revision': 'master'}, tmp_path, ms_api=API(), ms_download=fetch)
    assert result['resolved_revision'] == 'b' * 40


def test_pipeline_restores_published_files_in_a_new_workspace(tmp_path):
    import shutil
    first = tmp_path / 'first'
    steps = [
        {'id': 'input', 'kind': 'file', 'spec': {'path': 'data.txt', 'text': 'research'}},
        {'id': 'consume', 'kind': 'python', 'inputs': ['data.txt'], 'spec': {'code': "from pathlib import Path\nassert Path('gate.txt').exists()\nPath('answer.txt').write_text(Path('data.txt').read_text())", 'artifacts': ['answer.txt']}},
    ]
    failed = run('pipeline', {'steps': steps}, first)
    restored = tmp_path / 'restored'
    restored.mkdir()
    for item in failed['artifacts']:
        target = restored / item['path']
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(first / item['path'], target)
    checkpoint = next(item['path'] for item in failed['artifacts'] if item['path'].endswith('checkpoint.json'))
    (restored / 'gate.txt').write_text('ready')
    resumed = run('pipeline', {'steps': steps, 'resume': True, 'checkpoint_path': checkpoint}, restored)
    assert resumed['status'] == 'succeeded'
    assert (restored / 'answer.txt').read_text() == 'research'
    # Checkpoint bytes are also validated even if all completed steps would be skipped.
    state = json.loads((restored / checkpoint).read_text())
    (restored / state['files'][0]['snapshot']).write_text('corrupt')
    invalid = run('pipeline', {'steps': steps, 'resume': True, 'checkpoint_path': checkpoint}, restored)
    assert invalid['error_code'] == 'CHECKPOINT_INVALID'


def test_recipe_missing_dependency_and_oom_are_structured(tmp_path, monkeypatch):
    import colab_bridge_agent.recipes_impl.launcher as launcher
    for exception, expected in [(ModuleNotFoundError('torch'), 'MISSING_DEPENDENCY'), (RuntimeError('CUDA out of memory'), 'OUT_OF_MEMORY')]:
        request = tmp_path / 'request.json'
        request.write_text(json.dumps({'kind': 'benchmark', 'spec': {}, 'workspace': str(tmp_path), 'result_path': 'result.json'}))
        monkeypatch.setattr(sys, 'argv', ['launcher', str(request)])
        def fail(*args):
            raise exception
        monkeypatch.setattr(launcher, 'dispatch', fail)
        with pytest.raises(SystemExit):
            launcher.main()
        assert json.loads((tmp_path / 'result.json').read_text())['error']['code'] == expected


def test_recipe_rejects_secret_fields_and_invalid_ranges(tmp_path):
    from colab_bridge_agent.recipes import build_recipe
    for kind, spec in [
        ('model_download', {'model_id': 'a/b', 'revision': 'main', 'token': 'secret'}),
        ('benchmark', {'model_path': 'model', 'max_new_tokens': 0}),
        ('lora', {'model_path': 'model', 'data_path': 'data.jsonl', 'max_steps': 0}),
        ('export', {'model_path': 'model', 'format': 'gguf', 'output_path': '../escape'}),
        ('pipeline', {'steps': [{'id': 'x', 'kind': 'python', 'spec': {'code': ''}, 'inputs': '../bad'}]}),
    ]:
        with pytest.raises(ValueError):
            build_recipe({'kind': kind, 'spec': spec}, tmp_path)


def test_checkpoint_marker_is_published_after_all_snapshot_files(tmp_path):
    from colab_bridge_agent.config import AgentConfig
    from colab_bridge_agent.jobs import JobRunner
    from test_jobs import RecordingClient, job
    claimed = job('pipeline', {'steps': [{'id': 'saved', 'kind': 'file', 'spec': {'path': 'saved.txt', 'text': 'content'}}]})
    client = RecordingClient(claimed)
    JobRunner(AgentConfig('https://example.test/agent', 'secret', workspace_root=str(tmp_path)), client, 'runtime').run_once()
    paths = [call[1]['path'] for call in client.calls if call[0] == 'prepare']
    marker = next(path for path in paths if path.endswith('/checkpoint.json'))
    snapshot = next(path for path in paths if '/files/saved.txt' in path)
    assert paths.index(snapshot) < paths.index(marker)


def test_stuck_checkpoint_upload_has_bounded_drain_and_no_late_registration(tmp_path, monkeypatch):
    import colab_bridge_agent.jobs as jobs
    from colab_bridge_agent.config import AgentConfig
    from test_jobs import RecordingClient, job
    monkeypatch.setattr(jobs, 'PUBLICATION_DRAIN_SECONDS', .05, raising=False)
    claimed = job('pipeline', {'steps': [
        {'id': 'saved', 'kind': 'file', 'spec': {'path': 'out.txt', 'text': 'content'}},
        {'id': 'bad', 'kind': 'python', 'spec': {'code': 'import time;time.sleep(.2);raise RuntimeError()'}},
    ]})
    class Slow(RecordingClient):
        def upload_artifact(self, *args):
            time.sleep(.8)
            super().upload_artifact(*args)
    client = Slow(claimed)
    started = time.monotonic()
    jobs.JobRunner(AgentConfig('https://example.test/agent', 'secret', workspace_root=str(tmp_path)), client, 'runtime').run_once()
    assert time.monotonic() - started < .7
    terminal = next(call for call in client.calls if call[0] == 'job_complete')
    assert terminal[2]['checkpoint_publication'] == {'complete': False}
    time.sleep(.9)
    assert not any(call[0] == 'artifact_complete' for call in client.calls)


def test_cancelled_pipeline_retains_checkpoint(tmp_path):
    outcome = execute_job({'kind': 'pipeline', 'spec': {'steps': [
        {'id': 'saved', 'kind': 'file', 'spec': {'path': 'saved.txt', 'text': 'content'}},
        {'id': 'running', 'kind': 'python', 'spec': {'code': "from pathlib import Path\nimport time\nPath('ready').write_text('ready')\ntime.sleep(60)"}},
    ]}}, tmp_path, lambda event: None, lambda: (tmp_path / 'ready').exists())
    assert outcome['status'] == 'cancelled'
    assert any(item['path'].endswith('/checkpoint.json') for item in outcome['artifacts'])


def test_export_unknown_architecture_is_explicit(tmp_path):
    (tmp_path / 'model').mkdir()
    (tmp_path / 'model/config.json').write_text('{"model_type":"unknown"}')
    outcome = run('export', {'model_path': 'model', 'format': 'onnx'}, tmp_path)
    assert outcome['error_code'] == 'UNSUPPORTED_ARCHITECTURE'


def test_nested_checkpoint_files_precede_outer_pipeline_marker(tmp_path):
    from colab_bridge_agent.config import AgentConfig
    from colab_bridge_agent.jobs import JobRunner
    from test_jobs import RecordingClient, job
    client = RecordingClient(job('pipeline', {'steps': [{'id': 'nested', 'kind': 'file', 'spec': {'path': 'nested/checkpoint.json', 'text': '{}'}}]}))
    JobRunner(AgentConfig('https://example.test/agent', 'secret', workspace_root=str(tmp_path)), client, 'runtime').run_once()
    paths = [call[1]['path'] for call in client.calls if call[0] == 'prepare']
    outer = next(path for path in paths if '/step-0001/checkpoint.json' in path)
    nested = next(path for path in paths if '/files/nested/checkpoint.json' in path)
    assert paths.index(nested) < paths.index(outer)


def test_rejected_checkpoint_lease_stops_further_mutations(tmp_path):
    from colab_bridge_agent.config import AgentConfig
    from colab_bridge_agent.jobs import JobRunner
    from test_jobs import RecordingClient, job
    class Rejected(RecordingClient):
        def artifact_prepare(self, *args, **kwargs):
            self.calls.append(('prepare', kwargs))
            return {'ok': False, 'error_code': 'LEASE_INVALID'}
    client = Rejected(job('pipeline', {'steps': [
        {'id': 'saved', 'kind': 'file', 'spec': {'path': 'out.txt', 'text': 'content'}},
        {'id': 'slow', 'kind': 'python', 'spec': {'code': 'import time;time.sleep(.4)'}},
    ]}))
    JobRunner(AgentConfig('https://example.test/agent', 'secret', workspace_root=str(tmp_path)), client, 'runtime').run_once()
    assert len([call for call in client.calls if call[0] == 'prepare']) == 1
    assert not any(call[0] == 'job_complete' for call in client.calls)


def test_completed_pipeline_checkpoint_survives_two_linked_restores(tmp_path):
    from colab_bridge_agent.config import AgentConfig
    from colab_bridge_agent.jobs import JobRunner
    from test_jobs import RecordingClient, job
    class MemoryClient(RecordingClient):
        def __init__(self, claimed, restored):
            super().__init__(claimed)
            self.restored, self.prepared, self.published, self.payloads = restored, {}, {}, {}
        def artifact_prepare(self, runtime_id, job_id, lease, **manifest):
            key = str(len(self.prepared))
            self.prepared[key] = manifest
            return {'ok': True, 'upload_method': 'PUT', 'artifact_id': key, 'upload_url': key}
        def upload_artifact(self, upload_url, path, mime_type):
            self.payloads[upload_url] = Path(path).read_bytes()
        def artifact_complete(self, runtime_id, job_id, lease, artifact_id):
            manifest = self.prepared[artifact_id]
            self.published[manifest['path']] = (manifest, self.payloads[artifact_id])
            return {'ok': True}
        def download_artifact(self, url):
            return self.restored[url][1]
    steps = [{'id': 'once', 'kind': 'python', 'spec': {
        'code': "from pathlib import Path\np=Path('data.txt');p.write_text(str(int(p.read_text())+1) if p.exists() else '1')", 'artifacts': ['data.txt']}}]
    previous, marker = {}, None
    for index in range(3):
        spec = {'steps': steps}
        if marker:
            spec.update(resume=True, checkpoint_path=marker)
        claimed = job('pipeline', spec)
        claimed['id'] = f'linked-{index}'
        claimed['attempt'] = index + 1
        claimed['restore_artifacts'] = [{**manifest, 'download_url': path} for path, (manifest, _) in previous.items()]
        client = MemoryClient(claimed, previous)
        JobRunner(AgentConfig('https://example.test/agent', 'secret', workspace_root=str(tmp_path)), client, 'runtime').run_once()
        terminal = next(call for call in client.calls if call[0] == 'job_complete')
        assert terminal[1] == 'succeeded'
        marker = terminal[2]['checkpoint_path']
        assert marker in client.published
        state = json.loads(client.published[marker][1])
        assert all(entry['snapshot'] in client.published for entry in state['files'])
        assert client.published['data.txt'][1] == b'1'
        previous = client.published


def test_benchmark_warmup_schema(tmp_path):
    from colab_bridge_agent.recipes import build_recipe
    assert build_recipe({'kind': 'benchmark', 'spec': {'model_path': 'model', 'warmup_runs': 2, 'warmup_tokens': 3}}, tmp_path)['argv']
    for field, value in [('warmup_runs', 0), ('warmup_runs', 101), ('warmup_tokens', 0), ('warmup_tokens', 4097)]:
        with pytest.raises(ValueError):
            build_recipe({'kind': 'benchmark', 'spec': {'model_path': 'model', field: value}}, tmp_path)


@pytest.mark.parametrize('device_type', ['cpu', 'cuda'])
def test_benchmark_warmup_is_outside_timing_and_records_hardware(tmp_path, monkeypatch, device_type):
    from contextlib import nullcontext
    from types import SimpleNamespace
    import colab_bridge_agent.recipes_impl.models as models
    clock, events, caches = [0.0], [], []
    class Token:
        def to(self, device): return self
        def __getitem__(self, item): return self
        def argmax(self, **kwargs): return self
        def item(self): return 1
    class Model:
        dtype = 'torch.float32'
        def eval(self): pass
        def __call__(self, **kwargs):
            caches.append(kwargs['past_key_values'])
            events.append('forward')
            clock[0] += 1
            return SimpleNamespace(logits=Token(), past_key_values=object())
    class Tokenizer:
        eos_token_id = 99
        def __call__(self, *args, **kwargs): return {'input_ids': Token(), 'attention_mask': Token()}
        def decode(self, tokens): return 'generated'
    cuda = SimpleNamespace(
        synchronize=lambda device: events.append('sync'),
        reset_peak_memory_stats=lambda device: events.append('reset'),
        max_memory_allocated=lambda device: 100,
        max_memory_reserved=lambda device: 200,
        current_device=lambda: 0,
        get_device_properties=lambda device: SimpleNamespace(name='Fixture GPU', total_memory=12345, major=8, minor=0),
    )
    torch = SimpleNamespace(__version__='torch-fixture', cuda=cuda, inference_mode=nullcontext,
                            ones_like=lambda value: Token(), cat=lambda values, **kwargs: Token(), get_num_threads=lambda: 1,
                            version=SimpleNamespace(cuda='12.fixture'), backends=SimpleNamespace(cudnn=SimpleNamespace(version=lambda: 9000)))
    monkeypatch.setitem(sys.modules, 'torch', torch)
    monkeypatch.setitem(sys.modules, 'transformers', SimpleNamespace(__version__='transformers-fixture'))
    device = SimpleNamespace(type=device_type, index=0 if device_type == 'cuda' else None)
    monkeypatch.setattr(models, 'load_model', lambda spec, workspace: (Model(), Tokenizer(), device))
    monkeypatch.setattr(models, 'model_identity', lambda workspace, path: {'model_path': path, 'resolved_revision': 'revision'})
    monkeypatch.setattr(models.time, 'perf_counter', lambda: clock[0])
    result = models.benchmark({'model_path': 'model', 'max_new_tokens': 2, 'warmup_runs': 2, 'warmup_tokens': 3}, tmp_path)
    assert result['warmup'] == {'runs': 2, 'tokens_per_run': 3, 'generated_tokens': 6, 'elapsed_seconds': 6.0}
    assert result['metrics']['total_seconds'] == 2.0
    assert result['metrics']['first_token_seconds'] == 1.0
    assert len(caches) == 8 and all(caches[index] is None for index in (0, 3, 6))
    assert result['framework_versions']['transformers'] == 'transformers-fixture'
    assert result['framework_versions']['torch'] == 'torch-fixture'
    if device_type == 'cuda':
        assert result['hardware']['gpu'] == {'index': 0, 'name': 'Fixture GPU', 'total_memory_bytes': 12345, 'compute_capability': [8, 0]}
        assert events[:events.index('reset')].count('forward') == 6
        assert events[0] == 'sync' and events[events.index('reset') - 1] == 'sync'
    else:
        assert result['hardware']['gpu'] is None
        assert result['hardware']['cpu_architecture']
        assert 'sync' not in events and 'reset' not in events
