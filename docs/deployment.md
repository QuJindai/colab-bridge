# Deployment

## 1. Apply the database migration

Apply `supabase/migrations/20260912_colab_bridge.sql` to the target Supabase project.

The migration creates:

- `colab_bridge_access_keys`
- `colab_bridge_runtimes`
- `colab_bridge_snapshots`
- `colab_bridge_commands`
- `colab_bridge_results`

RLS is enabled and table access is revoked from `anon` and `authenticated`; Edge Functions use the Supabase-provided service role internally.

## 2. Generate independent keys

Generate separate high-entropy values for the bridge and agent. Store only their SHA-256 hashes in `colab_bridge_access_keys` with `key_kind` values `bridge` and `agent`.

Never commit the raw values.

## 3. Deploy Edge Functions

Deploy:

- `supabase/functions/colab-bridge-agent`
- `supabase/functions/colab-bridge-mcp`

Both functions use custom key authentication and therefore are deployed with platform JWT verification disabled. Their own code rejects unauthorized requests before processing telemetry or MCP messages.

## 4. Start Colab Agent

Use `notebooks/colab_bridge_bootstrap.ipynb`. Supply the agent endpoint and agent key only at runtime.

## 5. Configure the MCP app

Configure the remote MCP endpoint as the deployed `colab-bridge-mcp` function. The server accepts the same bridge key through three compatible transports, in this priority order:

1. `X-Colab-Bridge-Key: <bridge-key>` (preferred when the client supports a custom API-key header);
2. `Authorization: Bearer <bridge-key>`;
3. endpoint fallback `...?access_token=<bridge-key>` for a no-auth custom-app setup that cannot inject headers.

The endpoint-token form is a compatibility fallback because URLs can be retained in client/server logs. Use a dedicated, rotatable bridge key and never reuse the Agent key.

ChatGPT custom apps are configured from Developer Mode by providing the remote MCP endpoint and choosing the authentication mechanism available in the UI. The seven original telemetry tools stay read-only. v0.2 adds separately authorized execution and lifecycle tools described below.

## 6. Acceptance

In Colab, run a local `nvidia-smi` check. Then call:

- `colab_gpu_status`
- `colab_runtime_status`
- `colab_health`

Confirm GPU count, model, VRAM and freshness match the local runtime. Stop the Colab runtime and verify it becomes stale after 60 seconds instead of being reported as live.

## v0.2 execution and lifecycle deployment

Apply the two additional migrations in timestamp order:

- `20260912154108_colab_bridge_jobs.sql`
- `20260914113920_colab_bridge_lifecycle_integration.sql`

Keep the existing `bridge` and `agent` hashes unchanged. Add an independently generated control key hash with `key_kind='control'`; never share the raw Agent key with the MCP client. The same MCP endpoint accepts either bridge or control credentials through the existing header/Bearer/query transports. Configure a separate control connection in ChatGPT where the existing connection URL cannot be edited. Bridge credentials can still use all seven telemetry tools and read durable jobs/artifacts; all 18 added mutations require control, including `colab_wait_ready`. Lookup failures return HTTP 503 `BACKEND_UNAVAILABLE`; absent/invalid credentials return 401 `UNAUTHORIZED`.

The server now exposes 31 tools. `colab_capabilities` reports the captured auth role, live execution readiness, provider configuration blockers and recipe dependency status. A configured provider is reported as unverified until an actual provider/Agent path succeeds; config presence is not a successful cold start. Jobs may queue without an online runtime. `colab_read_artifact` returns a 300-second signed download URL, with no unbounded inline preview. `colab_job_logs` returns at most 65,536 text characters per call, complete event chunks, `next_after` and `has_more`; use the cursor to continue.

Runtime versions: Python >=3.10 and Node >=22. Exact npm pins are Supabase `2.116.0`, MCP server `2.0.0`, Zod `4.6.5`, `ws` `8.21.3`, and `@types/ws` `8.18.1`. The notebook and automated bootstrap install `httpx==0.28.1` explicitly, then replace only the Agent wheel with `--no-deps --force-reinstall`. Optional model/export/Drive extras in `pyproject.toml` remain opt-in; preserve the runtime's CUDA Torch installation.

