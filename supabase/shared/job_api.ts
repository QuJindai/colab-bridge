import {
  isUuid,
  JOB_STATUSES,
  jobRequestHash,
  JobValidationError,
  normalizeJobRequest,
  TERMINAL_COMPLETION_STATUSES,
} from "./jobs.ts";

export const AGENT_JOB_OPERATIONS = new Set([
  "job_claim",
  "job_heartbeat",
  "job_log",
  "job_complete",
  "artifact_prepare",
  "artifact_complete",
]);
const LOG_STREAMS = new Set(["stdout", "stderr", "system"]);
const SHA256 = /^[0-9a-f]{64}$/;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const ARTIFACT_BUCKET = "colab-bridge-artifacts";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireUuid(value: unknown, field: string): asserts value is string {
  if (!isUuid(value)) throw new JobValidationError("INVALID_PAYLOAD", `${field} must be a UUID`);
}

function requireLeaseEnvelope(input: JsonObject): void {
  requireUuid(input.runtime_id, "runtime_id");
  requireUuid(input.job_id, "job_id");
  requireUuid(input.lease_token, "lease_token");
}

function validArtifactPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 512 || value.includes("\0") || value.includes("\\")) return false;
  if (value.startsWith("/") || value.endsWith("/")) return false;
  return value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function assertJson(value: unknown, field: string): void {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("not JSON");
  } catch {
    throw new JobValidationError("INVALID_PAYLOAD", `${field} must be JSON`);
  }
}

export function validateAgentJobBody(input: unknown): JsonObject {
  if (!isObject(input) || typeof input.op !== "string" || !AGENT_JOB_OPERATIONS.has(input.op)) {
    throw new JobValidationError("UNKNOWN_OPERATION", "operation is not a job operation");
  }
  requireUuid(input.runtime_id, "runtime_id");
  if (input.op === "job_claim") return input;
  requireLeaseEnvelope(input);
  if (input.op === "job_heartbeat" || input.op === "artifact_complete") {
    if (input.op === "artifact_complete") requireUuid(input.artifact_id, "artifact_id");
    return input;
  }
  if (input.op === "job_log") {
    if (!Number.isInteger(input.seq) || (input.seq as number) < 0) {
      throw new JobValidationError("INVALID_PAYLOAD", "seq must be a non-negative integer");
    }
    if (typeof input.stream !== "string" || !LOG_STREAMS.has(input.stream)) {
      throw new JobValidationError("INVALID_PAYLOAD", "stream is invalid");
    }
    if (typeof input.text !== "string" || input.text.length > 8192) {
      throw new JobValidationError("INVALID_PAYLOAD", "text must contain at most 8192 characters");
    }
  }
  if (input.op === "job_complete") {
    if (typeof input.status !== "string" || !TERMINAL_COMPLETION_STATUSES.has(input.status)) {
      throw new JobValidationError("INVALID_PAYLOAD", "status is not a terminal completion status");
    }
    if (input.result !== null && input.result !== undefined) assertJson(input.result, "result");
    if (input.exit_code !== null && input.exit_code !== undefined && !Number.isInteger(input.exit_code)) {
      throw new JobValidationError("INVALID_PAYLOAD", "exit_code must be an integer or null");
    }
    if (
      input.error_code !== null && input.error_code !== undefined &&
      (typeof input.error_code !== "string" || !ERROR_CODE.test(input.error_code))
    ) {
      throw new JobValidationError("INVALID_PAYLOAD", "error_code is invalid");
    }
  }
  if (input.op === "artifact_prepare") {
    if (!validArtifactPath(input.path)) throw new JobValidationError("INVALID_PAYLOAD", "artifact path must be relative");
    if (!Number.isSafeInteger(input.bytes) || (input.bytes as number) < 0) {
      throw new JobValidationError("INVALID_PAYLOAD", "bytes must be a non-negative safe integer");
    }
    if (typeof input.sha256 !== "string" || !SHA256.test(input.sha256)) {
      throw new JobValidationError("INVALID_PAYLOAD", "sha256 must be lowercase hexadecimal");
    }
    if (typeof input.mime_type !== "string" || input.mime_type.length < 1 || input.mime_type.length > 200 || /[\r\n]/.test(input.mime_type)) {
      throw new JobValidationError("INVALID_PAYLOAD", "mime_type is invalid");
    }
  }
  return input;
}

