export const JOB_KINDS = new Set([
  "python",
  "shell",
  "pip",
  "git",
  "model_download",
  "benchmark",
  "lora",
  "export",
  "file",
  "drive_export",
  "pipeline",
]);

export const JOB_STATUSES = new Set([
  "queued",
  "running",
  "cancelling",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "lost",
]);

export const TERMINAL_JOB_STATUSES = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "lost",
]);

export const TERMINAL_COMPLETION_STATUSES = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
]);

const PROJECT_SLUG = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class JobValidationError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "JobValidationError";
    this.code = code;
  }
}

export type NormalizedJobRequest = {
  kind: string;
  spec: Record<string, unknown>;
  project: string;
  timeout_seconds: number;
  require_gpu: boolean;
  runtime_id?: string;
  idempotency_key?: string;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function assertJsonValue(value: unknown, path: string): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) assertJsonValue(value[index], `${path}[${index}]`);
    return;
  }
  if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) assertJsonValue(child, `${path}.${key}`);
    return;
  }
  throw new JobValidationError("INVALID_JOB", `${path} must contain only JSON values`);
}

export function validateJobRequest(input: unknown): asserts input is Record<string, unknown> {
  if (!isObject(input)) throw new JobValidationError("INVALID_JOB", "job request must be an object");
  if (typeof input.kind !== "string" || !JOB_KINDS.has(input.kind)) {
    throw new JobValidationError("INVALID_JOB", "job kind is not supported");
  }
  if (!isObject(input.spec)) throw new JobValidationError("INVALID_JOB", "spec must be an object");
  assertJsonValue(input.spec, "spec");
  const project = input.project ?? "default";
  if (typeof project !== "string" || !PROJECT_SLUG.test(project)) {
    throw new JobValidationError("INVALID_JOB", "project must be a safe slug");
  }
  const timeout = input.timeout_seconds ?? 900;
  if (!Number.isInteger(timeout) || (timeout as number) < 1 || (timeout as number) > 3600) {
    throw new JobValidationError("INVALID_JOB", "timeout_seconds must be an integer from 1 through 3600");
  }
  if (input.runtime_id !== undefined && !isUuid(input.runtime_id)) {
    throw new JobValidationError("INVALID_JOB", "runtime_id must be a UUID");
  }
  if (input.require_gpu !== undefined && typeof input.require_gpu !== "boolean") {
    throw new JobValidationError("INVALID_JOB", "require_gpu must be a boolean");
  }
  if (
    input.idempotency_key !== undefined &&
    (typeof input.idempotency_key !== "string" || input.idempotency_key.length < 1 || input.idempotency_key.length > 200)
  ) {
    throw new JobValidationError("INVALID_JOB", "idempotency_key must contain 1 through 200 characters");
  }
}

export function normalizeJobRequest(input: unknown): NormalizedJobRequest {
  validateJobRequest(input);
  const normalized: NormalizedJobRequest = {
    kind: input.kind as string,
    spec: input.spec as Record<string, unknown>,
    project: (input.project as string | undefined) ?? "default",
    timeout_seconds: (input.timeout_seconds as number | undefined) ?? 900,
    require_gpu: (input.require_gpu as boolean | undefined) ?? false,
  };
  if (input.runtime_id !== undefined) normalized.runtime_id = input.runtime_id as string;
  if (input.idempotency_key !== undefined) normalized.idempotency_key = input.idempotency_key as string;
  return normalized;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

export async function jobRequestHash(input: unknown): Promise<string> {
  assertJsonValue(input, "request");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(input)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function isTerminal(status: unknown): boolean {
  return typeof status === "string" && TERMINAL_JOB_STATUSES.has(status);
}

export function assertLease(
  job: Record<string, unknown> | null | undefined,
  runtimeId: string,
  token: string,
  now = new Date(),
): void {
  if (!job || job.runtime_id !== runtimeId || job.lease_token !== token) {
    throw new JobValidationError("LEASE_INVALID", "lease does not match this runtime and job");
  }
  if (job.status !== "running" && job.status !== "cancelling") {
    throw new JobValidationError("LEASE_INVALID", "job has no active lease");
  }
  const expiresAt = typeof job.lease_expires_at === "string" ? Date.parse(job.lease_expires_at) : Number.NaN;
  if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) {
    throw new JobValidationError("LEASE_EXPIRED", "lease has expired");
  }
}
