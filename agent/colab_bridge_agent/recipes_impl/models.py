from __future__ import annotations

import json
import platform
import shutil
from pathlib import Path
import time
import uuid

from ..workspace import resolve_workspace_path
from .common import RecipeError, atomic_json, files, fingerprint, model_identity, publish, sha256


def load_model(spec: dict, workspace: Path):
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer
    model_path = resolve_workspace_path(workspace, spec['model_path'])
    if not model_path.is_dir():
        raise RecipeError('MODEL_MISSING', 'model_path must be a downloaded local model directory')
    device = spec.get('device', 'auto')
    if device == 'auto':
        device = 'cuda' if torch.cuda.is_available() else 'cpu'
    if device not in {'cpu', 'cuda'}:
        raise ValueError('device must be auto, cpu, or cuda')
    if device == 'cuda' and not torch.cuda.is_available():
        raise RecipeError('CUDA_UNAVAILABLE', 'CUDA device is unavailable')
    torch.set_num_threads(int(spec.get('cpu_threads', 1)))
    dtype_name = spec.get('dtype', 'float32')
    if dtype_name not in {'float32', 'float16', 'bfloat16'}:
        raise ValueError('unsupported dtype')
    model = AutoModelForCausalLM.from_pretrained(str(model_path), local_files_only=True, trust_remote_code=False,
                                                torch_dtype=getattr(torch, dtype_name), attn_implementation='eager')
    tokenizer = AutoTokenizer.from_pretrained(str(model_path), local_files_only=True, trust_remote_code=False)
    if tokenizer.pad_token_id is None:
        tokenizer.pad_token_id = tokenizer.eos_token_id
    if spec.get('adapter_path'):
        from peft import PeftModel
        model = PeftModel.from_pretrained(model, str(resolve_workspace_path(workspace, spec['adapter_path'])), local_files_only=True)
        model = model.merge_and_unload()
    return model.to(device), tokenizer, torch.device(device)


def benchmark(spec: dict, workspace: Path) -> dict:
    import torch
    import transformers
    from ..recipes import benchmark_metrics
    model, tokenizer, device = load_model(spec, workspace)
    maximum = spec.get('max_new_tokens', 32)
    if type(maximum) is not int or not 1 <= maximum <= 4096:
        raise ValueError('max_new_tokens must be 1..4096')
    warmup_runs = spec.get('warmup_runs', 1)
    warmup_tokens = spec.get('warmup_tokens', min(4, maximum))
    if type(warmup_runs) is not int or not 1 <= warmup_runs <= 100 or type(warmup_tokens) is not int or not 1 <= warmup_tokens <= 4096:
        raise ValueError('warmup_runs must be 1..100 and warmup_tokens must be 1..4096')
    prompt = spec.get('prompt', 'Hello')
    if not isinstance(prompt, str) or not prompt:
        raise ValueError('prompt must be non-empty text')
    encoded = tokenizer(prompt, return_tensors='pt')
    prompt_tokens = encoded['input_ids'].to(device)
    prompt_mask = encoded.get('attention_mask', torch.ones_like(prompt_tokens)).to(device)
    model.eval()
    cuda = device.type == 'cuda'

    def sync():
        if cuda:
            torch.cuda.synchronize(device)

    def generate(count):
        # A fresh cache/prompt for every warm-up run and the measured generation.
        tokens, mask, cache, generated = prompt_tokens, prompt_mask, None, []
        sync()
        start = time.perf_counter()
        with torch.inference_mode():
            for index in range(count):
                output = model(input_ids=tokens, attention_mask=mask, past_key_values=cache, use_cache=True)
                next_token = output.logits[:, -1, :].argmax(dim=-1, keepdim=True)
                sync()
                if index == 0:
                    first = time.perf_counter() - start
                generated.append(next_token.item())
                cache = output.past_key_values
                tokens = next_token
                mask = torch.cat([mask, torch.ones_like(next_token)], dim=-1)
                if spec.get('stop_on_eos', False) and generated[-1] == tokenizer.eos_token_id:
                    break
        sync()
        return generated, first, time.perf_counter() - start

    sync()
    warmup_start = time.perf_counter()
    warmup_generated = 0
    for _ in range(warmup_runs):
        warmup_generated += len(generate(warmup_tokens)[0])
    sync()
    warmup_elapsed = time.perf_counter() - warmup_start
    if cuda:
        torch.cuda.reset_peak_memory_stats(device)
    generated, first, total = generate(maximum)
    metrics = benchmark_metrics(first_token_seconds=first, total_seconds=total, generated_tokens=len(generated))
    metrics.update(peak_allocated_vram_bytes=torch.cuda.max_memory_allocated(device) if cuda else None,
                   peak_reserved_vram_bytes=torch.cuda.max_memory_reserved(device) if cuda else None)
    gpu = None
    if cuda:
        properties = torch.cuda.get_device_properties(device)
        gpu = {'index': device.index if device.index is not None else torch.cuda.current_device(),
               'name': properties.name, 'total_memory_bytes': properties.total_memory,
               'compute_capability': [properties.major, properties.minor]}
    versions = {'torch': torch.__version__, 'transformers': transformers.__version__,
                'cuda': torch.version.cuda if cuda else None,
                'cudnn': torch.backends.cudnn.version() if cuda else None, 'peft': None}
    if spec.get('adapter_path'):
        from importlib.metadata import version
        versions['peft'] = version('peft')
    return {**model_identity(workspace, spec['model_path']), 'device': str(device), 'torch_version': torch.__version__,
            'framework_versions': versions,
            'hardware': {'device_type': device.type, 'cpu_architecture': platform.machine(),
                         'cpu_threads': torch.get_num_threads(), 'gpu': gpu},
            'warmup': {'runs': warmup_runs, 'tokens_per_run': warmup_tokens,
                       'generated_tokens': warmup_generated, 'elapsed_seconds': warmup_elapsed},
            'metrics': metrics, 'generated_text': tokenizer.decode(generated),
            'timing_scope': 'synchronized generation only; excludes model load/tokenization and warm-up'}


