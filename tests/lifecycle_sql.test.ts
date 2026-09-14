import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { JobService } from "../supabase/shared/job_api.ts";
const runtime = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  foreign = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
async function setup() {
  const db = new PGlite();
  await db.exec(
    "create role anon; create role authenticated; create role service_role;",
  );
  for (
    const file of [
      "20260912_colab_bridge.sql",
      "20260912154108_colab_bridge_jobs.sql",
      "20260914113920_colab_bridge_lifecycle_integration.sql",
    ]
  ) {
    await db.exec(
      readFileSync("supabase/migrations/" + file, "utf8").replace(
        "create extension if not exists pgcrypto;",
        "",
      ),
    );
  }
  const rpc = async (name: string, args: any = {}) => {
    try {
      const entries = Object.entries(args);
      const r = await db.query(
        `select public.${name}(${
          entries.map(([k], i) => `${k} => $${i + 1}`).join(",")
        }) as result`,
        entries.map(([, v]) =>
          typeof v === "object" && v !== null ? JSON.stringify(v) : v
        ),
      );
      return { data: (r.rows[0] as any).result };
    } catch (e) {
      throw e;
    }
  };
  await db.query(
    "insert into colab_bridge_runtimes(runtime_id,accelerator,runtime_metadata) values($1,'nvidia_gpu','{\"execution_enabled\":true}'),($2,'nvidia_gpu','{\"execution_enabled\":true}')",
    [runtime, foreign],
  );
  return {
    db,
    rpc,
    jobs: new JobService({
      rpc,
      storage: {
        from: () => ({
          createSignedUrl: async () => ({
            data: { signedUrl: "https://storage.test/file" },
          }),
        }),
      },
    }),
  };
}
test("SQL lifecycle coalesces requests, fences workers and preserves idempotency aliases", async () => {
  const { db, rpc } = await setup();
  try {
    const request = crypto.randomUUID(), second = crypto.randomUUID();
    const a = (await rpc("colab_bridge_lifecycle_begin", {
      p_request_id: request,
      p_provider: "google_colab",
      p_accelerator: "T4",
    })).data;
    const b = (await rpc("colab_bridge_lifecycle_begin", {
      p_request_id: second,
      p_provider: "google_colab",
      p_accelerator: "T4",
    })).data;
    assert.equal(a.lifecycle.id, b.lifecycle.id);
    assert.equal(
      (await rpc("colab_bridge_lifecycle_begin", {
        p_request_id: second,
        p_provider: "external",
        p_accelerator: "T4",
      })).data.error_code,
      "IDEMPOTENCY_CONFLICT",
    );
    const acquired =
      (await rpc("colab_bridge_lifecycle_acquire", { p_id: a.lifecycle.id }))
        .data;
    assert.ok(acquired.token);
    assert.equal(
      (await rpc("colab_bridge_lifecycle_acquire", { p_id: a.lifecycle.id }))
        .data.busy,
      true,
    );
    assert.equal(
      (await rpc("colab_bridge_lifecycle_save", {
        p_id: a.lifecycle.id,
        p_token: crypto.randomUUID(),
        p_status: "ready",
        p_request: {},
        p_runtime_id: null,
        p_error_code: null,
      })).data.error_code,
      "LIFECYCLE_LEASE_LOST",
    );
  } finally {
    await db.close();
  }
});
test("SQL release coordinates claims, cancellation and immutable affinity/audit", async () => {
  const { db, rpc, jobs } = await setup();
  try {
    const submitted = await jobs.submit({
      kind: "python",
      spec: { code: "print(1)" },
      runtime_id: runtime,
    });
    const claimed = await jobs.claim(runtime);
    assert.equal((claimed.job as any).id, submitted.job_id);
    assert.equal(
      (await rpc("colab_bridge_begin_release", {
        p_runtime_id: runtime,
        p_cancel_jobs: false,
      })).data.error_code,
      "ACTIVE_JOBS",
    );
    assert.equal(
      (await rpc("colab_bridge_begin_release", {
        p_runtime_id: runtime,
        p_cancel_jobs: true,
      })).data.can_delete,
      false,
    );
    assert.equal(
      (await jobs.submit({
        kind: "python",
        spec: { code: "print(2)" },
        runtime_id: runtime,
      })).error_code,
      "RUNTIME_DRAINING",
    );
    await rpc("colab_bridge_agent_heartbeat", {
      p_runtime_id: runtime,
      p_payload: {
        execution_enabled: true,
        draining: false,
        agent_version: "0.2.0",
      },
    });
    assert.equal((await jobs.claim(runtime)).job, null);
    await jobs.complete({
      runtime_id: runtime,
      job_id: submitted.job_id,
      lease_token: (claimed.job as any).lease_token,
      status: "cancelled",
    });
    assert.equal(
      (await rpc("colab_bridge_begin_release", {
        p_runtime_id: runtime,
        p_cancel_jobs: true,
      })).data.can_delete,
      true,
    );
    const row = (await db.query(
      "select requested_runtime_id,status from colab_bridge_jobs where id=$1",
      [submitted.job_id],
    )).rows[0] as any;
    assert.equal(row.requested_runtime_id, runtime);
    assert.equal(row.status, "cancelled");
  } finally {
    await db.close();
  }
});
test("SQL linked checkpoint retry validates exact published marker, restores all files and preserves affinity", async () => {
  const { db, jobs } = await setup();
  try {
    const source = await jobs.submit({
      kind: "pipeline",
      spec: {
        steps: [{ id: "x", kind: "python", spec: { code: "print(1)" } }],
      },
      project: "project",
      timeout_seconds: 100,
      require_gpu: true,
      runtime_id: runtime,
    });
    await db.query("update colab_bridge_jobs set status='failed' where id=$1", [
      source.job_id,
    ]);
    assert.equal(
      (await jobs.retry(source.job_id, "missing", "step-1/checkpoint.json"))
        .error_code,
      "CHECKPOINT_INVALID",
    );
    for (const path of ["step-1/checkpoint.json", "step-1/data.txt"]) {
      await db.query(
        "insert into colab_bridge_artifacts(job_id,runtime_id,attempt,path,storage_path,bytes,sha256,mime_type,status) values($1,$2,1,$3,$3,1,$4,'application/json','published')",
        [source.job_id, runtime, path, "a".repeat(64)],
      );
    }
    const retry = await jobs.retry(
      source.job_id,
      "retry",
      "step-1/checkpoint.json",
    );
    assert.equal(retry.ok, true);
    assert.equal(
      (await jobs.retry(source.job_id, "retry", "step-1/checkpoint.json"))
        .job_id,
      retry.job_id,
    );
    assert.equal(
      (await jobs.retry(source.job_id, "retry")).error_code,
      "IDEMPOTENCY_CONFLICT",
    );
    assert.equal((await jobs.claim(foreign)).job, null);
    const claim = await jobs.claim(runtime);
    const job = claim.job as any;
    assert.equal(job.id, retry.job_id);
    assert.equal(job.spec.resume, true);
    assert.equal(job.spec.checkpoint_path, "step-1/checkpoint.json");
    assert.equal(job.restore_artifacts.length, 2);
    assert.equal(job.project, "project");
    assert.equal(job.timeout_seconds, 100);
    assert.ok(
      job.restore_artifacts.every((a: any) =>
        a.download_url && !a.storage_path
      ),
    );
    const record = (await db.query(
      "select parent_job_id,requested_runtime_id,require_gpu from colab_bridge_jobs where id=$1",
      [retry.job_id],
    )).rows[0] as any;
    assert.deepEqual(record, {
      parent_job_id: source.job_id,
      requested_runtime_id: runtime,
      require_gpu: true,
    });
    const lora = await jobs.submit({
      kind: "lora",
      spec: { model_path: "model", data_path: "data" },
      runtime_id: foreign,
    });
    await db.query("update colab_bridge_jobs set status='failed' where id=$1", [
      lora.job_id,
    ]);
    await db.query(
      "insert into colab_bridge_artifacts(job_id,runtime_id,attempt,path,storage_path,bytes,sha256,mime_type,status) values($1,$2,1,'adapter/checkpoints/run-step-1/file.bin','unique',1,$3,'application/octet-stream','published')",
      [lora.job_id, foreign, "b".repeat(64)],
    );
    assert.equal(
      (await jobs.retry(
        lora.job_id,
        "lora-retry",
        "adapter/checkpoints/run-step-1",
      )).error_code,
      "CHECKPOINT_INVALID",
    );
    await db.query(
      "update colab_bridge_artifacts set path='adapter/checkpoints/run-step-1/checkpoint.json' where job_id=$1",
      [lora.job_id],
    );
    assert.equal(
      (await jobs.retry(
        lora.job_id,
        "lora-retry",
        "adapter/checkpoints/run-step-1",
      )).ok,
      true,
    );
    assert.equal(
      (await jobs.retry(lora.job_id, "foreign-retry", "step-1/checkpoint.json"))
        .error_code,
      "CHECKPOINT_INVALID",
    );
  } finally {
    await db.close();
  }
});

