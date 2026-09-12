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

ChatGPT custom apps are configured from Developer Mode by providing the remote MCP endpoint and choosing the authentication mechanism available in the UI. v0.1 tools are all annotated read-only; no write/modify tool is exposed.

## 6. Acceptance

In Colab, run a local `nvidia-smi` check. Then call:

- `colab_gpu_status`
- `colab_runtime_status`
- `colab_health`

Confirm GPU count, model, VRAM and freshness match the local runtime. Stop the Colab runtime and verify it becomes stale after 60 seconds instead of being reported as live.
