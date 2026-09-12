from colab_bridge_agent.probes import (
    parse_gpu_csv,
    parse_process_csv,
    collect_gpu_snapshot,
)

GPU_CSV = """0, NVIDIA L4, GPU-aaaaaaaa-bbbb, 23034, 1000, 22034, 11, 43, 72.5, 300.0, 555.42.02\n1, NVIDIA T4, GPU-cccccccc-dddd, 15360, 2048, 13312, 27, 51, 66.0, 70.0, 555.42.02\n"""

PROCESS_CSV = """0, 1234, python, 512\n1, 5678, python3, 1024\n"""


def test_parse_gpu_csv_returns_structured_multi_gpu_rows():
    rows = parse_gpu_csv(GPU_CSV, cuda_version="12.5")
    assert rows == [
        {
            "index": 0,
            "name": "NVIDIA L4",
            "uuid_suffix": "aaaa-bbbb",
            "memory_total_mib": 23034,
            "memory_used_mib": 1000,
            "memory_free_mib": 22034,
            "utilization_gpu_percent": 11,
            "temperature_c": 43,
            "power_draw_w": 72.5,
            "power_limit_w": 300.0,
            "driver_version": "555.42.02",
            "cuda_version": "12.5",
        },
        {
            "index": 1,
            "name": "NVIDIA T4",
            "uuid_suffix": "cccc-dddd",
            "memory_total_mib": 15360,
            "memory_used_mib": 2048,
            "memory_free_mib": 13312,
            "utilization_gpu_percent": 27,
            "temperature_c": 51,
            "power_draw_w": 66.0,
            "power_limit_w": 70.0,
            "driver_version": "555.42.02",
            "cuda_version": "12.5",
        },
    ]


def test_parse_process_csv_returns_only_safe_process_fields():
    rows = parse_process_csv(PROCESS_CSV)
    assert rows == [
        {"gpu_index": 0, "pid": 1234, "process_name": "python", "gpu_memory_mib": 512},
        {"gpu_index": 1, "pid": 5678, "process_name": "python3", "gpu_memory_mib": 1024},
    ]


def test_collect_gpu_snapshot_reports_cpu_only_when_nvidia_smi_missing():
    def runner(*args, **kwargs):
        raise FileNotFoundError("nvidia-smi")

    result = collect_gpu_snapshot(runner=runner)
    assert result["accelerator"] == "cpu"
    assert result["gpus"] == []
    assert result["telemetry_available"] is False
    assert result["error_code"] == "NO_GPU"


def test_collect_process_snapshot_parses_safe_fields():
    class Result:
        def __init__(self, stdout):
            self.stdout = stdout

    def runner(args, **kwargs):
        if "--query-gpu=index,uuid" in args:
            return Result("0, GPU-aaaaaaaa-bbbb\n")
        return Result("GPU-aaaaaaaa-bbbb, 2468, python, 777\n")

    from colab_bridge_agent.probes import collect_process_snapshot

    result = collect_process_snapshot(runner=runner)
    assert result == {
        "processes": [
            {"gpu_index": 0, "pid": 2468, "process_name": "python", "gpu_memory_mib": 777}
        ],
        "telemetry_available": True,
        "error_code": None,
    }


def test_collect_runtime_snapshot_is_secret_free_and_marks_colab(monkeypatch):
    monkeypatch.setenv("COLAB_RELEASE_TAG", "release-20260912")
    monkeypatch.setenv("SECRET_TOKEN", "must-not-leak")
    from colab_bridge_agent.probes import collect_runtime_snapshot

    result = collect_runtime_snapshot()
    assert result["is_colab"] is True
    assert result["python_version"]
    assert result["platform"]
    assert "environment" not in result
    assert "SECRET_TOKEN" not in repr(result)


def test_collect_gpu_snapshot_includes_nvidia_cuda_and_torch_compute_capability():
    calls = []

    class Result:
        def __init__(self, stdout):
            self.stdout = stdout

    def runner(args, **kwargs):
        calls.append(args)
        if args == ["nvidia-smi"]:
            return Result("NVIDIA-SMI 555.42.02    Driver Version: 555.42.02    CUDA Version: 12.5\n")
        if args[0] == "nvidia-smi" and args[1].startswith("--query-gpu="):
            return Result("0, NVIDIA L4, GPU-aaaaaaaa-bbbb, 23034, 1000, 22034, 11, 43, 72.5, 300.0, 555.42.02\n")
        raise AssertionError(args)

    def torch_probe():
        return {
            "pytorch_cuda_available": True,
            "pytorch_cuda_version": "12.4",
            "compute_capabilities": {0: "8.9"},
        }

    result = collect_gpu_snapshot(runner=runner, torch_probe=torch_probe)

    assert result["pytorch_cuda_available"] is True
    assert result["pytorch_cuda_version"] == "12.4"
    assert result["gpus"][0]["cuda_version"] == "12.5"
    assert result["gpus"][0]["compute_capability"] == "8.9"
    assert ["nvidia-smi"] in calls


def test_collect_process_snapshot_maps_gpu_uuid_to_index_and_uses_supported_memory_field():
    from colab_bridge_agent.probes import collect_process_snapshot

    calls = []

    class Result:
        def __init__(self, stdout):
            self.stdout = stdout

    def runner(args, **kwargs):
        calls.append(args)
        if "--query-gpu=index,uuid" in args:
            return Result("0, GPU-aaaaaaaa-bbbb\n1, GPU-cccccccc-dddd\n")
        if "--query-compute-apps=gpu_uuid,pid,process_name,used_gpu_memory" in args:
            return Result("GPU-cccccccc-dddd, 2468, python, 777\n")
        raise AssertionError(args)

    result = collect_process_snapshot(runner=runner)

    assert result == {
        "processes": [
            {"gpu_index": 1, "pid": 2468, "process_name": "python", "gpu_memory_mib": 777}
        ],
        "telemetry_available": True,
        "error_code": None,
    }
    assert any("--query-compute-apps=gpu_uuid,pid,process_name,used_gpu_memory" in call for call in calls)