def lora(spec: dict, workspace: Path) -> dict:
    import torch
    from peft import LoraConfig, PeftModel, TaskType, get_peft_model
    maximum = spec.get('max_steps', 10)
    interval = spec.get('checkpoint_every', min(5, maximum))
    if not isinstance(maximum, int) or not 1 <= maximum <= 100000 or not isinstance(interval, int) or not 1 <= interval <= maximum:
        raise ValueError('finite max_steps and checkpoint_every are required')
    checkpoint = spec.get('checkpoint_path')
    restored_inputs = []
    if checkpoint:
        try:
            directory = resolve_workspace_path(workspace, checkpoint)
            state = json.loads((directory / 'checkpoint.json').read_text())
            if state['version'] != 1 or state['input_paths'] != {key: spec[key] for key in ('model_path', 'data_path')}:
                raise ValueError('checkpoint input paths mismatch')
            restored_inputs = state['inputs']
            if not isinstance(restored_inputs, list) or not restored_inputs:
                raise ValueError('checkpoint input snapshots missing')
            for entry in restored_inputs:
                source = resolve_workspace_path(workspace, entry['snapshot'])
                resolve_workspace_path(workspace, entry['path'])
                if source.is_symlink() or sha256(source) != entry['sha256']:
                    raise ValueError('checkpoint input integrity mismatch')
            for entry in restored_inputs:
                destination = resolve_workspace_path(workspace, entry['path'], create_parent=True)
                if destination.exists() and sha256(destination) != entry['sha256']:
                    raise ValueError('existing training input differs from checkpoint')
                shutil.copyfile(resolve_workspace_path(workspace, entry['snapshot']), destination)
        except (OSError, KeyError, ValueError, TypeError) as error:
            raise RecipeError('CHECKPOINT_INVALID', 'LoRA checkpoint inputs missing, invalid, or incompatible') from error
    data_path = resolve_workspace_path(workspace, spec['data_path'])
    records = [json.loads(line) for line in data_path.read_text().splitlines() if line.strip()]
    if not records or any(not isinstance(row, dict) or not isinstance(row.get('text'), str) or not row['text'] for row in records):
        raise ValueError('training JSONL requires non-empty text fields')
    rank = spec.get('rank', 8)
    if not isinstance(rank, int) or not 1 <= rank <= 256:
        raise ValueError('rank must be 1..256')
    settings = {'rank': rank, 'alpha': spec.get('alpha', rank * 2), 'target_modules': spec.get('target_modules'),
                'learning_rate': spec.get('learning_rate', 2e-4), 'max_length': spec.get('max_length', 128),
                'seed': spec.get('seed', 42), 'dtype': spec.get('dtype', 'float32')}
    identity = model_identity(workspace, spec['model_path'])
    signature = fingerprint({'model': identity['content_sha256'], 'data': sha256(data_path), 'settings': settings})
    torch.manual_seed(settings['seed'])
    model, tokenizer, device = load_model(spec, workspace)
    model.config.use_cache = False
    resumed = 0
    if checkpoint:
        try:
            directory = resolve_workspace_path(workspace, checkpoint)
            state = json.loads((directory / 'checkpoint.json').read_text())
            if state['version'] != 1 or state['input_sha256'] != signature:
                raise ValueError('training input mismatch')
            for name, digest in state['file_sha256'].items():
                if sha256(resolve_workspace_path(workspace, checkpoint + '/' + name)) != digest:
                    raise ValueError('checkpoint integrity mismatch')
            resumed = state['completed_steps']
            if not isinstance(resumed, int) or resumed < 0 or resumed > maximum:
                raise ValueError('resume step must precede max_steps')
            model = PeftModel.from_pretrained(model, str(directory / 'adapter'), is_trainable=True, local_files_only=True)
            restored = torch.load(directory / 'training.pt', map_location=device, weights_only=True)
        except (OSError, KeyError, ValueError, TypeError) as error:
            raise RecipeError('CHECKPOINT_INVALID', 'LoRA checkpoint missing, invalid, or incompatible') from error
    else:
        config = LoraConfig(task_type=TaskType.CAUSAL_LM, r=rank, lora_alpha=settings['alpha'],
                            target_modules=settings['target_modules'], lora_dropout=0.0, bias='none')
        model = get_peft_model(model, config)
    optimizer = torch.optim.AdamW([parameter for parameter in model.parameters() if parameter.requires_grad], lr=settings['learning_rate'])
    if checkpoint:
        optimizer.load_state_dict(restored['optimizer'])
        torch.set_rng_state(restored['rng'].cpu())
        if device.type == 'cuda' and 'cuda_rng' in restored:
            torch.cuda.set_rng_state_all(restored['cuda_rng'])
    relative = spec.get('output_dir', 'adapter')
    destination = resolve_workspace_path(workspace, relative, create_parent=True)
    if destination.exists() and (not checkpoint or any(path.name != 'checkpoints' for path in destination.iterdir())):
        raise RecipeError('OUTPUT_EXISTS', 'LoRA output already contains non-checkpoint files; use a new output_dir')
    destination.mkdir(exist_ok=True)
    model.train()
    losses, latest = [], checkpoint
    start = time.perf_counter()
    run_id = uuid.uuid4().hex
    input_entries = restored_inputs
    for index in range(resumed, maximum):
        row = records[index % len(records)]
        batch = tokenizer(row['text'], return_tensors='pt', truncation=True, max_length=settings['max_length'])
        batch = {key: value.to(device) for key, value in batch.items()}
        if batch['input_ids'].shape[1] < 2:
            raise ValueError('each training text must tokenize to at least two tokens')
        batch['labels'] = batch['input_ids'].clone()
        optimizer.zero_grad(set_to_none=True)
        loss = model(**batch).loss
        if not torch.isfinite(loss):
            raise RecipeError('NONFINITE_LOSS', 'training produced a nonfinite loss')
        loss.backward()
        optimizer.step()
        losses.append(float(loss.detach().cpu()))
        step = index + 1
        if step % interval == 0 or step == maximum:
            latest = f'{relative}/checkpoints/{run_id}-step-{step:06d}'
            folder = resolve_workspace_path(workspace, latest, create_parent=True)
            folder.mkdir()
            model.save_pretrained(folder / 'adapter', safe_serialization=True)
            training = {'optimizer': optimizer.state_dict(), 'rng': torch.get_rng_state()}
            if device.type == 'cuda':
                training['cuda_rng'] = torch.cuda.get_rng_state_all()
            torch.save(training, folder / 'training.pt')
            if not input_entries:
                input_root = f'.colab-bridge/checkpoints/lora-inputs-{run_id}'
                for path in files(workspace, [spec['model_path'], spec['data_path']]):
                    snapshot = input_root + '/files/' + path
                    target = resolve_workspace_path(workspace, snapshot, create_parent=True)
                    shutil.copyfile(workspace / path, target)
                    input_entries.append({'path': path, 'snapshot': snapshot, 'sha256': sha256(target)})
            hashes = {str(Path(path).relative_to(latest)): sha256(workspace / path) for path in files(workspace, [latest])}
            atomic_json(folder / 'checkpoint.json', {'version': 1, 'input_sha256': signature, 'completed_steps': step, 'file_sha256': hashes,
                                                     'input_paths': {key: spec[key] for key in ('model_path', 'data_path')}, 'inputs': input_entries})
            publish(workspace, [latest] + [entry['snapshot'] for entry in input_entries])
            print(json.dumps({'event': 'lora_checkpoint', 'step': step, 'loss': losses[-1], 'checkpoint_path': latest}), flush=True)
    model.save_pretrained(destination / 'final', safe_serialization=True)
    metrics = {'completed_steps': maximum, 'resumed_from_step': resumed, 'losses': losses, 'total_seconds': time.perf_counter() - start}
    atomic_json(destination / 'metrics.json', metrics)
    return {**identity, 'device': str(device), 'metrics': metrics, 'adapter_path': relative + '/final',
            'checkpoint_path': latest, 'artifacts': [relative, latest] + [entry['snapshot'] for entry in input_entries], 'input_sha256': signature}