test("LifecycleService advances actual durable rows, bootstraps once and requires a fresh Agent GPU", async () => {
  const { LifecycleService } = await import("../supabase/shared/lifecycle.ts");
  const { db, rpc } = await setup();
  const adapter = sqlAdapter(db, rpc);
  let creates = 0, kernels = 0, executions = 0, deleted = 0;
  const fetcher: any = async (url: string, options: any = {}) => {
    if (url.includes("oauth2")) {
      return Response.json({ access_token: "very-secret" });
    }
    if (url.endsWith("/subscription")) return Response.json({});
    if (url.endsWith("/runtimespecs")) {
      return Response.json({
        runtimeSpecs: [{
          key: {
            variant: "VARIANT_GPU",
            accelerator: "T4",
            shape: "SHAPE_STANDARD",
          },
          eligible: true,
        }],
      });
    }
    if (url.includes("?requestId=")) {
      creates++;
      return Response.json({ name: "operations/op", done: false });
    }
    if (url.includes("/operations/")) {
      return Response.json({
        name: "operations/op",
        done: true,
        response: { name: "runtimes/managed" },
      });
    }
    if (options.method === "DELETE") {
      deleted++;
      return Response.json({});
    }
    return Response.json({
      name: "runtimes/managed",
      connectionInfo: {
        url: "https://proxy.example",
        token: "signed-token",
        expireTime: new Date(Date.now() + 3600000).toISOString(),
      },
    });
  };
  const bootstrap: any = {
    createKernel: async () => {
      kernels++;
      return "kernel";
    },
    execute: async () => {
      executions++;
    },
  };
  const service = new LifecycleService(
    adapter,
    {
      googleClientId: "id",
      googleClientSecret: "secret",
      googleRefreshToken: "refresh",
      agentUrl: "https://agent.example",
      agentKey: "key",
    },
    fetcher,
    bootstrap,
  );
  try {
    const first = await service.ensure({ accelerator: "T4" });
    assert.equal(first.status, "starting");
    assert.equal(creates, 1);
    const second = await service.ensure({ accelerator: "T4" });
    assert.equal(second.lifecycle_id, first.lifecycle_id);
    assert.equal(second.status, "bootstrapping");
    assert.equal(kernels, 1);
    assert.equal(executions, 1);
    const row =
      (await db.query("select * from colab_bridge_lifecycle where id=$1", [
        first.lifecycle_id,
      ])).rows[0] as any;
    const agentId = row.request.expected_agent_id;
    assert.ok(!JSON.stringify(row).includes("signed-token"));
    assert.ok(!JSON.stringify(row).includes("very-secret"));
    await db.query(
      "insert into colab_bridge_runtimes(runtime_id,accelerator,runtime_metadata) values($1,'nvidia_gpu','{\"execution_enabled\":true}')",
      [agentId],
    );
    assert.equal(
      (await service.waitReady(first.lifecycle_id)).status,
      "bootstrapping",
    );
    await db.query(
      "insert into colab_bridge_snapshots(runtime_id,kind,payload,observed_at) values($1,'gpu','{\"gpus\":[{\"name\":\"Tesla T4\"}]}',now()-interval '2 minutes')",
      [agentId],
    );
    assert.equal(
      (await service.waitReady(first.lifecycle_id)).status,
      "bootstrapping",
    );
    await db.query(
      "update colab_bridge_snapshots set observed_at=clock_timestamp() where runtime_id=$1",
      [agentId],
    );
    assert.equal((await service.waitReady(first.lifecycle_id)).status, "ready");
    assert.equal(
      (await service.release({ runtime_id: agentId })).status,
      "released",
    );
    assert.equal(deleted, 1);
    assert.equal(
      (await service.release({ runtime_id: agentId })).status,
      "released",
    );
    assert.equal(deleted, 1);
  } finally {
    await db.close();
  }
});