export function isAgentJobOperation(input: unknown): boolean {
  return isObject(input) && typeof input.op === "string" && AGENT_JOB_OPERATIONS.has(input.op);
}

type AgentJobService = Pick<
  JobService,
  "claim" | "heartbeat" | "log" | "complete" | "prepareArtifact" | "completeArtifact"
>;

export async function dispatchAgentJobOperation(service: AgentJobService, input: unknown): Promise<JsonObject> {
  const body = validateAgentJobBody(input);
  switch (body.op) {
    case "job_claim":
      return await service.claim(body.runtime_id);
    case "job_heartbeat":
      return await service.heartbeat(body);
    case "job_log":
      return await service.log(body);
    case "job_complete":
      return await service.complete(body);
    case "artifact_prepare":
      return await service.prepareArtifact(body);
    case "artifact_complete":
      return await service.completeArtifact(body);
    default:
      throw new JobValidationError("UNKNOWN_OPERATION", "operation is not a job operation");
  }
}

function resultObject(value: unknown): JsonObject | null {
  if (Array.isArray(value) && value.length === 1 && isObject(value[0])) return value[0];
  return isObject(value) ? value : null;
}

function publicArtifact(raw: unknown): JsonObject | null {
  if (!isObject(raw)) return null;
  const { storage_path: _privatePath, ...artifact } = raw;
  return artifact;
}

function publicJob(raw: unknown): JsonObject | null {
  if (!isObject(raw)) return null;
  const { lease_token: _leaseToken, request_hash: _requestHash, idempotency_key: _idempotencyKey, ...job } = raw;
  return job;
}

export class JobService {
  private db: any;

  constructor(db: any) {
    this.db = db;
  }

  private async rpc(name: string, args: JsonObject): Promise<JsonObject> {
    const { data, error } = await this.db.rpc(name, args);
    if (error) return { ok: false, error_code: "BACKEND_ERROR" };
    return resultObject(data) ?? { ok: false, error_code: "BACKEND_ERROR" };
  }

