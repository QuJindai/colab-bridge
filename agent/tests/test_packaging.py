from pathlib import Path
import tomllib


def test_wheel_package_discovery_excludes_test_modules():
    config = tomllib.loads(Path("pyproject.toml").read_text())
    finder = config["tool"]["setuptools"]["packages"]["find"]
    assert finder["include"] == ["colab_bridge_agent*"]
