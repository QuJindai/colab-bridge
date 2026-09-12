from __future__ import annotations

import csv
import io
import re
import subprocess
from typing import Callable


def _clean(value: str) -> str:
    return value.strip()


def _int(value: str) -> int | None:
    v = _clean(value)
    if v in {"", "N/A", "[Not Supported]"}:
        return None
    return int(float(v))


def _float(value: str) -> float | None:
    v = _clean(value)
    if v in {"", "N/A", "[Not Supported]"}:
        return None
    return float(v)


def _uuid_suffix(value: str) -> str:
    value = _clean(value)
    if value.startswith("GPU-"):
        value = value[4:]
    parts = value.split("-")
    if len(parts) >= 2:
        return f"{parts[-2][-4:]}-{parts[-1]}"
    return value[-8:]


def parse_gpu_csv(text: str, *, cuda_version: str | None = None) -> list[dict]:
    rows: list[dict] = []
    for row in csv.reader(io.StringIO(text)):
        if not row or all(not cell.strip() for cell in row):
            continue
        rows.append(
            {
                "index": _int(row[0]),
                "name": _clean(row[1]),
                "uuid_suffix": _uuid_suffix(row[2]),
                "memory_total_mib": _int(row[3]),
                "memory_used_mib": _int(row[4]),
                "memory_free_mib": _int(row[5]),
                "utilization_gpu_percent": _int(row[6]),
                "temperature_c": _int(row[7]),
                "power_draw_w": _float(row[8]),
                "power_limit_w": _float(row[9]),
                "driver_version": _clean(row[10]),
                "cuda_version": cuda_version,
            }
        )
    return rows


def parse_process_csv(text: str) -> list[dict]:
    rows: list[dict] = []
    for row in csv.reader(io.StringIO(text)):
        if not row or all(not cell.strip() for cell in row):
            continue
        rows.append(
            {
                "gpu_index": _int(row[0]),
                "pid": _int(row[1]),
                "process_name": _clean(row[2]),
                "gpu_memory_mib": _int(row[3]),
            }
        )
    return rows


def _nvidia_cuda_version(*, runner: Callable = subprocess.run) -> str | None:
    try:
        completed = runner(
            ["nvidia-smi"],
            capture_output=True,
            text=True,
            check=True,
            timeout=5,
        )
    except (FileNotFoundError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return None
    match = re.search(r"CUDA Version:\s*([0-9]+(?:\.[0-9]+)*)", completed.stdout)
    return match.group(1) if match else None


def _torch_gpu_metadata() -> dict:
    try:
        import torch  # type: ignore
    except Exception:
        return {
            "pytorch_cuda_available": False,
            "pytorch_cuda_version": None,
            "compute_capabilities": {},
        }
    available = bool(torch.cuda.is_available())
    capabilities: dict[int, str] = {}
    if available:
        try:
            count = int(torch.cuda.device_count())
            for index in range(count):
                major, minor = torch.cuda.get_device_capability(index)
                capabilities[index] = f"{major}.{minor}"
        except Exception:
            capabilities = {}
    return {
        "pytorch_cuda_available": available,
        "pytorch_cuda_version": getattr(getattr(torch, "version", None), "cuda", None),
        "compute_capabilities": capabilities,
    }


def collect_gpu_snapshot(
    *,
    runner: Callable = subprocess.run,
    torch_probe: Callable[[], dict] = _torch_gpu_metadata,
) -> dict:
    query = (
        "index,name,uuid,memory.total,memory.used,memory.free,utilization.gpu,"
        "temperature.gpu,power.draw,power.limit,driver_version"
    )
    try:
        completed = runner(
            ["nvidia-smi", f"--query-gpu={query}", "--format=csv,noheader,nounits"],
            capture_output=True,
            text=True,
            check=True,
            timeout=5,
        )
    except (FileNotFoundError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return {
            "accelerator": "cpu",
            "gpus": [],
            "telemetry_available": False,
            "error_code": "NO_GPU",
            "pytorch_cuda_available": False,
            "pytorch_cuda_version": None,
        }

    cuda_version = _nvidia_cuda_version(runner=runner)
    try:
        torch_meta = torch_probe()
    except Exception:
        torch_meta = {
            "pytorch_cuda_available": False,
            "pytorch_cuda_version": None,
            "compute_capabilities": {},
        }
    gpus = parse_gpu_csv(completed.stdout, cuda_version=cuda_version)
    capabilities = torch_meta.get("compute_capabilities", {})
    if isinstance(capabilities, dict):
        for gpu in gpus:
            index = gpu.get("index")
            gpu["compute_capability"] = capabilities.get(index) if isinstance(index, int) else None

    return {
        "accelerator": "nvidia_gpu" if gpus else "cpu",
        "gpus": gpus,
        "telemetry_available": bool(gpus),
        "error_code": None if gpus else "NO_GPU",
        "pytorch_cuda_available": bool(torch_meta.get("pytorch_cuda_available", False)),
        "pytorch_cuda_version": torch_meta.get("pytorch_cuda_version"),
    }


def collect_process_snapshot(*, runner: Callable = subprocess.run) -> dict:
    try:
        gpu_inventory = runner(
            ["nvidia-smi", "--query-gpu=index,uuid", "--format=csv,noheader,nounits"],
            capture_output=True,
            text=True,
            check=True,
            timeout=5,
        )
        completed = runner(
            ["nvidia-smi", "--query-compute-apps=gpu_uuid,pid,process_name,used_gpu_memory", "--format=csv,noheader,nounits"],
            capture_output=True,
            text=True,
            check=True,
            timeout=5,
        )
    except (FileNotFoundError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return {"processes": [], "telemetry_available": False, "error_code": "TELEMETRY_UNAVAILABLE"}

    uuid_to_index: dict[str, int] = {}
    for row in csv.reader(io.StringIO(gpu_inventory.stdout)):
        if len(row) < 2:
            continue
        index = _int(row[0])
        uuid = _clean(row[1])
        if index is not None and uuid:
            uuid_to_index[uuid] = index

    processes = []
    for row in csv.reader(io.StringIO(completed.stdout)):
        if not row or all(not cell.strip() for cell in row):
            continue
        gpu_uuid = _clean(row[0])
        processes.append({
            "gpu_index": uuid_to_index.get(gpu_uuid),
            "pid": _int(row[1]),
            "process_name": _clean(row[2]),
            "gpu_memory_mib": _int(row[3]),
        })
    return {"processes": processes, "telemetry_available": True, "error_code": None}


def collect_runtime_snapshot() -> dict:
    import os
    import platform
    import time

    result = {
        "python_version": platform.python_version(),
        "platform": platform.platform(),
        "kernel": platform.release(),
        "machine": platform.machine(),
        "is_colab": bool(os.environ.get("COLAB_RELEASE_TAG") or os.environ.get("COLAB_BACKEND_VERSION")),
        "colab_release_tag": os.environ.get("COLAB_RELEASE_TAG"),
        "process_uptime_seconds": time.monotonic(),
    }
    try:
        import torch  # type: ignore
    except Exception:
        result.update({"pytorch_version": None, "pytorch_cuda_available": False, "pytorch_cuda_version": None})
    else:
        result.update({
            "pytorch_version": getattr(torch, "__version__", None),
            "pytorch_cuda_available": bool(torch.cuda.is_available()),
            "pytorch_cuda_version": getattr(getattr(torch, "version", None), "cuda", None),
        })
    return result
