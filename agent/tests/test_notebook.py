import json
from pathlib import Path


def test_bootstrap_notebook_is_one_cell_and_secret_free():
    path = Path("notebooks/colab_bridge_bootstrap.ipynb")
    notebook = json.loads(path.read_text(encoding="utf-8"))
    code_cells = [cell for cell in notebook["cells"] if cell["cell_type"] == "code"]
    assert len(code_cells) == 1
    source = "".join(code_cells[0]["source"])
    assert "getpass" in source
    assert "COLAB_BRIDGE_AGENT_URL" in source
    assert "COLAB_BRIDGE_AGENT_KEY" in source
    assert "threading.Thread" in source
    assert "supabase.co" not in source
    assert "sb_secret_" not in source
    assert "service_role" not in source


def test_bootstrap_notebook_is_self_contained_without_github_dependency():
    path = Path("notebooks/colab_bridge_bootstrap.ipynb")
    notebook = json.loads(path.read_text(encoding="utf-8"))
    source = "".join(cell_source for cell in notebook["cells"] for cell_source in cell.get("source", []))
    assert "base64.b64decode" in source
    assert "hashlib.sha256" in source
    assert "git+https://github.com/QuJindai/colab-bridge.git" not in source


def test_generated_notebook_executes_with_actual_agent_config_without_network(monkeypatch):
    import getpass
    import os
    import sys
    import subprocess
    import threading
    from unittest.mock import Mock
    monkeypatch.setattr(os, "environ", {})
    for key in ('COLAB_BRIDGE_AGENT_URL', 'COLAB_BRIDGE_AGENT_KEY', 'COLAB_BRIDGE_EXECUTION_ENABLED'):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv('PRIVATE_API_TOKEN', 'must-not-reach-pip')
    monkeypatch.setenv('PIP_INDEX_URL', 'https://synthetic:password@example.test/simple')
    monkeypatch.setenv('HTTPS_PROXY', 'http://synthetic:password@proxy.test:8080')
    monkeypatch.setenv('HTTP_PROXY', 'http://proxy.test:8080')
    monkeypatch.setenv('SSL_CERT_FILE', '/configured/ca.pem')
    monkeypatch.setenv('COLAB_BRIDGE_RUNTIME_ID', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    prompts = iter(['https://example.test/agent', 'test-colab', 'yes'])
    monkeypatch.setattr('builtins.input', lambda _: next(prompts))
    monkeypatch.setattr(getpass, 'getpass', lambda _: 'runtime-only-secret')
    install = Mock()
    monkeypatch.setattr(subprocess, 'run', install)
    threads = []

    class Thread:
        def __init__(self, **kwargs):
            self.kwargs = kwargs
            threads.append(self)
        def start(self):
            pass
        def is_alive(self):
            return False
        def join(self, **kwargs):
            pass
    monkeypatch.setattr(threading, 'Thread', Thread)
    notebook = json.loads(Path('notebooks/colab_bridge_bootstrap.ipynb').read_text())
    code = ''.join(next(c for c in notebook['cells'] if c['cell_type'] == 'code')['source'])
    namespace = {}
    original_modules = {name: value for name, value in sys.modules.items() if name == 'colab_bridge_agent' or name.startswith('colab_bridge_agent.')}
    try:
        exec(compile(code, 'notebook', 'exec'), namespace)
    finally:
        for name in list(sys.modules):
            if name == 'colab_bridge_agent' or name.startswith('colab_bridge_agent.'):
                del sys.modules[name]
        sys.modules.update(original_modules)
    config = threads[0].kwargs['args'][0]
    assert config.execution_enabled is True
    assert config.runtime_id == 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    assert config.agent_key == 'runtime-only-secret'
    assert install.call_count == 2
    for call in install.call_args_list:
        assert "env" in call.kwargs
        assert "PRIVATE_API_TOKEN" not in call.kwargs["env"]
        assert "PIP_INDEX_URL" not in call.kwargs["env"]
        assert "HTTPS_PROXY" not in call.kwargs["env"]
        assert call.kwargs["env"]["HTTP_PROXY"] == "http://proxy.test:8080"
        assert call.kwargs["env"]["SSL_CERT_FILE"] == "/configured/ca.pem"
    assert '--no-deps' in install.call_args_list[1].args[0]
    namespace['stop_colab_bridge']()
    assert namespace['_colab_bridge_stop'].is_set()
