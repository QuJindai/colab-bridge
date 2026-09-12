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
