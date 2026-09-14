#!/usr/bin/env python3
"""Generate the interactive notebook and provider payload from one wheel."""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
from pathlib import Path
from email.parser import BytesParser
import zipfile


# Shared verbatim by notebook and provider bootstrap; use synthetic-only environment tests.
INSTALL_ENV_SOURCE = r'''def _colab_bridge_install_env(source):
    from urllib.parse import unquote, urlsplit
    allowed = {
        'PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL',
        'SYSTEMROOT', 'WINDIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
        'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE',
        'PIP_INDEX_URL', 'PIP_EXTRA_INDEX_URL', 'PIP_FIND_LINKS', 'PIP_CERT',
    }
    url_options = {'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',
                   'PIP_INDEX_URL', 'PIP_EXTRA_INDEX_URL', 'PIP_FIND_LINKS'}
    clean = {}
    for name, value in source.items():
        upper = name.upper()
        if upper not in allowed or not isinstance(value, str):
            continue
        safe = True
        for part in value.split():
            decoded = unquote(part)
            if '://' not in decoded and upper not in url_options:
                continue
            # Proxy URLs may omit a scheme. Local find-links paths remain local paths.
            if upper == 'PIP_FIND_LINKS' and '://' not in decoded and '@' not in decoded:
                continue
            try:
                parsed = urlsplit(decoded if '://' in decoded else '//' + decoded)
                if (parsed.username is not None or parsed.password is not None
                        or parsed.query or parsed.fragment or not parsed.hostname):
                    safe = False
                    break
            except ValueError:
                safe = False
                break
        if safe:
            clean[name] = value
    return clean
'''


def wheel_metadata(path: Path) -> tuple[str, str]:
    with zipfile.ZipFile(path) as archive:
        required = {'colab_bridge_agent/main.py', 'colab_bridge_agent/config.py', 'colab_bridge_agent/jobs.py', 'colab_bridge_agent/recipes.py'}
        if not required.issubset(set(archive.namelist())):
            raise ValueError('Wheel is missing required Agent modules')
        metadata_names = [n for n in archive.namelist() if n.endswith('.dist-info/METADATA')]
        if len(metadata_names) != 1:
            raise ValueError('Wheel must contain exactly one package metadata file')
        metadata = BytesParser().parsebytes(archive.read(metadata_names[0]))
        if metadata['Name'] != 'colab-bridge-agent':
            raise ValueError('Unexpected wheel package')
        version = metadata['Version']
        if not version or not path.name.startswith('colab_bridge_agent-' + version + '-'):
            raise ValueError('Wheel filename/version mismatch')
        return metadata['Name'], version


