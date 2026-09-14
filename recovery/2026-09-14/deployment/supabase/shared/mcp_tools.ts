import { runtimeState } from "./freshness.ts";

import { EXECUTION_TOOL_NAMES, executionAnnotations } from "./execution_tools.ts";

export const TELEMETRY_TOOL_CATALOG = [
  { name: "colab_capabilities", annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "colab_list_runtimes", annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "colab_gpu_status", annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "colab_runtime_status", annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "colab_nvidia_smi", annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "colab_processes", annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "colab_health", annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
] as const;

export const MCP_TOOL_CATALOG = [
  ...TELEMETRY_TOOL_CATALOG,
  ...EXECUTION_TOOL_NAMES.map((name) => ({ name, annotations: executionAnnotations(name) })),
];

type RuntimeRow = {
  runtime_id: string;
  label?: string;
  accelerator?: string;
  runtime_metadata?: Record<string, unknown>;
  created_at?: string;
  last_heartbeat_at: string;
};

type SnapshotRow = {
  observed_at: string;
  payload: Record<string, unknown>;
};

function snapshotAge(observedAt: string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - new Date(observedAt).getTime()) / 1000));
}

export function buildGpuStatus(runtime: RuntimeRow | null, snapshot: SnapshotRow | null, now: Date = new Date()): Record<string, any> {
  if (!runtime) return { ok: false, error_code: "NO_RUNTIME", message: "No Colab runtime has registered yet." };
  const freshness = runtimeState(runtime.last_heartbeat_at, now);
  if (freshness.status !== "live") {
    return {
      ok: false,
      error_code: "RUNTIME_STALE",
      runtime_id: runtime.runtime_id,
      status: freshness.status,
      heartbeat_age_seconds: freshness.ageSeconds,
      last_observed_at: snapshot?.observed_at ?? null,
    };
  }
  if (!snapshot) {
    return {
      ok: false,
      error_code: "TELEMETRY_UNAVAILABLE",
      runtime_id: runtime.runtime_id,
      status: "live",
      heartbeat_age_seconds: freshness.ageSeconds,
    };
  }
  const payload = snapshot.payload ?? {};
  const gpus = Array.isArray(payload.gpus) ? payload.gpus : [];
  const base = {
    runtime_id: runtime.runtime_id,
    status: "live",
    heartbeat_age_seconds: freshness.ageSeconds,
    observed_at: snapshot.observed_at,
    age_seconds: snapshotAge(snapshot.observed_at, now),
    accelerator: payload.accelerator ?? runtime.accelerator ?? "unknown",
    pytorch_cuda_available: payload.pytorch_cuda_available ?? null,
    pytorch_cuda_version: payload.pytorch_cuda_version ?? null,
    gpus,
  };
  if (payload.error_code === "NO_GPU" || (base.accelerator === "cpu" && gpus.length === 0)) {
    return { ok: false, error_code: "NO_GPU", ...base };
  }
  if (payload.telemetry_available === false) {
    return { ok: false, error_code: "TELEMETRY_UNAVAILABLE", ...base };
  }
  return { ok: true, error_code: null, ...base };
}

export function buildRuntimeStatus(runtime: RuntimeRow | null, snapshot: SnapshotRow | null, now: Date = new Date()): Record<string, any> {
  if (!runtime) return { ok: false, error_code: "NO_RUNTIME", message: "No Colab runtime has registered yet." };
  const freshness = runtimeState(runtime.last_heartbeat_at, now);
  const base: Record<string, any> = {
    ok: freshness.status === "live",
    error_code: freshness.status === "live" ? null : "RUNTIME_STALE",
    runtime_id: runtime.runtime_id,
    label: runtime.label ?? "colab-runtime",
    accelerator: runtime.accelerator ?? "unknown",
    status: freshness.status,
    heartbeat_age_seconds: freshness.ageSeconds,
    last_heartbeat_at: runtime.last_heartbeat_at,
    created_at: runtime.created_at ?? null,
  };
  if (snapshot) {
    base.observed_at = snapshot.observed_at;
    base.age_seconds = snapshotAge(snapshot.observed_at, now);
    base.runtime = snapshot.payload;
  } else {
    base.observed_at = null;
    base.age_seconds = null;
    base.runtime = runtime.runtime_metadata ?? {};
  }
  return base;
}

const SAFE_GPU_FIELDS = [
  "index",
  "name",
  "uuid_suffix",
  "memory_total_mib",
  "memory_used_mib",
  "memory_free_mib",
  "utilization_gpu_percent",
  "temperature_c",
  "power_draw_w",
  "power_limit_w",
  "driver_version",
  "cuda_version",
] as const;

export function sanitizeNvidiaSmi(gpuStatus: Record<string, unknown>): Record<string, any> {
  const source = Array.isArray(gpuStatus.gpus) ? gpuStatus.gpus : [];
  const gpus = source.map((gpu) => {
    const input = (gpu && typeof gpu === "object") ? gpu as Record<string, unknown> : {};
    const safe: Record<string, unknown> = {};
    for (const key of SAFE_GPU_FIELDS) safe[key] = input[key] ?? null;
    return safe;
  });
  return {
    ok: gpuStatus.ok ?? false,
    error_code: gpuStatus.error_code ?? null,
    runtime_id: gpuStatus.runtime_id ?? null,
    status: gpuStatus.status ?? null,
    observed_at: gpuStatus.observed_at ?? null,
    age_seconds: gpuStatus.age_seconds ?? null,
    gpus,
  };
}

export function buildProcessesStatus(runtime: RuntimeRow | null, snapshot: SnapshotRow | null, now: Date = new Date()): Record<string, any> {
  if (!runtime) return { ok: false, error_code: "NO_RUNTIME", message: "No Colab runtime has registered yet." };
  const freshness = runtimeState(runtime.last_heartbeat_at, now);
  if (freshness.status !== "live") {
    return { ok: false, error_code: "RUNTIME_STALE", runtime_id: runtime.runtime_id, status: freshness.status, heartbeat_age_seconds: freshness.ageSeconds };
  }
  if (!snapshot) return { ok: false, error_code: "TELEMETRY_UNAVAILABLE", runtime_id: runtime.runtime_id, status: "live" };
  const payload = snapshot.payload ?? {};
  return {
    ok: payload.telemetry_available !== false,
    error_code: payload.telemetry_available === false ? (payload.error_code ?? "TELEMETRY_UNAVAILABLE") : null,
    runtime_id: runtime.runtime_id,
    status: "live",
    heartbeat_age_seconds: freshness.ageSeconds,
    observed_at: snapshot.observed_at,
    age_seconds: snapshotAge(snapshot.observed_at, now),
    processes: Array.isArray(payload.processes) ? payload.processes : [],
  };
}
