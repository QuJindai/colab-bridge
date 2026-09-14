import {
  ExternalProvider,
  GoogleColabProvider,
  ProviderError,
  safeHttps,
} from "./providers.ts";
import type { ProviderConfig } from "./providers.ts";
import { bootstrapCode } from "./bootstrap.ts";
import type { JupyterBootstrap } from "./bootstrap.ts";
import { isUuid } from "./jobs.ts";
export function agentReady(
  runtime: any,
  snapshot: any,
  expectedId: string,
  accelerator: string,
  now = new Date(),
): boolean {
  const fresh = (s: any) =>
    typeof s === "string" && Number.isFinite(Date.parse(s)) &&
    now.getTime() - Date.parse(s) >= -5000 &&
    now.getTime() - Date.parse(s) <= 60000;
  return !!runtime && runtime.runtime_id === expectedId && !runtime.draining &&
    runtime.accelerator === "nvidia_gpu" &&
    runtime.runtime_metadata?.execution_enabled === true &&
    fresh(runtime.last_heartbeat_at) && fresh(snapshot?.observed_at) &&
    snapshot?.payload?.telemetry_available !== false &&
    Array.isArray(snapshot?.payload?.gpus) &&
    snapshot.payload.gpus.length > 0 &&
    snapshot.payload.gpus.some((g: any) =>
      typeof g.name === "string" &&
      new RegExp(`(^|[^A-Z0-9])${accelerator}([^A-Z0-9]|$)`, "i").test(g.name)
    );
}
function publicLifecycle(row: any) {
  return {
    ok: !["failed", "blocked"].includes(row.status),
    lifecycle_id: row.id,
    request_id: row.request_id,
    provider: row.provider,
    status: row.status,
    runtime_id: row.runtime_id ?? null,
    expected_agent_id: row.request?.expected_agent_id,
    error_code: row.error_code ?? null,
  };
}
export class LifecycleService {
  db: any;
  config: ProviderConfig;
  fetcher: typeof fetch;
  bootstrap?: JupyterBootstrap;
  constructor(
    db: any,
    config: ProviderConfig,
    fetcher: typeof fetch = fetch,
    bootstrap?: JupyterBootstrap,
  ) {
    this.db = db;
    this.config = config;
    this.fetcher = fetcher;
    this.bootstrap = bootstrap;
  }
  provider(name: string) {
    return name === "google_colab"
      ? new GoogleColabProvider(this.config, this.fetcher)
      : new ExternalProvider(this.config, this.fetcher);
  }
  blocker(provider: string) {
    return this.provider(provider).blocker() ??
      (provider === "google_colab" &&
          (!safeHttps(this.config.agentUrl) || !this.config.agentKey)
        ? "BOOTSTRAP_NOT_CONFIGURED"
        : null);
  }
  async connectionStatus() {
    return {
      ok: true,
      providers: Object.fromEntries(
        ["google_colab", "external"].map(
          (p) => [p, {
            configured: !this.blocker(p),
            blocker: this.blocker(p),
            availability: "unverified",
          }],
        ),
      ),
      agent_bootstrap_configured: !!safeHttps(this.config.agentUrl) &&
        !!this.config.agentKey,
    };
  }
  async rpc(name: string, args: any) {
    const { data, error } = await this.db.rpc(name, args);
    if (error || !data) throw new ProviderError("BACKEND_UNAVAILABLE");
    return data;
  }
  async runtime(id: string) {
    const { data, error } = await this.db.from("colab_bridge_runtimes").select(
      "*",
    ).eq("runtime_id", id).maybeSingle();
    if (error) throw new ProviderError("BACKEND_UNAVAILABLE");
    return data;
  }
  async snapshot(id: string) {
    const { data, error } = await this.db.from("colab_bridge_snapshots").select(
      "payload,observed_at",
    ).eq("runtime_id", id).eq("kind", "gpu").order("observed_at", {
      ascending: false,
    }).limit(1).maybeSingle();
    if (error) throw new ProviderError("BACKEND_UNAVAILABLE");
    return data;
  }
  async ready(row: any) {
    const id = row.request.expected_agent_id;
    return agentReady(
      await this.runtime(id),
      await this.snapshot(id),
      id,
      row.accelerator,
    );
  }
  async ensure(input: any = {}): Promise<any> {
    try {
      const provider = input.provider ?? "google_colab",
        accelerator = input.accelerator ?? "T4";
      const requestId = input.request_id ?? crypto.randomUUID();
      if (
        !["google_colab", "external"].includes(provider) ||
        typeof accelerator !== "string" ||
        !/^[A-Z][A-Z0-9_-]{0,31}$/.test(accelerator) || !isUuid(requestId) ||
        requestId[14] !== "4"
      ) throw new ProviderError("INVALID_REQUEST");
      const blocker = this.blocker(provider);
      if (blocker && typeof this.db.rpc !== "function") {
        return { ok: false, status: "blocked", error_code: blocker };
      }
      const begun = await this.rpc("colab_bridge_lifecycle_begin", {
        p_request_id: requestId,
        p_provider: provider,
        p_accelerator: accelerator,
      });
      if (!begun.ok) return begun;
      return await this.waitReady(begun.lifecycle.id);
    } catch (e) {
      return {
        ok: false,
        error_code: e instanceof ProviderError ? e.code : "BACKEND_UNAVAILABLE",
      };
    }
  }
  async waitReady(id: unknown): Promise<any> {
    if (!isUuid(id)) return { ok: false, error_code: "INVALID_REQUEST" };
    let row: any, token: string | undefined;
    const save = async (
      status: string,
      errorCode: string | null = null,
      unlock = true,
    ) => {
      const r = await this.rpc("colab_bridge_lifecycle_save", {
        p_id: id,
        p_token: token,
        p_status: status,
        p_request: row.request,
        p_runtime_id: row.runtime_id ?? null,
        p_error_code: errorCode,
        p_unlock: unlock,
      });
      if (!r.ok) throw new ProviderError(r.error_code);
      row = r.lifecycle;
      return publicLifecycle(row);
    };
    try {
      const acquired = await this.rpc("colab_bridge_lifecycle_acquire", {
        p_id: id,
      });
      if (!acquired.ok) return acquired;
      row = acquired.lifecycle;
      token = acquired.token;
      if (acquired.busy) return publicLifecycle(row);
      if (row.status === "released" || row.status === "failed") {
        return await save(row.status, row.error_code);
      }
      if (row.allocation_owner_id) {
        const { data: owner, error } = await this.db.from(
          "colab_bridge_lifecycle",
        )
          .select("status,request,error_code").eq("id", row.allocation_owner_id)
          .maybeSingle();
        if (error || !owner) throw new ProviderError("BACKEND_UNAVAILABLE");
        if (owner.request.allocation_absent || owner.status === "released") {
          return await save(
            "failed",
            owner.error_code ?? "ALLOCATION_RELEASED",
          );
        }
        if (owner.request.releasing) {
          return await save("blocked", "RUNTIME_DRAINING");
        }
      }
      if (!row.request.releasing && await this.ready(row)) {
        row.runtime_id = row.request.expected_agent_id;
        return await save("ready");
      }
      const provider = this.provider(row.provider);
      const blocker = row.request.releasing
        ? provider.blocker()
        : this.blocker(row.provider);
      if (blocker) return await save("blocked", blocker);
      if (row.request.releasing) {
        if (!row.request.resource) {
          if (!row.request.operation) {
            if (!row.request.allocation_attempted) {
              return await save("released");
            }
            if (!(provider instanceof GoogleColabProvider)) {
              return await save("blocked", "PROVIDER_RESOURCE_UNKNOWN");
            }
            // create uses this deterministic runtimeId. Read only: never allocate while releasing.
            const progress = await provider.status({
              resource: `runtimes/cb-${row.request_id}`,
            });
            row.request.resource = progress.resource;
          } else {
            const progress = await provider.status(row.request);
            if (!progress.resource) return await save("starting");
            row.request.resource = progress.resource;
          }
          await save("starting", null, false);
        }
        const release = await this.rpc("colab_bridge_begin_release", {
          p_runtime_id: row.request.expected_agent_id,
          p_cancel_jobs: row.request.cancel_jobs === true,
          p_create_placeholder: true,
        });
        row.runtime_id = row.request.expected_agent_id;
        if (!release.ok) return await save("blocked", release.error_code);
        if (!release.can_delete) {
          return await save("starting", "JOBS_CANCELLING");
        }
        const released = await provider.release(row.request);
        if (row.provider === "external" && !released.provider_ready) {
          return await save("starting");
        }
        return await save("released");
      }
      if (row.request.reused_runtime) {
        return await save("failed", "REUSED_RUNTIME_OFFLINE");
      }
      if (!row.request.operation && !row.request.resource) {
        const previouslyAttempted = row.request.allocation_attempted === true;
        row.request.allocation_attempted = true;
        await save("starting", null, false);
        if (row.request.releasing) {
          return previouslyAttempted
            ? await save("blocked", "PROVIDER_RESOURCE_UNKNOWN")
            : await save("released");
        }
        const p = await provider.create(
          row.request_id,
          row.accelerator,
          row.request.expected_agent_id,
        );
        if (p.operation) row.request.operation = p.operation;
        if (p.resource) row.request.resource = p.resource;
        return await save("starting");
      }
      const p = await provider.status(row.request);
      if (p.operation) row.request.operation = p.operation;
      if (p.resource) row.request.resource = p.resource;
      if (!p.provider_ready) return await save("starting");
      if (row.provider === "external") {
        return await save("bootstrapping", "AGENT_NOT_READY");
      }
      if (!this.bootstrap) {
        return await save("blocked", "BOOTSTRAP_NOT_CONFIGURED");
      }
      await save("bootstrapping", null, false);
      if (row.request.releasing) return await save("starting");
      if (!row.request.kernel_id) {
        row.request.kernel_id = await this.bootstrap.createKernel(
          p.connectionInfo,
        );
        await save("bootstrapping", null, false);
      }
      if (row.request.releasing) return await save("starting");
      if (!row.request.bootstrap_complete) {
        await this.bootstrap.execute(
          p.connectionInfo,
          row.request.kernel_id,
          bootstrapCode(this.config, row.request.expected_agent_id),
        );
        row.request.bootstrap_complete = true;
      }
      if (await this.ready(row)) {
        row.runtime_id = row.request.expected_agent_id;
        return await save("ready");
      }
      return await save("bootstrapping", "AGENT_NOT_READY");
    } catch (e) {
      const code = e instanceof ProviderError ? e.code : "BACKEND_UNAVAILABLE";
      if (row && token) {
        try {
          // Only a 404 for an already-recorded resource establishes allocation absence.
          // Operation lookup failures and uncertain-create probes stay retryable/blocked.
          if (
            e instanceof ProviderError && e.resourceAbsent &&
            row.request.resource && !row.request.releasing
          ) {
            row.request.allocation_absent = true;
            return await save("failed", code);
          }
          return await save(
            [
                "PROVIDER_OPERATION_FAILED",
                "RUNTIME_SPEC_INELIGIBLE",
                "EXTERNAL_PROVIDER_FAILED",
              ].includes(code)
              ? "failed"
              : "blocked",
            code,
          );
        } catch {}
      }
      return { ok: false, lifecycle_id: id, error_code: code };
    }
  }
  async release(input: any): Promise<any> {
    try {
      if (
        (!!input?.runtime_id === !!input?.lifecycle_id) ||
        input.runtime_id !== undefined && !isUuid(input.runtime_id) ||
        input.lifecycle_id !== undefined && !isUuid(input.lifecycle_id) ||
        input.cancel_jobs !== undefined &&
          typeof input.cancel_jobs !== "boolean"
      ) throw new ProviderError("INVALID_REQUEST");
      let query = this.db.from("colab_bridge_lifecycle").select("*");
      query = input.lifecycle_id
        ? query.eq("id", input.lifecycle_id)
        : query.eq("runtime_id", input.runtime_id);
      const { data, error } = await query.order("created_at", {
        ascending: false,
      }).limit(1).maybeSingle();
      if (error) throw new ProviderError("BACKEND_UNAVAILABLE");
      if (!data) return { ok: false, error_code: "PROVIDER_RESOURCE_UNKNOWN" };
      const intent = await this.rpc("colab_bridge_request_release", {
        p_id: data.id,
        p_cancel_jobs: input.cancel_jobs === true,
      });
      if (!intent.ok) return intent;
      if (intent.lifecycle.status === "released") {
        return publicLifecycle(intent.lifecycle);
      }
      return await this.waitReady(intent.lifecycle.id);
    } catch (e) {
      return {
        ok: false,
        error_code: e instanceof ProviderError ? e.code : "BACKEND_UNAVAILABLE",
      };
    }
  }
}
