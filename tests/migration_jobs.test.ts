import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync("supabase/migrations/20260912154108_colab_bridge_jobs.sql", "utf8");

function functionBody(name: string): string {
  const match = sql.match(new RegExp(`create function public\\.${name}[^]*?\\$\\$;`, "i"));
  assert.ok(match, `${name} function exists`);
  return match[0];
}

test("job schema protects every durable table with RLS and public revocation", () => {
  for (const table of ["colab_bridge_jobs", "colab_bridge_job_events", "colab_bridge_artifacts", "colab_bridge_lifecycle"]) {
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`, "i"), table);
    assert.match(sql, new RegExp(`revoke all on public\\.${table} from anon, authenticated`, "i"), table);
  }
});

test("claim RPC serializes each runtime and locks one eligible queue row", () => {
  assert.match(sql, /pg_advisory_xact_lock\s*\(\s*hashtextextended\s*\(\s*p_runtime_id::text\s*,\s*0\s*\)\s*\)/i);
  assert.match(sql, /status\s*=\s*'queued'[\s\S]*requested_runtime_id is null or requested_runtime_id\s*=\s*p_runtime_id[\s\S]*for update skip locked[\s\S]*limit 1/i);
  assert.match(sql, /execution_enabled[\s\S]*nvidia_gpu/i);
  assert.doesNotMatch(sql, /accelerator\s+in\s*\([^)]*'nvidia'/i);
});

test("lease writes and queue RPCs are service-role-only security invokers", () => {
  for (const fn of [
    "colab_bridge_reap_expired_jobs",
    "colab_bridge_claim_job",
    "colab_bridge_heartbeat_job",
    "colab_bridge_append_job_log",
    "colab_bridge_complete_job",
    "colab_bridge_prepare_artifact",
    "colab_bridge_publish_artifact",
  ]) {
    assert.match(sql, new RegExp(`function public\\.${fn}[\\s\\S]*?security invoker`, "i"), fn);
    assert.match(sql, new RegExp(`revoke all on function public\\.${fn}[\\s\\S]*?from public`, "i"), fn);
    assert.match(sql, new RegExp(`grant execute on function public\\.${fn}[\\s\\S]*?to service_role`, "i"), fn);
  }
});

test("events are deduplicated per job attempt and sequence", () => {
  assert.match(sql, /unique\s*\(\s*job_id\s*,\s*attempt\s*,\s*seq\s*\)/i);
  assert.match(sql, /on conflict\s*\(\s*job_id\s*,\s*attempt\s*,\s*seq\s*\)\s*do nothing/i);
});

test("retry hashing uses PostgreSQL core SHA-256 without extension schema lookup", () => {
  assert.match(sql, /pg_catalog\.sha256\s*\(\s*pg_catalog\.convert_to/i);
  assert.doesNotMatch(sql, /\bdigest\s*\(/i);
});

test("read and retry RPCs reap expired offline leases before returning", () => {
  assert.match(sql, /function public\.colab_bridge_reap_expired_jobs\(\)[\s\S]*lease_expires_at\s*<=\s*v_now/i);
  for (const fn of ["colab_bridge_list_jobs", "colab_bridge_get_job", "colab_bridge_retry_job"]) {
    assert.match(
      sql,
      new RegExp(`function public\\.${fn}[\\s\\S]*?perform public\\.colab_bridge_reap_expired_jobs\\(\\)`),
      fn,
    );
  }
});

test("claim and heartbeat capture lease timestamps only after blocking locks", () => {
  const claim = functionBody("colab_bridge_claim_job");
  assert.doesNotMatch(claim, /v_now\s+timestamptz\s*:=\s*clock_timestamp/i);
  assert.match(claim, /for update skip locked[\s\S]*v_now\s*:=\s*clock_timestamp\(\)[\s\S]*lease_expires_at\s*=\s*v_now\s*\+\s*interval '60 seconds'/i);

  const heartbeat = functionBody("colab_bridge_heartbeat_job");
  assert.doesNotMatch(heartbeat, /v_now\s+timestamptz\s*:=\s*clock_timestamp/i);
  assert.match(heartbeat, /where id\s*=\s*p_job_id for update[\s\S]*v_now\s*:=\s*clock_timestamp\(\)[\s\S]*lease_expires_at\s*<=\s*v_now/i);
});

test("submission affinity is separate from lease ownership and retry copies only affinity", () => {
  assert.match(sql, /requested_runtime_id\s+uuid\s+references public\.colab_bridge_runtimes/i);
  assert.match(functionBody("colab_bridge_submit_job"), /requested_runtime_id[\s\S]*p_runtime_id/);
  assert.match(functionBody("colab_bridge_claim_job"), /requested_runtime_id is null or requested_runtime_id\s*=\s*p_runtime_id/i);
  const retry = functionBody("colab_bridge_retry_job");
  assert.match(retry, /requested_runtime_id[\s\S]*v_source\.requested_runtime_id/i);
  assert.doesNotMatch(retry, /v_source\.runtime_id/);
});