function sqlAdapter(db: any, rpc: any) {
  return {
    rpc,
    from: (table: string) => {
      const filters: any[] = [];
      let order = "";
      let limit = "";
      const builder: any = {
        select: () => builder,
        eq: (k: string, v: any) => {
          filters.push([k, v]);
          return builder;
        },
        order: (k: string) => {
          order = ` order by ${k} desc`;
          return builder;
        },
        limit: (v: number) => {
          limit = ` limit ${v}`;
          return builder;
        },
        maybeSingle: async () => {
          const r = await db.query(
            `select * from ${table}${
              filters.length
                ? " where " +
                  filters.map(([k], i) => `${k}=$${i + 1}`).join(" and ")
                : ""
            }${order}${limit}`,
            filters.map(([, v]) => v),
          );
          return {
            data: r.rows[0] ? JSON.parse(JSON.stringify(r.rows[0])) : null,
          };
        },
      };
      return builder;
    },
  };
}

test("release intent during in-flight create survives allocation completion and blocks first Agent claim", async () => {
  const { LifecycleService } = await import("../supabase/shared/lifecycle.ts");
  const { db, rpc, jobs } = await setup();
  let started!: () => void, finish!: () => void;
  const inCreate = new Promise<void>((r) => started = r),
    finishCreate = new Promise<void>((r) => finish = r);
  let deleted = 0, bootstrapped = 0;
  const fetcher: any = async (url: string, options: any = {}) => {
    if (url.includes("oauth2")) return Response.json({ access_token: "token" });
    if (url.endsWith("/runtimespecs")) {
      return Response.json({
        runtimeSpecs: [{
          key: {
            variant: "VARIANT_GPU",
            accelerator: "T4",
            shape: "SHAPE_STANDARD",
          },
          eligible: true,
        }],
      });
    }
    if (url.includes("requestId=")) {
      started();
      await finishCreate;
      return Response.json({ name: "operations/pending", done: false });
    }
    if (url.includes("/operations/")) {
      return Response.json({ done: true, response: { name: "runtimes/new" } });
    }
    if (options.method === "DELETE") {
      deleted++;
      return Response.json({});
    }
    return Response.json({});
  };
  const service = new LifecycleService(
    sqlAdapter(db, rpc),
    {
      googleClientId: "c",
      googleClientSecret: "s",
      googleRefreshToken: "r",
      agentUrl: "https://agent.example",
      agentKey: "key",
    },
    fetcher,
    {
      createKernel: async () => {
        bootstrapped++;
        return "k";
      },
      execute: async () => {
        bootstrapped++;
      },
    } as any,
  );
  try {
    const ensuring = service.ensure({ accelerator: "T4" });
    await inCreate;
    const row = (await db.query("select * from colab_bridge_lifecycle"))
      .rows[0] as any;
    const release = await service.release({ lifecycle_id: row.id });
    assert.equal(release.status, "starting");
    finish();
    await ensuring;
    const current =
      (await db.query("select * from colab_bridge_lifecycle where id=$1", [
        row.id,
      ])).rows[0] as any;
    assert.equal(current.request.releasing, true);
    assert.equal(current.request.operation, "operations/pending");
    await db.query(
      "insert into colab_bridge_runtimes(runtime_id,runtime_metadata) values($1,'{\"execution_enabled\":true}') on conflict(runtime_id) do update set runtime_metadata=excluded.runtime_metadata",
      [row.request.expected_agent_id],
    );
    await jobs.submit({ kind: "python", spec: { code: "print(1)" } });
    assert.equal((await jobs.claim(row.request.expected_agent_id)).job, null);
    assert.equal((await service.waitReady(row.id)).status, "released");
    assert.equal(deleted, 1);
    assert.equal(bootstrapped, 0);
  } finally {
    finish();
    await db.close();
  }
});