def generate(wheel: Path, notebook: Path, bootstrap_module: Path) -> dict[str, object]:
    _, version = wheel_metadata(wheel)
    raw = wheel.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    encoded = base64.b64encode(raw).decode('ascii')
    source = f'''# Colab Bridge {version}; rerun this cell to replace a stopped Agent.
import base64, getpass, hashlib, os, re, subprocess, sys, tempfile, threading
from pathlib import Path
from urllib.parse import urlsplit

_previous_stop = globals().get('_colab_bridge_stop')
_previous_thread = globals().get('_colab_bridge_thread')
if _previous_stop is not None:
    _previous_stop.set()
if _previous_thread is not None and _previous_thread.is_alive():
    _previous_thread.join(timeout=20)
    if _previous_thread.is_alive():
        raise RuntimeError('Previous Agent is stopping; wait and rerun this cell.')

_wheel_bytes = base64.b64decode({encoded!r}, validate=True)
if hashlib.sha256(_wheel_bytes).hexdigest() != {digest!r}:
    raise RuntimeError('Embedded Agent checksum mismatch')
_wheel_path = Path(tempfile.mkdtemp(prefix='colab-bridge-install-')) / {wheel.name!r}
_wheel_path.write_bytes(_wheel_bytes)
{INSTALL_ENV_SOURCE}
_install_env = _colab_bridge_install_env(os.environ)
subprocess.run([sys.executable, '-m', 'pip', 'install', '--quiet',
                '--disable-pip-version-check', 'httpx==0.28.1'], check=True, env=_install_env)
subprocess.run([sys.executable, '-m', 'pip', 'install', '--quiet',
                '--disable-pip-version-check', '--no-deps', '--force-reinstall', str(_wheel_path)], check=True, env=_install_env)
for _module_name in list(sys.modules):
    if _module_name == 'colab_bridge_agent' or _module_name.startswith('colab_bridge_agent.'):
        del sys.modules[_module_name]

from colab_bridge_agent import __version__
from colab_bridge_agent.config import AgentConfig
from colab_bridge_agent.main import run_agent
if __version__ != {version!r}:
    raise RuntimeError('Installed Agent version mismatch')

_agent_url = os.environ.get('COLAB_BRIDGE_AGENT_URL') or input('Colab Bridge Agent URL: ').strip()
_parsed_url = urlsplit(_agent_url)
if (_parsed_url.scheme != 'https' or not _parsed_url.hostname or _parsed_url.username
        or _parsed_url.password or _parsed_url.query or _parsed_url.fragment):
    raise ValueError('Agent URL must be HTTPS without credentials, query or fragment')
_agent_key = os.environ.get('COLAB_BRIDGE_AGENT_KEY') or getpass.getpass('Colab Bridge Agent key: ')
_runtime_label = input('Runtime label [my-colab]: ').strip() or 'my-colab'
if len(_runtime_label) > 80 or any(ord(c) < 32 for c in _runtime_label):
    raise ValueError('Runtime label must contain at most 80 printable characters')
_runtime_id = os.environ.get('COLAB_BRIDGE_RUNTIME_ID') or None
_enable_execution = os.environ.get('COLAB_BRIDGE_EXECUTION_ENABLED') == '1'
if not _enable_execution:
    _enable_execution = input('Allow your control connection to run jobs? [y/N]: ').strip().lower() in ('y', 'yes')

# Remove optional environment credentials after configuration has been read.
os.environ.pop('COLAB_BRIDGE_AGENT_KEY', None)
_colab_bridge_stop = threading.Event()
_colab_bridge_config = AgentConfig(agent_url=_agent_url, agent_key=_agent_key,
                                  label=_runtime_label, runtime_id=_runtime_id, execution_enabled=_enable_execution)
_colab_bridge_thread = threading.Thread(target=run_agent,
    args=(_colab_bridge_config,), kwargs={{'stop_event': _colab_bridge_stop}}, daemon=True)
_colab_bridge_thread.start()

def stop_colab_bridge():
    _colab_bridge_stop.set()
    _colab_bridge_thread.join(timeout=20)
    print('Agent stopping.' if _colab_bridge_thread.is_alive() else 'Agent stopped.')

print('Colab Bridge Agent started in the background.')
print('Job execution enabled.' if _enable_execution else 'Telemetry enabled.')
print('Run stop_colab_bridge() to stop the Agent.')
'''
    # Configuration names are checked against the actual Agent during release.
    content = {
        'nbformat': 4, 'nbformat_minor': 5,
        'metadata': {'kernelspec': {'display_name': 'Python 3', 'language': 'python', 'name': 'python3'},
                     'colab': {'name': f'Colab Bridge {version}', 'provenance': []}},
        'cells': [
            {'cell_type': 'markdown', 'metadata': {}, 'source': [
                f'# Colab Bridge {version}\n',
                '连接当前运行时，上传资源状态，并按你的选择启用任务执行。\n',
                '需要 GPU 时，先在 Colab 的“更改运行时类型”中选择可用 GPU。\n',
                '运行下面的单元格，输入 Agent 地址与密钥；密钥输入不会显示。\n',
                '模型功能的可选依赖见仓库部署说明。停止 Agent：`stop_colab_bridge()`。\n',
            ]},
            {'cell_type': 'code', 'metadata': {}, 'execution_count': None, 'outputs': [],
             'source': source.splitlines(keepends=True)},
        ],
    }
    notebook.parent.mkdir(parents=True, exist_ok=True)
    notebook.write_text(json.dumps(content, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    bootstrap_module.parent.mkdir(parents=True, exist_ok=True)
    bootstrap_module.write_text(
        '// Generated by scripts/build_notebook.py. Do not edit embedded bytes.\n'
        + 'export const AGENT_VERSION = ' + json.dumps(version) + ';\n'
        + 'export const AGENT_WHEEL_FILENAME = ' + json.dumps(wheel.name) + ';\n'
        + 'export const AGENT_WHEEL_SHA256 = ' + json.dumps(digest) + ';\n'
        + 'export const AGENT_WHEEL_BASE64 = ' + json.dumps(encoded) + ';\n'
        + 'export const BOOTSTRAP_INSTALL_ENV_PYTHON = ' + json.dumps(INSTALL_ENV_SOURCE) + ';\n', encoding='utf-8')
    return {'version': version, 'wheel': wheel.name, 'bytes': len(raw), 'sha256': digest}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--wheel', type=Path, required=True)
    parser.add_argument('--notebook', type=Path, default=Path('notebooks/colab_bridge_bootstrap.ipynb'))
    parser.add_argument('--bootstrap-module', type=Path, default=Path('supabase/shared/bootstrap_payload.ts'))
    args = parser.parse_args()
    print(json.dumps(generate(args.wheel, args.notebook, args.bootstrap_module), sort_keys=True))


if __name__ == '__main__':
    main()
