import test from "node:test";
import assert from "node:assert/strict";
import * as z from "zod";
import { registerExecutionTools } from "../supabase/shared/execution_tools.ts";
import { executionSchemas } from "../supabase/shared/execution_schemas.ts";
import { authenticateBridge } from "../supabase/shared/auth.ts";
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
test("24 execution tools validate specs and every write enforces control", async () => {
  const tools: any[] = [];
  registerExecutionTools({ registerTool: (...a: any[]) => tools.push(a) }, {
    db: {},
    role: "read",
    lifecycle: {},
    z,
  });
  assert.equal(tools.length, 24);
  for (const [name, options, handler] of tools) {
    if (!options.annotations.readOnlyHint) {
      assert.equal(
        (await handler({})).structuredContent.error_code,
        "CONTROL_KEY_REQUIRED",
        name,
      );
    }
  }
  const s = executionSchemas(z);
  assert.equal(
    s.colab_submit_job.safeParse({
      kind: "benchmark",
      spec: { model_path: "model", warmup_runs: 0 },
    }).success,
    false,
  );
  assert.equal(
    s.colab_benchmark_model.safeParse({
      model_path: "model",
      warmup_runs: 1,
      warmup_tokens: 4096,
    }).success,
    true,
  );
  assert.equal(
    s.colab_export_model.safeParse({ model_path: "model", format: "tflite" })
      .success,
    false,
  );
  assert.equal(
    s.colab_retry_job.safeParse({
      job_id: id,
      idempotency_key: "retry",
      checkpoint_path: "../x",
    }).success,
    false,
  );
  assert.equal(
    s.colab_submit_job.safeParse({
      kind: "pipeline",
      spec: {
        steps: [{ id: "a", kind: "python", spec: { code: "print(1)" } }],
      },
    }).success,
    true,
  );
});
test("auth lookup failure is unavailable, invalid key is unauthorized without retry", async () => {
  let calls = 0;
  const db = {
    from: () => ({
      select: () => ({
        in: async () => {
          calls++;
          return { error: { message: "secret" } };
        },
      }),
    }),
  };
  assert.deepEqual(
    await authenticateBridge(
      new Request("https://example.test/?access_token=bad"),
      db,
    ),
    { ok: false, status: 503, error_code: "BACKEND_UNAVAILABLE" },
  );
  assert.equal(calls, 1);
});

test("auth returns 401 only for missing or invalid keys and catches thrown lookup failures", async () => {
  const absent = await authenticateBridge(
    new Request("https://example.test/"),
    {},
  );
  assert.equal(absent.ok, false);
  if (!absent.ok) assert.equal(absent.status, 401);
  let calls = 0;
  const db = {
    from: () => ({
      select: () => ({
        in: async () => {
          calls++;
          return { data: [] };
        },
      }),
    }),
  };
  const invalid = await authenticateBridge(
    new Request("https://example.test/?access_token=bad"),
    db,
  );
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.status, 401);
  assert.equal(calls, 1);
  const thrown = await authenticateBridge(
    new Request("https://example.test/?access_token=bad"),
    {
      from: () => {
        throw Error("private URL");
      },
    },
  );
  assert.deepEqual(thrown, {
    ok: false,
    status: 503,
    error_code: "BACKEND_UNAVAILABLE",
  });
});

test("job log tool caps aggregate text and supplies a resumable cursor", async () => {
  const tools: any[] = [];
  const events = Array.from(
    { length: 100 },
    (_, seq) => ({ seq, text: "x".repeat(8192), stream: "stdout" }),
  );
  registerExecutionTools({ registerTool: (...a: any[]) => tools.push(a) }, {
    db: { rpc: async () => ({ data: { ok: true, events } }) },
    role: "read",
    lifecycle: {},
    z,
  });
  const [, , handler] = tools.find(([name]) => name === "colab_job_logs");
  const result = (await handler({ job_id: id, limit: 100 })).structuredContent;
  assert.ok(
    result.events.reduce((n: number, e: any) => n + e.text.length, 0) <= 65536,
  );
  assert.equal(result.next_after, 7);
  assert.equal(result.has_more, true);
});