test("fresh manually registered GPU is reused without provider credentials and cannot claim provider deletion", async () => {
  const { LifecycleService } = await import("../supabase/shared/lifecycle.ts");
  const { db, rpc } = await setup();
  try {
    await db.query(
      'insert into colab_bridge_snapshots(runtime_id,kind,payload,observed_at) values($1,\'gpu\',\'{"gpus":[{"name":"Tesla T4"}]}\',clock_timestamp())',
      [runtime],
    );
    const service = new LifecycleService(sqlAdapter(db, rpc), {}, async () => {
      throw Error("No network allowed");
    });
    const result = await service.ensure({ accelerator: "T4" });
    assert.equal(result.status, "ready");
    assert.equal(result.runtime_id, runtime);
    assert.equal(
      (await service.release({ runtime_id: runtime })).error_code,
      "PROVIDER_RESOURCE_UNKNOWN",
    );
    const row = (await db.query(
      "select draining from colab_bridge_runtimes where runtime_id=$1",
      [runtime],
    )).rows[0] as any;
    assert.equal(row.draining, false);
  } finally {
    await db.close();
  }
});

test("release reconciles uncertain Google allocation by deterministic resource lookup without creating again", async () => {
  const { LifecycleService } = await import("../supabase/shared/lifecycle.ts");
  const { db, rpc } = await setup();
  let creates = 0, deletes = 0, lookups = 0;
  const requestId = crypto.randomUUID();
  const fetcher: any = async (url: string, options: any = {}) => {
    if (url.includes("oauth2")) return Response.json({ access_token: "token" });
    if (url.endsWith("/runtimespecs")) {
      return Response.json({
        runtimeSpecs: [{
          key: {
            variant: "VARIANT_GPU",
            accelerator: "T4",
            shape: "SHAPE_STANDARD",
          },
          eligible: true,
        }],
      });
    }
    if (url.includes("requestId=")) {
      creates++;
      throw Error("simulated response loss after provider allocation");
    }
    if (url.endsWith("/runtimes/cb-" + requestId)) {
      if (options.method === "DELETE") deletes++;
      else lookups++;
      return Response.json({ name: "runtimes/cb-" + requestId });
    }
    return Response.json({});
  };
  const service = new LifecycleService(sqlAdapter(db, rpc), {
    googleClientId: "c",
    googleClientSecret: "s",
    googleRefreshToken: "r",
    agentUrl: "https://agent.example",
    agentKey: "key",
  }, fetcher);
  try {
    const ensure = await service.ensure({ request_id: requestId });
    assert.equal(ensure.status, "blocked");
    const release = await service.release({
      lifecycle_id: ensure.lifecycle_id,
    });
    assert.equal(release.status, "released");
    assert.equal(creates, 1);
    assert.equal(deletes, 1);
    assert.equal(lookups, 1);
  } finally {
    await db.close();
  }
});

