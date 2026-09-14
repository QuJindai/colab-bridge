/** Real provider I/O. Errors deliberately contain only stable codes. */
export type ProviderConfig = {
  googleClientId?: string;
  googleClientSecret?: string;
  googleRefreshToken?: string;
  googleQuotaProject?: string;
  externalUrl?: string;
  externalToken?: string;
  agentUrl?: string;
  agentKey?: string;
};
export class ProviderError extends Error {
  code: string;
  resourceAbsent: boolean;
  constructor(code: string, resourceAbsent = false) {
    super(code);
    this.code = code;
    this.resourceAbsent = resourceAbsent;
  }
}
export function safeHttps(value: unknown): string | null {
  try {
    const u = new URL(String(value));
    return u.protocol === "https:" && !!u.hostname && !u.username &&
        !u.password && !u.search && !u.hash && (!u.port || u.port === "443")
      ? u.toString().replace(/\/$/, "")
      : null;
  } catch {
    return null;
  }
}
export async function jsonRequest(
  fetcher: typeof fetch,
  url: string,
  options: RequestInit = {},
  prefix = "PROVIDER",
): Promise<any> {
  try {
    const r = await fetcher(url, {
      ...options,
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) {
      if (r.status === 429) throw new ProviderError("PROVIDER_QUOTA_EXHAUSTED");
      if (r.status === 401) {
        throw new ProviderError(
          prefix === "GOOGLE" ? "GOOGLE_AUTH_FAILED" : `${prefix}_AUTH_FAILED`,
        );
      }
      if (r.status === 403) {
        throw new ProviderError(
          prefix === "GOOGLE"
            ? "GOOGLE_ALLOWLIST_DENIED"
            : `${prefix}_ACCESS_DENIED`,
        );
      }
      if (r.status === 404) throw new ProviderError("PROVIDER_NOT_FOUND");
      throw new ProviderError(`${prefix}_HTTP_ERROR`);
    }
    if (r.status === 204) return {};
    const text = await r.text();
    if (text.length > 1048576) {
      throw new ProviderError("PROVIDER_RESPONSE_INVALID");
    }
    return text ? JSON.parse(text) : {};
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    throw new ProviderError("PROVIDER_UNAVAILABLE");
  }
}
function resourceName(value: unknown, prefix: string): string {
  if (
    typeof value !== "string" ||
    !new RegExp(`^${prefix}/[A-Za-z0-9_-]+(?:/[A-Za-z0-9_-]+)*$`).test(value)
  ) throw new ProviderError("PROVIDER_RESPONSE_INVALID");
  return value;
}
export type ProviderProgress = {
  operation?: string;
  resource?: string;
  provider_ready?: boolean;
  connectionInfo?: any;
};
export class GoogleColabProvider {
  config: ProviderConfig;
  fetcher: typeof fetch;
  token = "";
  tokenExpires = 0;
  constructor(config: ProviderConfig, fetcher: typeof fetch = fetch) {
    this.config = config;
    this.fetcher = fetcher;
  }
  blocker() {
    return this.config.googleClientId && this.config.googleClientSecret &&
        this.config.googleRefreshToken
      ? null
      : "GOOGLE_AUTH_NOT_CONFIGURED";
  }
  async accessToken() {
    if (this.blocker()) throw new ProviderError(this.blocker()!);
    if (this.token && this.tokenExpires > Date.now() + 60000) return this.token;
    const data = await jsonRequest(
      this.fetcher,
      "https://oauth2.googleapis.com/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: this.config.googleClientId!,
          client_secret: this.config.googleClientSecret!,
          refresh_token: this.config.googleRefreshToken!,
        }),
      },
      "GOOGLE",
    );
    if (typeof data.access_token !== "string" || !data.access_token) {
      throw new ProviderError("GOOGLE_AUTH_FAILED");
    }
    this.token = data.access_token;
    this.tokenExpires = Date.now() +
      Math.min(Number(data.expires_in) || 300, 3600) * 1000;
    return this.token;
  }
  async api(path: string, options: RequestInit = {}) {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await this.accessToken()}`,
      "Content-Type": "application/json",
    };
    if (this.config.googleQuotaProject) {
      headers["X-Goog-User-Project"] = this.config.googleQuotaProject;
    }
    try {
      return await jsonRequest(
        this.fetcher,
        "https://colaboratory.googleapis.com/" + path,
        { ...options, headers },
        "GOOGLE",
      );
    } catch (error) {
      // OAuth and operation 404s do not establish that an allocated runtime disappeared.
      if (
        error instanceof ProviderError && error.code === "PROVIDER_NOT_FOUND" &&
        (!options.method || options.method === "GET") &&
        path.startsWith("v1beta/runtimes/")
      ) {
        throw new ProviderError(error.code, true);
      }
      throw error;
    }
  }
  operation(data: any): ProviderProgress {
    if (data.error) {
      const code = data.error.code;
      throw new ProviderError(
        code === 8
          ? "PROVIDER_QUOTA_EXHAUSTED"
          : code === 7
          ? "GOOGLE_ALLOWLIST_DENIED"
          : "PROVIDER_OPERATION_FAILED",
      );
    }
    if (data.done === true) {
      return {
        operation: typeof data.name === "string"
          ? resourceName(data.name, "operations")
          : undefined,
        resource: resourceName(data.response?.name, "runtimes"),
        provider_ready: true,
      };
    }
    return {
      operation: resourceName(data.name, "operations"),
      provider_ready: false,
    };
  }
  async create(
    requestId: string,
    accelerator: string,
  ): Promise<ProviderProgress> {
    await this.api("v1beta/subscription");
    const specs = await this.api("v1beta/runtimespecs");
    if (
      !Array.isArray(specs.runtimeSpecs) ||
      !specs.runtimeSpecs.some((s: any) =>
        s.eligible === true && s.key?.variant === "VARIANT_GPU" &&
        s.key?.accelerator === accelerator && s.key?.shape === "SHAPE_STANDARD"
      )
    ) throw new ProviderError("RUNTIME_SPEC_INELIGIBLE");
    return this.operation(
      await this.api(
        `v1beta/runtimes?requestId=${
          encodeURIComponent(requestId)
        }&runtimeId=cb-${requestId}`,
        {
          method: "POST",
          body: JSON.stringify({
            runtimeSpec: {
              variant: "VARIANT_GPU",
              accelerator,
              shape: "SHAPE_STANDARD",
            },
          }),
        },
      ),
    );
  }
  async status(progress: ProviderProgress): Promise<ProviderProgress> {
    let p = progress;
    if (!p.resource) {
      if (!p.operation) throw new ProviderError("PROVIDER_RESPONSE_INVALID");
      p = this.operation(
        await this.api("v1/" + resourceName(p.operation, "operations")),
      );
    }
    if (!p.resource) return p;
    const runtime = await this.api(
      "v1beta/" + resourceName(p.resource, "runtimes"),
    );
    return {
      ...p,
      provider_ready: true,
      connectionInfo: runtime.connectionInfo,
    };
  }
  async release(progress: ProviderProgress): Promise<ProviderProgress> {
    if (!progress.resource) {
      throw new ProviderError("PROVIDER_RESOURCE_UNKNOWN");
    }
    try {
      await this.api("v1beta/" + resourceName(progress.resource, "runtimes"), {
        method: "DELETE",
      });
    } catch (e) {
      if (!(e instanceof ProviderError) || e.code !== "PROVIDER_NOT_FOUND") {
        throw e;
      }
    }
    return { resource: progress.resource };
  }
}
export class ExternalProvider {
  config: ProviderConfig;
  fetcher: typeof fetch;
  constructor(config: ProviderConfig, fetcher: typeof fetch = fetch) {
    this.config = config;
    this.fetcher = fetcher;
  }
  blocker() {
    return safeHttps(this.config.externalUrl) && this.config.externalToken
      ? null
      : "EXTERNAL_PROVIDER_NOT_CONFIGURED";
  }
  async call(action: string, body: any): Promise<any> {
    if (this.blocker()) throw new ProviderError(this.blocker()!);
    const data = await jsonRequest(
      this.fetcher,
      `${safeHttps(this.config.externalUrl)}/${action}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.externalToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
      "EXTERNAL",
    );
    if (
      !["starting", "ready", "failed", "released"].includes(data.state) ||
      typeof data.resource_id !== "string" ||
      !/^[A-Za-z0-9_-]{1,200}$/.test(data.resource_id)
    ) throw new ProviderError("PROVIDER_RESPONSE_INVALID");
    if (data.state === "failed") {
      throw new ProviderError("EXTERNAL_PROVIDER_FAILED");
    }
    return data;
  }
  async create(
    requestId: string,
    accelerator: string,
    expectedAgentId?: string,
  ): Promise<ProviderProgress> {
    const d = await this.call("wake", {
      request_id: requestId,
      accelerator,
      expected_agent_id: expectedAgentId,
    });
    return { resource: d.resource_id, provider_ready: d.state === "ready" };
  }
  async status(p: ProviderProgress): Promise<ProviderProgress> {
    const d = await this.call("status", { resource_id: p.resource });
    if (d.resource_id !== p.resource) {
      throw new ProviderError("PROVIDER_RESPONSE_INVALID");
    }
    return { resource: d.resource_id, provider_ready: d.state === "ready" };
  }
  async release(p: ProviderProgress): Promise<ProviderProgress> {
    const d = await this.call("release", { resource_id: p.resource });
    if (d.resource_id !== p.resource) {
      throw new ProviderError("PROVIDER_RESPONSE_INVALID");
    }
    return { resource: d.resource_id, provider_ready: d.state === "released" };
  }
}
