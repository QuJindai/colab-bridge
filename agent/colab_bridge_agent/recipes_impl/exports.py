from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys

from ..workspace import resolve_workspace_path
from .common import RecipeError, model_identity, sha256


def export_model(spec: dict, workspace: Path) -> dict:
    from ..recipes import validate_export
    format = spec.get('format')
    if format not in {'onnx', 'gguf'}:
        raise RecipeError('UNSUPPORTED_FORMAT', 'supported export formats: onnx, gguf')
    model_path = resolve_workspace_path(workspace, spec['model_path'])
    architecture = json.loads((model_path / 'config.json').read_text())['model_type']
    validate_export(architecture, format)
    relative = spec.get('output_path', 'export/model.' + format)
    output = resolve_workspace_path(workspace, relative, create_parent=True)
    if output.exists():
        raise RecipeError('OUTPUT_EXISTS', 'export output already exists')
    result = {**model_identity(workspace, spec['model_path']), 'format': format, 'architecture': architecture, 'output_path': relative}
    if format == 'onnx':
        import torch
        import onnx
        from .models import load_model
        model, tokenizer, _ = load_model({**spec, 'device': 'cpu', 'dtype': 'float32'}, workspace)
        model.eval()
        class Logits(torch.nn.Module):
            def __init__(self, model, length):
                super().__init__()
                self.model = model
                mask = torch.full((1, 1, length, length), torch.finfo(torch.float32).min)
                self.register_buffer('mask', torch.triu(mask, diagonal=1))
            def forward(self, input_ids):
                return self.model(input_ids=input_ids, attention_mask=self.mask, use_cache=False).logits
        sample = tokenizer(spec.get('sample_text', 'Hello world'), return_tensors='pt')['input_ids']
        # Fixed-shape, logits-only graph. Dynamic/KV-cache generation is not claimed.
        torch.onnx.export(Logits(model, sample.shape[1]), (sample,), str(output), input_names=['input_ids'], output_names=['logits'],
                          opset_version=18, dynamo=False)
        onnx.checker.check_model(str(output))
        result.update(input_shape=list(sample.shape), opset=18, graph='fixed-shape logits; no KV cache')
    else:
        converter = Path(spec.get('converter_path', ''))
        if not converter.is_absolute() or not converter.is_file() or converter.name != 'convert_hf_to_gguf.py':
            raise RecipeError('CONVERTER_MISSING', 'configure the installed official llama.cpp convert_hf_to_gguf.py absolute path')
        try:
            revision = subprocess.check_output(['git', '-C', str(converter.parent), 'rev-parse', 'HEAD'], text=True).strip()
            dirty = subprocess.check_output(['git', '-C', str(converter.parent), 'status', '--porcelain', '--untracked-files=no'], text=True).strip()
        except subprocess.CalledProcessError as error:
            raise RecipeError('CONVERTER_INVALID', 'converter must belong to a pinned llama.cpp checkout') from error
        if dirty:
            raise RecipeError('CONVERTER_INVALID', 'converter checkout has tracked modifications')
        outtype = spec.get('outtype', 'f16')
        if outtype not in {'f32', 'f16', 'bf16', 'q8_0'}:
            raise ValueError('unsupported GGUF outtype')
        if spec.get('adapter_path'):
            from .models import load_model
            model, tokenizer, _ = load_model({**spec, 'device': 'cpu'}, workspace)
            merged = resolve_workspace_path(workspace, str(output.relative_to(workspace)) + '.merged', create_parent=True)
            model.save_pretrained(merged, safe_serialization=True)
            tokenizer.save_pretrained(merged)
            model_path = merged
        subprocess.run([sys.executable, str(converter), str(model_path), '--outfile', str(output), '--outtype', outtype], check=True)
        if output.open('rb').read(4) != b'GGUF':
            raise RecipeError('EXPORT_INVALID', 'converter did not produce GGUF output')
        result.update(converter_revision=revision, converter_sha256=sha256(converter), outtype=outtype)
    if not output.is_file() or output.stat().st_size == 0:
        raise RecipeError('EXPORT_INVALID', 'converter produced no output')
    result.update(sha256=sha256(output), bytes=output.stat().st_size, artifacts=[relative])
    return result