test("retry admission refuses draining affinity after release and preserves audit", async () => {
  const { db, rpc, jobs } = await setup();
  try {
    const parent = await jobs.submit({
      kind: "python",
      spec: { code: "print(1)" },
      runtime_id: runtime,
    });
    await db.query("update colab_bridge_jobs set status='failed' where id=$1", [
      parent.job_id,
    ]);
    assert.equal(
      (await rpc("colab_bridge_begin_release", { p_runtime_id: runtime })).data
        .can_delete,
      true,
    );
    const result = await jobs.retry(parent.job_id, "retry-during-delete");
    assert.equal(result.error_code, "RUNTIME_DRAINING");
    const audit = (await db.query(
      "select id,requested_runtime_id,status from colab_bridge_jobs",
    )).rows;
    assert.deepEqual(audit, [{
      id: parent.job_id,
      requested_runtime_id: runtime,
      status: "failed",
    }]);
    // An unassigned parent stays unassigned and can still queue for another live runtime.
    const unassigned = await jobs.submit({
      kind: "python",
      spec: { code: "print(2)" },
    });
    await db.query("update colab_bridge_jobs set status='failed' where id=$1", [
      unassigned.job_id,
    ]);
    assert.equal(
      (await jobs.retry(unassigned.job_id, "unassigned-retry")).ok,
      true,
    );
  } finally {
    await db.close();
  }
});