  private async safely(operation: () => Promise<JsonObject>): Promise<JsonObject> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof JobValidationError) return { ok: false, error_code: error.code };
      return { ok: false, error_code: "BACKEND_ERROR" };
    }
  }

  async submit(input: unknown): Promise<JsonObject> {
    return await this.safely(async () => {
      const job = normalizeJobRequest(input);
      const requestHash = await jobRequestHash(job);
      return await this.rpc("colab_bridge_submit_job", {
        p_kind: job.kind,
        p_spec: job.spec,
        p_project: job.project,
        p_timeout_seconds: job.timeout_seconds,
        p_runtime_id: job.runtime_id ?? null,
        p_require_gpu: job.require_gpu,
        p_idempotency_key: job.idempotency_key ?? null,
        p_request_hash: requestHash,
      });
    });
  }

  async list(filters: unknown = {}): Promise<JsonObject> {
    return await this.safely(async () => {
      if (!isObject(filters)) throw new JobValidationError("INVALID_FILTER", "filters must be an object");
      const limit = filters.limit ?? 50;
      if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 100) {
        throw new JobValidationError("INVALID_FILTER", "limit must be from 1 through 100");
      }
      if (filters.status !== undefined && (typeof filters.status !== "string" || !JOB_STATUSES.has(filters.status))) {
        throw new JobValidationError("INVALID_FILTER", "status is invalid");
      }
      if (filters.runtime_id !== undefined && !isUuid(filters.runtime_id)) throw new JobValidationError("INVALID_FILTER", "runtime_id is invalid");
      const result = await this.rpc("colab_bridge_list_jobs", {
        p_status: typeof filters.status === "string" ? filters.status : null,
        p_runtime_id: filters.runtime_id ?? null,
        p_limit: limit,
      });
      if (result.ok === true && Array.isArray(result.jobs)) {
        return { ...result, jobs: result.jobs.map(publicJob).filter(Boolean) };
      }
      return result;
    });
  }

  async status(id: unknown): Promise<JsonObject> {
    return await this.safely(async () => {
      requireUuid(id, "job_id");
      const result = await this.rpc("colab_bridge_get_job", { p_job_id: id });
      if (result.ok === true && isObject(result.job)) return { ...result, job: publicJob(result.job) };
      return result;
    });
  }

  async logs(id: unknown, after = -1, limit = 100): Promise<JsonObject> {
    return await this.safely(async () => {
      requireUuid(id, "job_id");
      if (!Number.isInteger(after) || after < -1 || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
        throw new JobValidationError("INVALID_FILTER", "log cursor or limit is invalid");
      }
      return await this.rpc("colab_bridge_job_logs", { p_job_id: id, p_after: after, p_limit: limit });
    });
  }

  async cancel(id: unknown): Promise<JsonObject> {
    return await this.safely(async () => {
      requireUuid(id, "job_id");
      return await this.rpc("colab_bridge_cancel_job", { p_job_id: id });
    });
  }

  async retry(id: unknown, key: unknown): Promise<JsonObject> {
    return await this.safely(async () => {
      requireUuid(id, "job_id");
      if (typeof key !== "string" || key.length < 1 || key.length > 200) {
        throw new JobValidationError("INVALID_JOB", "retry idempotency key is invalid");
      }
      return await this.rpc("colab_bridge_retry_job", { p_job_id: id, p_idempotency_key: key });
    });
  }

  async claim(runtimeId: unknown): Promise<JsonObject> {
    return await this.safely(async () => {
      requireUuid(runtimeId, "runtime_id");
      const result = await this.rpc("colab_bridge_claim_job", { p_runtime_id: runtimeId });
      if (result.ok !== true || !isObject(result.job) || result.job.restore_artifacts === undefined) return result;
      if (!Array.isArray(result.job.restore_artifacts)) return { ok: false, error_code: "BACKEND_ERROR" };
      const restoreArtifacts: JsonObject[] = [];
      for (const raw of result.job.restore_artifacts) {
        if (!isObject(raw) || typeof raw.storage_path !== "string") return { ok: false, error_code: "BACKEND_ERROR" };
        const downloadUrl = await this.createArtifactDownload(raw.storage_path);
        if (!downloadUrl) return { ok: false, error_code: "STORAGE_ERROR" };
        const artifact = publicArtifact(raw);
        if (!artifact) return { ok: false, error_code: "BACKEND_ERROR" };
        restoreArtifacts.push({ ...artifact, download_url: downloadUrl, expires_in: 300 });
      }
      return { ...result, job: { ...result.job, restore_artifacts: restoreArtifacts } };
    });
  }

  async heartbeat(body: unknown): Promise<JsonObject> {
    return await this.agentRpc("job_heartbeat", "colab_bridge_heartbeat_job", body);
  }

  async log(body: unknown): Promise<JsonObject> {
    return await this.agentRpc("job_log", "colab_bridge_append_job_log", body);
  }

  async complete(body: unknown): Promise<JsonObject> {
    return await this.agentRpc("job_complete", "colab_bridge_complete_job", body);
  }

  private async agentRpc(operation: string, rpcName: string, body: unknown): Promise<JsonObject> {
    return await this.safely(async () => {
      if (!isObject(body)) throw new JobValidationError("INVALID_PAYLOAD", "body must be an object");
      const input = validateAgentJobBody({ ...body, op: operation });
      const args: JsonObject = {
        p_runtime_id: input.runtime_id,
        p_job_id: input.job_id,
        p_lease_token: input.lease_token,
      };
      if (operation === "job_log") Object.assign(args, { p_seq: input.seq, p_stream: input.stream, p_text: input.text });
      if (operation === "job_complete") {
        Object.assign(args, {
          p_status: input.status,
          p_result: input.result ?? null,
          p_exit_code: input.exit_code ?? null,
          p_error_code: input.error_code ?? null,
        });
      }
      return await this.rpc(rpcName, args);
    });
  }

  private async createArtifactUpload(storagePath: string): Promise<string | null> {
    const { data, error } = await this.db.storage.from(ARTIFACT_BUCKET).createSignedUploadUrl(storagePath);
    return error || typeof data?.signedUrl !== "string" ? null : data.signedUrl;
  }

  async prepareArtifact(body: unknown): Promise<JsonObject> {
    return await this.safely(async () => {
      if (!isObject(body)) throw new JobValidationError("INVALID_PAYLOAD", "body must be an object");
      const input = validateAgentJobBody({ ...body, op: "artifact_prepare" });
      const prepared = await this.rpc("colab_bridge_prepare_artifact", {
        p_runtime_id: input.runtime_id,
        p_job_id: input.job_id,
        p_lease_token: input.lease_token,
        p_path: input.path,
        p_bytes: input.bytes,
        p_sha256: input.sha256,
        p_mime_type: input.mime_type,
      });
      if (prepared.ok !== true || typeof prepared.artifact_id !== "string" || typeof prepared.storage_path !== "string") return prepared;
      const uploadUrl = await this.createArtifactUpload(prepared.storage_path);
      if (!uploadUrl) return { ok: false, error_code: "STORAGE_ERROR" };
      return { ok: true, artifact_id: prepared.artifact_id, upload_url: uploadUrl, upload_method: "PUT" };
    });
  }

  private async artifactRecord(id: string): Promise<JsonObject> {
    return await this.rpc("colab_bridge_get_artifact", { p_artifact_id: id });
  }

  private async verifyArtifactUpload(artifact: JsonObject): Promise<boolean> {
    if (typeof artifact.storage_path !== "string" || !Number.isSafeInteger(artifact.bytes)) return false;
    const parts = artifact.storage_path.split("/");
    const filename = parts.pop();
    if (!filename) return false;
    const { data, error } = await this.db.storage.from(ARTIFACT_BUCKET).list(parts.join("/"), { search: filename, limit: 2 });
    if (error || !Array.isArray(data)) return false;
    const object = data.find((item: unknown) => isObject(item) && item.name === filename);
    if (!isObject(object) || !isObject(object.metadata)) return false;
    return Number(object.metadata.size) === artifact.bytes;
  }

  async completeArtifact(body: unknown): Promise<JsonObject> {
    return await this.safely(async () => {
      if (!isObject(body)) throw new JobValidationError("INVALID_PAYLOAD", "body must be an object");
      const input = validateAgentJobBody({ ...body, op: "artifact_complete" });
      const found = await this.artifactRecord(input.artifact_id as string);
      if (found.ok !== true || !isObject(found.artifact)) return found;
      if (found.artifact.job_id !== input.job_id) return { ok: false, error_code: "ARTIFACT_NOT_FOUND" };
      if (!(await this.verifyArtifactUpload(found.artifact))) return { ok: false, error_code: "ARTIFACT_UPLOAD_INCOMPLETE" };
      return await this.rpc("colab_bridge_publish_artifact", {
        p_runtime_id: input.runtime_id,
        p_job_id: input.job_id,
        p_lease_token: input.lease_token,
        p_artifact_id: input.artifact_id,
      });
    });
  }

  async artifacts(jobId: unknown): Promise<JsonObject> {
    return await this.safely(async () => {
      requireUuid(jobId, "job_id");
      const result = await this.rpc("colab_bridge_list_artifacts", { p_job_id: jobId });
      if (result.ok === true && Array.isArray(result.artifacts)) {
        return { ...result, artifacts: result.artifacts.map(publicArtifact).filter(Boolean) };
      }
      return result;
    });
  }

  private async createArtifactDownload(storagePath: string): Promise<string | null> {
    const { data, error } = await this.db.storage.from(ARTIFACT_BUCKET).createSignedUrl(storagePath, 300);
    return error || typeof data?.signedUrl !== "string" ? null : data.signedUrl;
  }

  async readArtifact(id: unknown): Promise<JsonObject> {
    return await this.safely(async () => {
      requireUuid(id, "artifact_id");
      const result = await this.artifactRecord(id);
      if (result.ok !== true || !isObject(result.artifact)) return result;
      if (result.artifact.status !== "published") return { ok: false, error_code: "ARTIFACT_NOT_READY" };
      const storagePath = result.artifact.storage_path;
      if (typeof storagePath !== "string") return { ok: false, error_code: "BACKEND_ERROR" };
      const downloadUrl = await this.createArtifactDownload(storagePath);
      if (!downloadUrl) return { ok: false, error_code: "STORAGE_ERROR" };
      return { ok: true, artifact: publicArtifact(result.artifact), download_url: downloadUrl, expires_in: 300 };
    });
  }
}
