import test from "node:test";
import assert from "node:assert/strict";
import {
  assertLease,
  jobRequestHash,
  isTerminal,
  normalizeJobRequest,
  validateJobRequest,
} from "../supabase/shared/jobs.ts";
import { JobService, validateAgentJobBody } from "../supabase/shared/job_api.ts";

const RUNTIME_ID = "11111111-1111-4111-8111-111111111111";
const LEASE_TOKEN = "22222222-2222-4222-8222-222222222222";
const REQUEST = {
  kind: "python",
  spec: { code: "print(1)", args: ["--quiet"] },
  project: "demo",
};

test("job validation rejects project traversal", () => {
  assert.throws(() => validateJobRequest({ kind: "python", spec: { code: "print(1)" }, project: "../escape" }));
});

test("job validation rejects timeouts above one hour", () => {
  assert.throws(() => validateJobRequest({ kind: "shell", spec: { command: "true" }, timeout_seconds: 3601 }));
});

test("lease assertion rejects an expired lease", () => {
  assert.throws(() => assertLease(
    {
      runtime_id: RUNTIME_ID,
      lease_token: LEASE_TOKEN,
      lease_expires_at: "2026-01-01T00:00:00Z",
      status: "running",
    },
    RUNTIME_ID,
    LEASE_TOKEN,
    new Date("2026-01-01T00:01:01Z"),
  ));
});

test("normalized job requests have a stable canonical hash", async () => {
  assert.equal(
    await jobRequestHash(normalizeJobRequest(REQUEST)),
    await jobRequestHash(normalizeJobRequest({ ...REQUEST })),
  );
});

test("normalization applies the durable execution defaults", () => {
  assert.deepEqual(normalizeJobRequest({ kind: "python", spec: {} }), {
    kind: "python",
    spec: {},
    project: "default",
    timeout_seconds: 900,
    require_gpu: false,
  });
  assert.equal(isTerminal("lost"), true);
  assert.equal(isTerminal("cancelling"), false);
});

test("agent job validation bounds log chunks", () => {
  assert.throws(() => validateAgentJobBody({
    op: "job_log",
    runtime_id: RUNTIME_ID,
    job_id: "33333333-3333-4333-8333-333333333333",
    lease_token: LEASE_TOKEN,
    seq: 1,
    stream: "stdout",
    text: "x".repeat(8193),
  }));
});

type RpcResult = { data: unknown; error: null | { message: string } };

class FakeJobDatabase {
  jobs = new Map<string, Record<string, unknown>>();
  events = new Map<string, Record<string, unknown>>();
  artifacts = new Map<string, Record<string, unknown>>();
  calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  nextJob = 1;

  storage = {
    from: (_bucket: string) => ({
      createSignedUploadUrl: async (_path: string) => ({ data: { signedUrl: "https://storage.test/upload-token" }, error: null }),
      createSignedUrl: async (_path: string, _seconds: number) => ({ data: { signedUrl: "https://storage.test/download-token" }, error: null }),
      list: async (prefix: string, options: { search?: string }) => {
        const artifact = [...this.artifacts.values()].find((item) => {
          const storagePath = item.storage_path as string;
          return storagePath.startsWith(`${prefix}/`) && storagePath.split("/").at(-1) === options.search;
        });
        if (!artifact || artifact.storage_exists === false) return { data: [], error: null };
        return {
          data: [{
            name: (artifact.storage_path as string).split("/").at(-1),
            metadata: { size: artifact.storage_size ?? artifact.bytes },
          }],
          error: null,
        };
      },
    }),
  };