for (const releaseBy of ["runtime_id", "lifecycle_id"]) {
  test(`managed reuse preserves allocation owner for same/cross-provider release by ${releaseBy}`, async () => {
    const { LifecycleService } = await import(
      "../supabase/shared/lifecycle.ts"
    );
    const { db, rpc } = await setup();
    const requestId = crypto.randomUUID();
    let deleted = 0;
    try {
      const owner = (await rpc("colab_bridge_lifecycle_begin", {
        p_request_id: requestId,
        p_provider: "google_colab",
        p_accelerator: "T4",
      })).data.lifecycle;
      await db.query(
        "update colab_bridge_lifecycle set runtime_id=$2::uuid,status='ready',request=request||jsonb_build_object('expected_agent_id',($2::uuid)::text,'resource','runtimes/owned','allocation_attempted',true) where id=$1",
        [owner.id, runtime],
      );
      await db.query(
        'insert into colab_bridge_snapshots(runtime_id,kind,payload,observed_at) values($1,\'gpu\',\'{"gpus":[{"name":"Tesla T4"}]}\',clock_timestamp())',
        [runtime],
      );
      const service = new LifecycleService(sqlAdapter(db, rpc), {
        googleClientId: "c",
        googleClientSecret: "s",
        googleRefreshToken: "r",
      }, async (url: any, options: any = {}) => {
        assert.ok(!String(url).includes("external"));
        if (String(url).includes("oauth2")) {
          return Response.json({ access_token: "token" });
        }
        assert.equal(options.method, "DELETE");
        deleted++;
        return Response.json({});
      });
      const same = await service.ensure({ provider: "google_colab" });
      assert.equal(same.lifecycle_id, owner.id);
      const cross = await service.ensure({ provider: "external" });
      assert.equal(cross.status, "ready");
      assert.notEqual(cross.lifecycle_id, owner.id);
      const released = await service.release(
        releaseBy === "runtime_id"
          ? { runtime_id: runtime }
          : { lifecycle_id: cross.lifecycle_id },
      );
      assert.equal(released.status, "released");
      assert.equal(released.lifecycle_id, owner.id);
      assert.equal(released.provider, "google_colab");
      assert.equal(deleted, 1);
      assert.equal(
        (await service.release({ lifecycle_id: cross.lifecycle_id })).status,
        "released",
      );
      assert.equal(deleted, 1);
      const old = (await db.query(
        "select request_id from colab_bridge_lifecycle where id=$1",
        [cross.lifecycle_id],
      )).rows[0];
      assert.ok(old);
    } finally {
      await db.close();
    }
  });
}

test("definitive runtime absence retires allocation and permits a fresh ensure while old request bindings remain stable", async () => {
  const { LifecycleService } = await import("../supabase/shared/lifecycle.ts");
  const { db, rpc } = await setup();
  let creates = 0, gets = 0;
  const original = crypto.randomUUID(),
    firstFresh = crypto.randomUUID(),
    nextFresh = crypto.randomUUID();
  try {
    const owner = (await rpc("colab_bridge_lifecycle_begin", {
      p_request_id: original,
      p_provider: "google_colab",
      p_accelerator: "T4",
    })).data.lifecycle;
    await db.query(
      'update colab_bridge_lifecycle set status=\'ready\',request=request||\'{"resource":"runtimes/expired","allocation_attempted":true}\'::jsonb where id=$1',
      [owner.id],
    );
    const service = new LifecycleService(sqlAdapter(db, rpc), {
      googleClientId: "c",
      googleClientSecret: "s",
      googleRefreshToken: "r",
      agentUrl: "https://agent.example",
      agentKey: "key",
    }, async (url: any) => {
      if (String(url).includes("oauth2")) {
        return Response.json({ access_token: "token" });
      }
      if (String(url).endsWith("/runtimes/expired")) {
        gets++;
        return new Response("{}", { status: 404 });
      }
      if (String(url).endsWith("/runtimespecs")) {
        return Response.json({
          runtimeSpecs: [{
            key: {
              variant: "VARIANT_GPU",
              accelerator: "T4",
              shape: "SHAPE_STANDARD",
            },
            eligible: true,
          }],
        });
      }
      if (String(url).includes("requestId=")) {
        creates++;
        return Response.json({ name: "operations/new", done: false });
      }
      return Response.json({});
    });
    const absent = await service.ensure({ request_id: firstFresh });
    assert.equal(absent.status, "failed");
    assert.equal(absent.error_code, "PROVIDER_NOT_FOUND");
    const fresh = await service.ensure({ request_id: nextFresh });
    assert.notEqual(fresh.lifecycle_id, owner.id);
    assert.equal(fresh.status, "starting");
    assert.equal(creates, 1);
    for (const request_id of [original, firstFresh]) {
      const old = await service.ensure({ request_id });
      assert.equal(old.lifecycle_id, owner.id);
      assert.equal(old.status, "failed");
    }
    assert.equal(gets, 1);
    assert.equal(creates, 1);
  } finally {
    await db.close();
  }
});

test("retry takes affinity admission lock before lease reaping or parent row locking", () => {
  const migration = readFileSync(
    "supabase/migrations/20260914113920_colab_bridge_lifecycle_integration.sql",
    "utf8",
  );
  const retry =
    migration.split("create function public.colab_bridge_retry_job")[1].split(
      "$$;",
    )[0];
  const lock = retry.indexOf("pg_advisory_xact_lock");
  assert.ok(lock >= 0);
  assert.ok(
    lock < retry.indexOf("perform public.colab_bridge_reap_expired_jobs()"),
  );
  assert.ok(lock < retry.indexOf("for update"));
});