### Google Colab provider

Set these **backend Edge Function secrets**, not tool arguments:

| Environment variable | Purpose |
| --- | --- |
| `COLAB_GOOGLE_CLIENT_ID` | OAuth application client ID |
| `COLAB_GOOGLE_CLIENT_SECRET` | OAuth application secret |
| `COLAB_GOOGLE_REFRESH_TOKEN` | User refresh token with `https://www.googleapis.com/auth/colaboratory` scope |
| `COLAB_GOOGLE_QUOTA_PROJECT` | Optional API quota project header |
| `COLAB_BOOTSTRAP_AGENT_URL` | HTTPS Agent endpoint without credentials/query/fragment |
| `COLAB_BOOTSTRAP_AGENT_KEY` | Raw Agent key, retained only in backend memory and dedicated kernel config |

The Google project must be admitted to the Colab API beta allowlist and the account must have an eligible subscription/runtime specification. Missing OAuth yields `GOOGLE_AUTH_NOT_CONFIGURED`; missing bootstrap settings yield `BOOTSTRAP_NOT_CONFIGURED` before allocation. HTTP 403, quota exhaustion, ineligible specs and failed Operations remain distinct errors. The adapter calls the [official Colab runtime API](https://developers.google.com/colab/api/reference/rest/v1beta/runtimes), authenticates Jupyter using `X-Colab-Runtime-Proxy-Token`, creates one dedicated Python kernel, and executes the embedded Agent payload through WebSocket channels. It never clears a user notebook or interrupts another kernel. Proxy tokens and Jupyter code are not persisted in lifecycle rows or server logs. `store_history=false`, `allow_stdin=false` and silent execution keep the bootstrap out of normal kernel history/output.

```json
{"tool":"colab_ensure_runtime","arguments":{"provider":"google_colab","accelerator":"T4","request_id":"11111111-1111-4111-8111-111111111111"}}
```

`accelerator` defaults to `T4` and selects an eligible `VARIANT_GPU` / `SHAPE_STANDARD` spec. `request_id` is optional UUID4. Reusing it with a different normalized provider/accelerator fails. Equivalent active requests coalesce atomically, and a fresh matching execution-enabled Agent is reused. Managed-runtime reuse keeps a reference to the original allocation owner, including across requested providers; release follows that owner and its provider mapping. A definitive authenticated Google runtime GET 404 retires that allocation, so a subsequent fresh request ID can allocate again while old request IDs remain bound to their terminal result. OAuth/operation 404s and uncertain-create probes do not establish absence. No fallback provider is invoked after a failure. Call `colab_wait_ready` with the returned `lifecycle_id` to advance bounded work; this is a poll operation, not a background scheduler. Status progresses through `accepted`, `starting`, `bootstrapping`, `ready`, `blocked` or `failed`. Only a matching expected Agent UUID with a live heartbeat, execution enabled, non-draining state and a <=60-second matching GPU snapshot is ready. A successful create/Operation/Jupyter reply alone does not qualify.

Call `colab_release_runtime` with **exactly one** of `runtime_id` or `lifecycle_id`; the latter supports releasing an allocation before Agent registration. `cancel_jobs` defaults to false. Active jobs block release unless explicitly cancelled, and provider deletion waits until all runtime jobs are terminal. A dedicated draining flag blocks new claims, affinity submissions and affinity-preserving retries, survives Agent register/heartbeat, and preserves runtime/job/artifact audit rows. Release intent survives an in-flight allocation call. Already-dispatched network work may finish; it cannot overwrite release intent or make the runtime eligible for new jobs. Repeated release after `released` does not delete twice. `wait_ready` also advances pending release. A reused manual runtime without a provider resource mapping returns `PROVIDER_RESOURCE_UNKNOWN` instead of claiming an allocation was deleted. If Google create times out before returning an operation, release performs a read-only lookup of its deterministic runtime name and deletes it only once found. A lookup 404 remains blocked because creation could still be in flight. An external wake response lost before a resource ID remains blocked pending provider-side reconciliation; no new wake is issued during release.

### External wake adapter

Set `COLAB_EXTERNAL_WAKE_URL` to a trusted HTTPS base URL without credentials/query/fragment, and `COLAB_EXTERNAL_WAKE_TOKEN` to its backend-held bearer credential. The service behind that endpoint must independently provision the runtime and configure/start the Agent using its own secret store. It must implement idempotent wake keyed by `request_id`, support the expected Agent UUID, and track resource readiness independently of Colab Agent telemetry.

| Fixed POST path | Request body | Response body |
| --- | --- | --- |
| `/wake` | `{request_id, accelerator, expected_agent_id}` | `{state:"starting"\|"ready"\|"failed", resource_id}` |
| `/status` | `{resource_id}` | Same shape |
| `/release` | `{resource_id}` | `{state:"starting"\|"released"\|"failed", resource_id}` |

Each request uses `Authorization: Bearer <backend credential>`, JSON and a 15-second timeout. Redirects are refused. Resource IDs contain 1..200 letters, digits, `_` or `-`. The caller cannot supply a URL, token or polling host, and any response URL is ignored. An external `ready` response still requires the matching fresh Agent GPU before lifecycle readiness. An external provider that is not configured reports `EXTERNAL_PROVIDER_NOT_CONFIGURED`; unavailable/failed services do not trigger Google allocation.

### Durable checkpoint retry

`colab_retry_job` accepts `{job_id, idempotency_key, checkpoint_path?}`. It creates a new linked job, preserves project/kind/timeout/GPU requirement/requested affinity, and restores all parent published artifacts through five-minute signed URLs. It does not expose an arbitrary spec patch. Existing no-option calls remain supported. Explicit checkpoint selection is limited to `pipeline` and `lora`, must be a safe workspace-relative path, and must name an exact published checkpoint marker belonging to that parent. The selection is part of durable idempotency equivalence; conflicting reuse fails.

```json
{"tool":"colab_retry_job","arguments":{"job_id":"22222222-2222-4222-8222-222222222222","idempotency_key":"resume-selected-step-2","checkpoint_path":".colab-bridge/checkpoints/pipeline-RUN/step-0002/checkpoint.json"}}
```

For pipelines select the `step-N/checkpoint.json` file; retry also sets `resume=true`. For LoRA select the `checkpoints/<run>-step-N` directory; the exact `<checkpoint_path>/checkpoint.json` must already be published. A different file under that directory is insufficient. Resume restores/validates published file snapshots, not package installations, environment changes or external side effects; review partially executed arbitrary code before explicitly resuming. No arbitrary code is automatically replayed after a lost lease.

### Rebuild and validate bootstrap

```bash
python -m pip wheel --no-deps --wheel-dir dist .
python scripts/build_notebook.py --wheel dist/colab_bridge_agent-0.2.0-py3-none-any.whl \
  --notebook notebooks/colab_bridge_bootstrap.ipynb \
  --bootstrap-module supabase/shared/bootstrap_payload.ts
npm ci
npm test
DENO_TLS_CA_STORE=system deno check --node-modules-dir=auto \
  supabase/functions/colab-bridge-mcp/index.ts supabase/functions/colab-bridge-agent/index.ts
```

Regenerate **both** embedded outputs after the final Python changes. Both bootstrap paths share a small environment allowlist for pip, retaining ordinary proxy and TLS certificate settings while rejecting URL userinfo, query/fragment credentials and unrecognized settings. The generator verifies wheel metadata, required Agent modules and SHA-256, and emits one self-contained notebook code cell without saved credentials. The interactive cell asks for execution opt-in unless `COLAB_BRIDGE_EXECUTION_ENABLED=1`, honors a validated optional `COLAB_BRIDGE_RUNTIME_ID`, validates URL/label, and provides `stop_colab_bridge()`. If registry access is unavailable but `npm ci` succeeded, local type validation can use `deno check --cached-only --node-modules-dir=manual` against those exact installed packages; this does not replace the Edge deployment/bundling gate.

The covering tests exercise real SDK handlers, actual local WebSocket messages, and PostgreSQL-compatible SQL through PGlite. PGlite has one connection and does not prove cloud concurrency. Acceptance still requires an eligible real provider cold start, GPU job, production Storage behavior and native ChatGPT control-key confirmation. No such cloud/GPU acceptance is implied by local tests.