  async rpc(name: string, args: Record<string, unknown>): Promise<RpcResult> {
    this.calls.push({ name, args });
    if (name === "colab_bridge_submit_job") {
      const key = args.p_idempotency_key as string | null;
      const existing = [...this.jobs.values()].find((job) => key && job.idempotency_key === key);
      if (existing) {
        if (existing.request_hash !== args.p_request_hash) {
          return { data: { ok: false, error_code: "IDEMPOTENCY_CONFLICT" }, error: null };
        }
        return { data: { ok: true, job_id: existing.id, status: existing.status, idempotent: true }, error: null };
      }
      const id = `00000000-0000-4000-8000-${String(this.nextJob++).padStart(12, "0")}`;
      const job = {
        id,
        kind: args.p_kind,
        spec: args.p_spec,
        project: args.p_project,
        timeout_seconds: args.p_timeout_seconds,
        runtime_id: args.p_runtime_id,
        require_gpu: args.p_require_gpu,
        idempotency_key: key,
        request_hash: args.p_request_hash,
        status: "queued",
        attempt: 1,
      };
      this.jobs.set(id, job);
      return { data: { ok: true, job_id: id, status: "queued", idempotent: false }, error: null };
    }
    if (name === "colab_bridge_list_jobs") {
      return { data: { ok: true, jobs: [...this.jobs.values()] }, error: null };
    }
    if (name === "colab_bridge_get_job") {
      const job = this.jobs.get(args.p_job_id as string);
      return { data: job ? { ok: true, job } : { ok: false, error_code: "JOB_NOT_FOUND" }, error: null };
    }
    if (name === "colab_bridge_job_logs") {
      return { data: { ok: true, events: [...this.events.values()] }, error: null };
    }
    if (name === "colab_bridge_cancel_job") {
      const job = this.jobs.get(args.p_job_id as string);
      if (!job) return { data: { ok: false, error_code: "JOB_NOT_FOUND" }, error: null };
      if (!isTerminal(job.status)) job.status = job.status === "queued" ? "cancelled" : "cancelling";
      return { data: { ok: true, job_id: job.id, status: job.status }, error: null };
    }
    if (name === "colab_bridge_retry_job") {
      const source = this.jobs.get(args.p_job_id as string);
      if (!source || !isTerminal(source.status)) return { data: { ok: false, error_code: "JOB_NOT_TERMINAL" }, error: null };
      const id = `00000000-0000-4000-8000-${String(this.nextJob++).padStart(12, "0")}`;
      this.jobs.set(id, { ...source, id, status: "queued", attempt: (source.attempt as number) + 1, parent_job_id: source.id });
      return { data: { ok: true, job_id: id, status: "queued" }, error: null };
    }
    if (name === "colab_bridge_claim_job") {
      const job = [...this.jobs.values()].find((item) => item.status === "queued");
      if (!job) return { data: { ok: true, job: null }, error: null };
      Object.assign(job, { status: "running", runtime_id: args.p_runtime_id, lease_token: LEASE_TOKEN });
      return { data: { ok: true, job }, error: null };
    }
    if (name === "colab_bridge_heartbeat_job") {
      return { data: { ok: true, lease_valid: true, cancel_requested: false }, error: null };
    }
    if (name === "colab_bridge_append_job_log") {
      const key = `${args.p_job_id}:${args.p_seq}`;
      if (!this.events.has(key)) this.events.set(key, { seq: args.p_seq, stream: args.p_stream, text: args.p_text });
      return { data: { ok: true }, error: null };
    }
    if (name === "colab_bridge_complete_job") {
      const job = this.jobs.get(args.p_job_id as string);
      if (!job || isTerminal(job.status)) return { data: { ok: false, error_code: "LEASE_INVALID" }, error: null };
      job.status = args.p_status;
      return { data: { ok: true, job_id: job.id, status: job.status }, error: null };
    }
    if (name === "colab_bridge_prepare_artifact") {
      const artifactId = "44444444-4444-4444-8444-444444444444";
      const storagePath = `${args.p_runtime_id}/${args.p_job_id}/${artifactId}-result.json`;
      this.artifacts.set(artifactId, {
        id: artifactId,
        job_id: args.p_job_id,
        path: args.p_path,
        bytes: args.p_bytes,
        sha256: args.p_sha256,
        mime_type: args.p_mime_type,
        status: "prepared",
        storage_path: storagePath,
      });
      return { data: { ok: true, artifact_id: artifactId, storage_path: storagePath }, error: null };
    }
    if (name === "colab_bridge_get_artifact") {
      const artifact = this.artifacts.get(args.p_artifact_id as string);
      return { data: artifact ? { ok: true, artifact } : { ok: false, error_code: "ARTIFACT_NOT_FOUND" }, error: null };
    }
    if (name === "colab_bridge_publish_artifact") {
      const artifact = this.artifacts.get(args.p_artifact_id as string)!;
      artifact.status = "published";
      return { data: { ok: true, artifact_id: artifact.id }, error: null };
    }
    if (name === "colab_bridge_list_artifacts") {
      return { data: { ok: true, artifacts: [...this.artifacts.values()] }, error: null };
    }
    return { data: null, error: { message: "unhandled fake RPC" } };
  }
}

test("submit is idempotent only for the same normalized payload", async () => {
  const db = new FakeJobDatabase();
  const service = new JobService(db);
  const first = await service.submit({ ...REQUEST, idempotency_key: "request-1" });
  const duplicate = await service.submit({ ...REQUEST, idempotency_key: "request-1" });
  const conflict = await service.submit({ ...REQUEST, spec: { code: "print(2)" }, idempotency_key: "request-1" });
  assert.equal(first.ok, true);
  assert.equal(duplicate.idempotent, true);
  assert.deepEqual(conflict, { ok: false, error_code: "IDEMPOTENCY_CONFLICT" });
});