test("retired allocation owners exclude reuse aliases and cannot be revived by old fresh telemetry", async () => {
  const { LifecycleService } = await import("../supabase/shared/lifecycle.ts");
  const { db, rpc } = await setup();
  try {
    const owner = (await rpc("colab_bridge_lifecycle_begin", {
      p_request_id: crypto.randomUUID(),
      p_provider: "google_colab",
      p_accelerator: "T4",
    })).data.lifecycle;
    await db.query(
      "update colab_bridge_lifecycle set runtime_id=$2::uuid,status='ready',request=request||jsonb_build_object('expected_agent_id',($2::uuid)::text,'resource','runtimes/owned') where id=$1",
      [owner.id, runtime],
    );
    await db.query(
      'insert into colab_bridge_snapshots(runtime_id,kind,payload,observed_at) values($1,\'gpu\',\'{"gpus":[{"name":"Tesla T4"}]}\',clock_timestamp())',
      [runtime],
    );
    const service = new LifecycleService(sqlAdapter(db, rpc), {});
    const alias = await service.ensure({ provider: "external" });
    assert.equal(alias.status, "ready");
    await db.query(
      "update colab_bridge_lifecycle set status='failed',error_code='PROVIDER_NOT_FOUND',request=request||'{\"allocation_absent\":true}'::jsonb where id=$1",
      [owner.id],
    );
    const old = await service.waitReady(alias.lifecycle_id);
    assert.equal(old.status, "failed");
    assert.equal(old.error_code, "PROVIDER_NOT_FOUND");
    const fresh = await service.ensure({ provider: "external" });
    assert.notEqual(fresh.lifecycle_id, alias.lifecycle_id);
    assert.notEqual(fresh.expected_agent_id, runtime);
    assert.equal(fresh.error_code, "EXTERNAL_PROVIDER_NOT_CONFIGURED");
  } finally {
    await db.close();
  }
});

test("missing operation and uncertain-create lookup do not retire or declare unknown allocations released", async () => {
  const { LifecycleService } = await import("../supabase/shared/lifecycle.ts");
  const { db, rpc } = await setup();
  let creates = 0;
  try {
    const owner = (await rpc("colab_bridge_lifecycle_begin", {
      p_request_id: crypto.randomUUID(),
      p_provider: "google_colab",
      p_accelerator: "T4",
    })).data.lifecycle;
    await db.query(
      'update colab_bridge_lifecycle set status=\'starting\',request=request||\'{"operation":"operations/missing","allocation_attempted":true}\'::jsonb where id=$1',
      [owner.id],
    );
    const service = new LifecycleService(sqlAdapter(db, rpc), {
      googleClientId: "c",
      googleClientSecret: "s",
      googleRefreshToken: "r",
      agentUrl: "https://agent.example",
      agentKey: "key",
    }, async (url: any) => {
      if (String(url).includes("oauth2")) {
        return Response.json({ access_token: "token" });
      }
      if (String(url).includes("requestId=")) creates++;
      return new Response("{}", { status: 404 });
    });
    for (let i = 0; i < 2; i++) {
      const result = await service.ensure({});
      assert.equal(result.lifecycle_id, owner.id);
      assert.equal(result.status, "blocked");
    }
    await db.query(
      "update colab_bridge_lifecycle set request=request-'operation' where id=$1",
      [owner.id],
    );
    const release = await service.release({ lifecycle_id: owner.id });
    assert.equal(release.status, "blocked");
    assert.equal((await service.waitReady(owner.id)).status, "blocked");
    const current = (await db.query(
      "select request from colab_bridge_lifecycle where id=$1",
      [owner.id],
    )).rows[0] as any;
    assert.notEqual(current.request.allocation_absent, true);
    assert.equal(creates, 0);
  } finally {
    await db.close();
  }
});

