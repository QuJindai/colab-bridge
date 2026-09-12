import test from "node:test";
import assert from "node:assert/strict";
import {
  MCP_TOOL_CATALOG,
  buildGpuStatus,
  buildRuntimeStatus,
  sanitizeNvidiaSmi,
} from "../supabase/shared/mcp_tools.ts";

const now = new Date("2026-09-12T10:00:00.000Z");
const liveRuntime = {
  runtime_id: "11111111-1111-4111-8111-111111111111",
  label: "gpu-lab",
  accelerator: "nvidia_gpu",
  runtime_metadata: { python_version: "3.12" },
  created_at: "2026-09-12T09:00:00.000Z",
  last_heartbeat_at: "2026-09-12T09:59:40.000Z",
};

test("every MCP tool is explicitly read-only", () => {
  assert.equal(MCP_TOOL_CATALOG.length, 7);
  for (const tool of MCP_TOOL_CATALOG) {
    assert.equal(tool.annotations.readOnlyHint, true, tool.name);
    assert.equal(tool.annotations.destructiveHint, false, tool.name);
  }
});

test("gpu status distinguishes no runtime", () => {
  assert.deepEqual(buildGpuStatus(null, null, now), {
    ok: false,
    error_code: "NO_RUNTIME",
    message: "No Colab runtime has registered yet.",
  });
});

test("gpu status refuses to present stale telemetry as live", () => {
  const staleRuntime = { ...liveRuntime, last_heartbeat_at: "2026-09-12T09:58:00.000Z" };
  const snapshot = {
    observed_at: "2026-09-12T09:58:00.000Z",
    payload: { gpus: [{ index: 0, name: "NVIDIA L4" }] },
  };
  const result = buildGpuStatus(staleRuntime, snapshot, now);
  assert.equal(result.ok, false);
  assert.equal(result.error_code, "RUNTIME_STALE");
  assert.equal(result.status, "stale");
  assert.equal("gpus" in result, false);
});

test("gpu status reports live GPU payload with freshness", () => {
  const snapshot = {
    observed_at: "2026-09-12T09:59:50.000Z",
    payload: {
      accelerator: "nvidia_gpu",
      telemetry_available: true,
      error_code: null,
      gpus: [{ index: 0, name: "NVIDIA L4", memory_total_mib: 23034 }],
    },
  };
  const result = buildGpuStatus(liveRuntime, snapshot, now);
  assert.equal(result.ok, true);
  assert.equal(result.status, "live");
  assert.equal(result.age_seconds, 10);
  assert.deepEqual(result.gpus, [{ index: 0, name: "NVIDIA L4", memory_total_mib: 23034 }]);
});

test("gpu status reports NO_GPU for a live CPU runtime", () => {
  const snapshot = {
    observed_at: "2026-09-12T09:59:50.000Z",
    payload: { accelerator: "cpu", telemetry_available: false, error_code: "NO_GPU", gpus: [] },
  };
  const result = buildGpuStatus({ ...liveRuntime, accelerator: "cpu" }, snapshot, now);
  assert.equal(result.ok, false);
  assert.equal(result.error_code, "NO_GPU");
  assert.deepEqual(result.gpus, []);
});

test("runtime status includes heartbeat age and safe runtime metadata", () => {
  const snapshot = {
    observed_at: "2026-09-12T09:59:45.000Z",
    payload: { python_version: "3.12", platform: "Linux", pytorch_version: "2.8.0" },
  };
  const result = buildRuntimeStatus(liveRuntime, snapshot, now);
  assert.equal(result.ok, true);
  assert.equal(result.heartbeat_age_seconds, 20);
  assert.equal(result.age_seconds, 15);
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("nvidia smi sanitizer returns only predefined safe fields", () => {
  const gpuStatus = {
    ok: true,
    status: "live",
    runtime_id: liveRuntime.runtime_id,
    observed_at: "2026-09-12T09:59:50.000Z",
    age_seconds: 10,
    gpus: [{
      index: 0,
      name: "NVIDIA L4",
      uuid_suffix: "aaaa-bbbb",
      memory_total_mib: 23034,
      memory_used_mib: 1000,
      memory_free_mib: 22034,
      utilization_gpu_percent: 11,
      temperature_c: 43,
      power_draw_w: 72.5,
      power_limit_w: 300,
      driver_version: "555.42.02",
      cuda_version: "12.5",
      unexpected: "drop-me",
    }],
  };
  const result = sanitizeNvidiaSmi(gpuStatus as Record<string, unknown>);
  assert.equal(JSON.stringify(result).includes("unexpected"), false);
  assert.equal(result.gpus[0].driver_version, "555.42.02");
});

test("gpu status carries PyTorch CUDA availability and per-GPU compute capability", () => {
  const snapshot = {
    observed_at: "2026-09-12T09:59:50.000Z",
    payload: {
      accelerator: "nvidia_gpu",
      telemetry_available: true,
      error_code: null,
      pytorch_cuda_available: true,
      pytorch_cuda_version: "12.4",
      gpus: [{ index: 0, name: "NVIDIA L4", cuda_version: "12.5", compute_capability: "8.9" }],
    },
  };
  const result = buildGpuStatus(liveRuntime, snapshot, now);
  assert.equal(result.pytorch_cuda_available, true);
  assert.equal(result.pytorch_cuda_version, "12.4");
  assert.equal(result.gpus[0].compute_capability, "8.9");
});