test("cancel preserves terminal jobs and retry creates linked audit history", async () => {
  const db = new FakeJobDatabase();
  const service = new JobService(db);
  const submitted = await service.submit(REQUEST);
  assert.equal((await service.cancel(submitted.job_id as string)).status, "cancelled");
  assert.equal((await service.cancel(submitted.job_id as string)).status, "cancelled");
  const retried = await service.retry(submitted.job_id as string, "retry-1");
  const retriedStatus = await service.status(retried.job_id as string);
  assert.equal(retriedStatus.job.parent_job_id, submitted.job_id);
  assert.equal(retriedStatus.job.attempt, 2);
});

test("job listing rejects unknown states instead of silently returning an empty list", async () => {
  const db = new FakeJobDatabase();
  const response = await new JobService(db).list({ status: "finished" });
  assert.deepEqual(response, { ok: false, error_code: "INVALID_FILTER" });
  assert.equal(db.calls.length, 0);
});

test("claimed job operations are RPC fenced and duplicate log events are idempotent", async () => {
  const db = new FakeJobDatabase();
  const service = new JobService(db);
  await service.submit(REQUEST);
  const claimed = await service.claim(RUNTIME_ID);
  const jobId = claimed.job.id as string;
  assert.equal((await service.heartbeat({ runtime_id: RUNTIME_ID, job_id: jobId, lease_token: LEASE_TOKEN })).lease_valid, true);
  const log = { runtime_id: RUNTIME_ID, job_id: jobId, lease_token: LEASE_TOKEN, seq: 7, stream: "stdout", text: "ready" };
  assert.equal((await service.log(log)).ok, true);
  assert.equal((await service.log(log)).ok, true);
  assert.equal((await service.logs(jobId, 0, 100)).events.length, 1);
  assert.equal((await service.complete({ runtime_id: RUNTIME_ID, job_id: jobId, lease_token: LEASE_TOKEN, status: "succeeded", result: {}, exit_code: 0, error_code: null })).ok, true);
  assert.deepEqual(
    await service.complete({ runtime_id: RUNTIME_ID, job_id: jobId, lease_token: LEASE_TOKEN, status: "failed", result: null, exit_code: 1, error_code: "FAILED" }),
    { ok: false, error_code: "LEASE_INVALID" },
  );
});

test("artifact publication verifies private Storage size and returns only signed URLs", async () => {
  const db = new FakeJobDatabase();
  const service = new JobService(db);
  await service.submit(REQUEST);
  const claimed = await service.claim(RUNTIME_ID);
  const prepared = await service.prepareArtifact({
    runtime_id: RUNTIME_ID,
    job_id: claimed.job.id,
    lease_token: LEASE_TOKEN,
    path: "outputs/result.json",
    bytes: 12,
    sha256: "a".repeat(64),
    mime_type: "application/json",
  });
  assert.deepEqual(prepared, {
    ok: true,
    artifact_id: "44444444-4444-4444-8444-444444444444",
    upload_url: "https://storage.test/upload-token",
    upload_method: "PUT",
  });
  assert.equal((await service.completeArtifact({ runtime_id: RUNTIME_ID, job_id: claimed.job.id, lease_token: LEASE_TOKEN, artifact_id: prepared.artifact_id })).ok, true);
  assert.equal((await service.artifacts(claimed.job.id)).artifacts.length, 1);
  const read = await service.readArtifact(prepared.artifact_id as string);
  assert.equal(read.download_url, "https://storage.test/download-token");
  assert.equal(JSON.stringify(read).includes("storage_path"), false);
});

test("artifact publication rejects missing or wrong-sized Storage objects", async () => {
  const db = new FakeJobDatabase();
  const service = new JobService(db);
  await service.submit(REQUEST);
  const claimed = await service.claim(RUNTIME_ID);
  const prepared = await service.prepareArtifact({
    runtime_id: RUNTIME_ID,
    job_id: claimed.job.id,
    lease_token: LEASE_TOKEN,
    path: "outputs/result.json",
    bytes: 12,
    sha256: "b".repeat(64),
    mime_type: "application/json",
  });
  db.artifacts.get(prepared.artifact_id as string)!.storage_size = 11;
  assert.deepEqual(
    await service.completeArtifact({ runtime_id: RUNTIME_ID, job_id: claimed.job.id, lease_token: LEASE_TOKEN, artifact_id: prepared.artifact_id }),
    { ok: false, error_code: "ARTIFACT_UPLOAD_INCOMPLETE" },
  );
});

test("repository errors are returned as stable error codes without raw details", async () => {
  const db = new FakeJobDatabase();
  db.rpc = async () => ({ data: null, error: { message: "postgres password=very-secret" } });
  const response = await new JobService(db).list({});
  assert.deepEqual(response, { ok: false, error_code: "BACKEND_ERROR" });
  assert.equal(JSON.stringify(response).includes("very-secret"), false);
});