async function registeredBeforeOwnerReadyPoll() {
  const context = await setup();
  const owner = (await context.rpc("colab_bridge_lifecycle_begin", {
    p_request_id: crypto.randomUUID(),
    p_provider: "google_colab",
    p_accelerator: "T4",
  })).data.lifecycle;
  const agentId = owner.request.expected_agent_id;
  // Provider progress is durable; Agent registration has not been associated by a ready poll yet.
  await context.db.query(
    'update colab_bridge_lifecycle set status=\'bootstrapping\',request=request||\'{"resource":"runtimes/pre-ready","allocation_attempted":true}\'::jsonb where id=$1',
    [owner.id],
  );
  await context.db.query(
    "insert into colab_bridge_runtimes(runtime_id,accelerator,runtime_metadata) values($1,'nvidia_gpu','{\"execution_enabled\":true}')",
    [agentId],
  );
  await context.db.query(
    'insert into colab_bridge_snapshots(runtime_id,kind,payload,observed_at) values($1,\'gpu\',\'{"gpus":[{"name":"Tesla T4"}]}\',clock_timestamp())',
    [agentId],
  );
  assert.equal(
    (await context.db.query(
      "select runtime_id from colab_bridge_lifecycle where id=$1",
      [owner.id],
    )).rows[0].runtime_id,
    null,
  );
  return { ...context, owner, agentId };
}

for (const selector of ["runtime_id", "lifecycle_id"]) {
  test(`pre-ready-poll registered Agent retains allocation owner for release by ${selector}`, async () => {
    const { LifecycleService } = await import(
      "../supabase/shared/lifecycle.ts"
    );
    const { db, rpc, owner, agentId } = await registeredBeforeOwnerReadyPoll();
    let deleted = 0;
    try {
      const service = new LifecycleService(sqlAdapter(db, rpc), {
        googleClientId: "c",
        googleClientSecret: "s",
        googleRefreshToken: "r",
      }, async (url: any, options: any = {}) => {
        if (String(url).includes("oauth2")) {
          return Response.json({ access_token: "token" });
        }
        assert.equal(
          String(url),
          "https://colaboratory.googleapis.com/v1beta/runtimes/pre-ready",
        );
        assert.equal(options.method, "DELETE");
        deleted++;
        return Response.json({});
      });
      const alias = await service.ensure({ provider: "external" });
      assert.equal(alias.status, "ready");
      assert.equal(alias.runtime_id, agentId);
      const binding = (await db.query(
        "select allocation_owner_id from colab_bridge_lifecycle where id=$1",
        [alias.lifecycle_id],
      )).rows[0];
      assert.equal(binding.allocation_owner_id, owner.id);
      assert.equal(
        (await db.query(
          "select runtime_id from colab_bridge_lifecycle where id=$1",
          [owner.id],
        )).rows[0].runtime_id,
        null,
      );
      const release = await service.release(
        selector === "runtime_id"
          ? { runtime_id: agentId }
          : { lifecycle_id: alias.lifecycle_id },
      );
      assert.equal(release.status, "released");
      assert.equal(release.lifecycle_id, owner.id);
      assert.equal(release.provider, "google_colab");
      assert.equal(deleted, 1);
      assert.equal(
        (await service.release({ lifecycle_id: alias.lifecycle_id })).status,
        "released",
      );
      assert.equal(deleted, 1);
    } finally {
      await db.close();
    }
  });
}

test("pre-ready-poll owner retirement still excludes its registered Agent and reuse aliases", async () => {
  const { LifecycleService } = await import("../supabase/shared/lifecycle.ts");
  const { db, rpc, owner, agentId } = await registeredBeforeOwnerReadyPoll();
  try {
    const service = new LifecycleService(sqlAdapter(db, rpc), {});
    const alias = await service.ensure({ provider: "external" });
    assert.equal(alias.status, "ready");
    await db.query(
      "update colab_bridge_lifecycle set status='failed',error_code='PROVIDER_NOT_FOUND',request=request||'{\"allocation_absent\":true}'::jsonb where id=$1",
      [owner.id],
    );
    assert.equal(
      (await service.waitReady(alias.lifecycle_id)).status,
      "failed",
    );
    const fresh = await service.ensure({ provider: "external" });
    assert.notEqual(fresh.lifecycle_id, alias.lifecycle_id);
    assert.notEqual(fresh.expected_agent_id, agentId);
    assert.equal(fresh.error_code, "EXTERNAL_PROVIDER_NOT_CONFIGURED");
    assert.equal(
      (await db.query(
        "select runtime_id from colab_bridge_lifecycle where id=$1",
        [owner.id],
      )).rows[0].runtime_id,
      null,
    );
  } finally {
    await db.close();
  }
});
