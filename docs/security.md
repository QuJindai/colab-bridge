# Security model

## Trust boundaries

Colab Bridge separates the MCP caller from the Colab runtime with two HTTPS services and two independent credentials.

- The MCP endpoint accepts a bridge key only.
- The agent endpoint accepts an agent key only.
- Raw keys are not stored in database tables; only SHA-256 hashes are stored.
- Supabase Edge Functions use the platform-provided service role credential internally and never return it.

## Observation-only policy

The v0.1 public surface does not contain arbitrary execution capabilities. The agent accepts only these command types:

- `refresh_gpu`
- `refresh_runtime`
- `refresh_processes`

Unknown operations and command types are rejected. GPU collection uses fixed `nvidia-smi` query arguments compiled into the agent source.

## Data minimization

The bridge does not intentionally collect notebook source, Google account email, Google OAuth tokens, Drive contents, browser cookies, environment-variable dumps, shell history, full command lines, model weights, or arbitrary filesystem paths.

GPU UUIDs are reduced to a suffix in the public telemetry model. GPU process data is limited to PID, process name, GPU index when available, and GPU memory usage.

## Stale-data handling

A runtime older than 60 seconds is marked stale. GPU tools do not return stale GPU arrays as if they were current. After five minutes without a heartbeat the runtime is classified offline.

## Public repository rule

Do not commit deployment URLs containing private environment details, raw access keys, service-role keys, notebook tokens, cookies, or captured user telemetry. `.env` and `*.key` are ignored by Git.
