import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync("supabase/migrations/20260912154108_colab_bridge_jobs.sql", "utf8");

test("job schema protects every durable table with RLS and public revocation", () => {
  for (const table of ["colab_bridge_jobs", "colab_bridge_job_events", "colab_bridge_artifacts", "colab_bridge_lifecycle"]) {
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`, "i"), table);
    assert.match(sql, new RegExp(`revoke all on public\\.${table} from anon, authenticated`, "i"), table);
  }
});

test("claim RPC serializes each runtime and locks one eligible queue row", () => {
  assert.match(sql, /pg_advisory_xact_lock\s*\(\s*hashtextextended\s*\(\s*p_runtime_id::text\s*,\s*0\s*\)\s*\)/i);
  assert.match(sql, /status\s*=\s*'queued'[\s\S]*runtime_id is null or runtime_id\s*=\s*p_runtime_id[\s\S]*for update skip locked[\s\S]*limit 1/i);
  assert.match(sql, /execution_enabled[\s\S]*nvidia_gpu/i);
});

test("lease writes and queue RPCs are service-role-only security invokers", () => {
  for (const fn of [
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
