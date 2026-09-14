import test from "node:test";
import assert from "node:assert/strict";
import { agentReady, LifecycleService } from "../supabase/shared/lifecycle.ts";
import {
  ExternalProvider,
  GoogleColabProvider,
} from "../supabase/shared/providers.ts";
const config = {
  googleClientId: "client",
  googleClientSecret: "secret",
  googleRefreshToken: "refresh",
  agentUrl: "https://example.supabase.co/functions/v1/colab-bridge-agent",
  agentKey: "agent",
};
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
test("missing OAuth and bootstrap config block before allocation", async () => {
  assert.equal(
    (await new LifecycleService({}, {}).ensure({ accelerator: "T4" }))
      .error_code,
    "GOOGLE_AUTH_NOT_CONFIGURED",
  );
  assert.equal(
    (await new LifecycleService({}, { ...config, agentKey: undefined }).ensure({
      accelerator: "T4",
    })).error_code,
    "BOOTSTRAP_NOT_CONFIGURED",
  );
});
for (
  const [status, code] of [[403, "GOOGLE_ALLOWLIST_DENIED"], [
    429,
    "PROVIDER_QUOTA_EXHAUSTED",
  ]] as const
) {
  test(code, async () => {
    const provider = new GoogleColabProvider(
      config,
      async (url: any) =>
        new Response(
          JSON.stringify(
            String(url).includes("oauth2") ? { access_token: "access" } : {},
          ),
          { status: String(url).includes("oauth2") ? 200 : status },
        ),
    );
    await assert.rejects(() => provider.create(id, "T4"), { code });
  });
}
test("ineligible runtime specs are not allocated", async () => {
  const urls: string[] = [];
  const provider = new GoogleColabProvider(config, async (url: any) => {
    urls.push(String(url));
    return Response.json(
      String(url).includes("oauth2")
        ? { access_token: "access" }
        : String(url).includes("runtimespecs")
        ? {
          runtimeSpecs: [{
            key: {
              variant: "VARIANT_GPU",
              accelerator: "T4",
              shape: "SHAPE_STANDARD",
            },
            eligible: false,
          }],
        }
        : {},
    );
  });
  await assert.rejects(() => provider.create(id, "T4"), {
    code: "RUNTIME_SPEC_INELIGIBLE",
  });
  assert.ok(!urls.some((x) => x.includes("requestId=")));
});
test("operation failure is structured and never exposes token text", async () => {
  const p = new GoogleColabProvider(
    config,
    async (url: any) =>
      Response.json(
        String(url).includes("oauth2")
          ? { access_token: "access" }
          : { done: true, error: { code: 8, message: "secret signed token" } },
      ),
  );
  await assert.rejects(() => p.status({ operation: "operations/op" }), {
    code: "PROVIDER_QUOTA_EXHAUSTED",
    message: "PROVIDER_QUOTA_EXHAUSTED",
  });
});
test("ready requires expected Agent, execution and fresh matching GPU snapshot", () => {
  const now = new Date();
  const runtime = {
    runtime_id: id,
    last_heartbeat_at: now.toISOString(),
    accelerator: "nvidia_gpu",
    runtime_metadata: { execution_enabled: true },
    draining: false,
  };
  const snapshot = {
    observed_at: now.toISOString(),
    payload: {
      gpu_count: 1,
      gpus: [{ name: "Tesla T4" }],
      telemetry_available: true,
    },
  };
  assert.equal(agentReady(runtime, snapshot, id, "T4", now), true);
  for (
    const [r, s] of [
      [null, snapshot],
      [runtime, null],
      [{ ...runtime, runtime_id: crypto.randomUUID() }, snapshot],
      [{ ...runtime, runtime_metadata: {} }, snapshot],
      [runtime, { ...snapshot, observed_at: "2020-01-01" }],
      [runtime, { ...snapshot, payload: { gpus: [] } }],
      [{ ...runtime, draining: true }, snapshot],
    ]
  ) assert.equal(agentReady(r, s, id, "T4", now), false);
  assert.equal(agentReady(runtime, snapshot, id, "A100", now), false);
});
test("external adapter restricts host and uses fixed authenticated paths", async () => {
  const calls: any[] = [];
  const p = new ExternalProvider({
    externalUrl: "https://wake.example/base",
    externalToken: "bearer",
  }, async (url: any, options: any) => {
    calls.push([String(url), options]);
    return Response.json({ state: "starting", resource_id: "resource" });
  });
  await p.create(id, "T4");
  await p.status({ resource: "resource" });
  assert.deepEqual(calls.map((x) => x[0]), [
    "https://wake.example/base/wake",
    "https://wake.example/base/status",
  ]);
  assert.equal(calls[0][1].headers.Authorization, "Bearer bearer");
  await assert.rejects(
    () =>
      new ExternalProvider({ externalUrl: "http://bad", externalToken: "x" })
        .create(id, "T4"),
    { code: "EXTERNAL_PROVIDER_NOT_CONFIGURED" },
  );
});

test("only the authenticated runtime GET establishes definitive Google absence", async () => {
  for (const stage of ["oauth", "operation", "runtime"]) {
    const p = new GoogleColabProvider(config, async (url: any) => {
      if (String(url).includes("oauth2")) {
        return stage === "oauth"
          ? new Response("{}", { status: 404 })
          : Response.json({ access_token: "access" });
      }
      return new Response("{}", { status: 404 });
    });
    await assert.rejects(
      () =>
        p.status(
          stage === "operation"
            ? { operation: "operations/missing" }
            : { resource: "runtimes/missing" },
        ),
      (error: any) => {
        assert.equal(error.code, "PROVIDER_NOT_FOUND");
        assert.equal(error.resourceAbsent === true, stage === "runtime");
        return true;
      },
    );
  }
});
