# Colab Bridge Design

**Date:** 2026-09-12  
**Status:** Approved architecture, awaiting written-spec review  
**Repository target:** `QuJindai/colab-bridge` (public)  
**Deployment target:** existing Supabase project, project reference injected at deploy time and never committed

## 1. Goal

Build a reusable ChatGPT/Codex MCP app that reports the true state of the user's currently running Google Colab runtime, beginning with GPU inventory, VRAM, CUDA/driver, utilization, processes, runtime health, and heartbeat status.

The first release is observation-only. It must not expose arbitrary notebook code execution, shell execution, Jupyter tokens, Google credentials, Drive credentials, or inbound Colab ports.

## 2. Success criteria

A connected Colab notebook runs one bootstrap cell that starts the Colab Agent. After that, ChatGPT can call the remote MCP endpoint and obtain fresh data from the current runtime.

Release v0.1 is accepted when all of the following pass:

1. `colab_capabilities` returns service version and supported tools without a live Colab runtime.
2. `colab_list_runtimes` reports registered runtimes and marks stale runtimes explicitly.
3. `colab_gpu_status` returns actual GPU count/model/VRAM/usage/driver/CUDA data from a live runtime.
4. `colab_runtime_status` returns heartbeat age, Python/PyTorch/platform/runtime metadata and accelerator type.
5. `colab_nvidia_smi` returns a sanitized structured view, not unrestricted command output.
6. `colab_processes` returns GPU process metadata available through NVIDIA telemetry.
7. A stopped/disconnected Colab becomes stale automatically without breaking the MCP server.
8. MCP endpoint survives Colab runtime replacement because Colab only makes outbound HTTPS calls.
9. No secret is present in repository files, MCP tool responses, or logs.
10. Automated tests cover protocol validation, stale-runtime behavior, authentication, telemetry parsing, and the mock end-to-end round trip.

## 3. Architecture

```text
ChatGPT / Codex
      |
      | MCP Streamable HTTP
      v
Supabase Edge Function: colab-bridge-mcp
      |
      +--> PostgreSQL tables / RPC
      |      runtimes
      |      runtime_snapshots
      |      agent_commands
      |      agent_results
      |
      +--> custom app access key guard
      |
      v
Supabase HTTPS endpoints
      ^
      | outbound poll / heartbeat / result upload
      |
Google Colab Agent
      |
      +--> pynvml / nvidia-smi (fixed queries only)
      +--> torch.cuda (if installed)
      +--> Python/platform/runtime metadata
```

The MCP endpoint is stable. The Colab Agent never accepts inbound network connections. A Colab reconnect or GPU reassignment produces a new runtime session and heartbeat while the MCP URL remains unchanged.

## 4. Components

### 4.1 MCP Edge Function

A Supabase Edge Function implemented in TypeScript/Deno using the official Model Context Protocol TypeScript SDK and `WebStandardStreamableHTTPServerTransport`.

Responsibilities:

- expose MCP tools;
- validate a single-user app access key supplied as a header;
- read current runtime/snapshot state;
- enqueue fixed, allow-listed telemetry refresh requests where needed;
- return structured JSON/text suitable for ChatGPT;
- never execute arbitrary SQL, Python, notebook code, or shell supplied by a caller.

### 4.2 Agent HTTP API

A second Supabase Edge Function, `colab-bridge-agent`, handles Colab Agent traffic.

Responsibilities:

- register a runtime session;
- validate an agent device key;
- receive heartbeat and telemetry snapshots;
- allow the agent to poll fixed command types;
- receive command results;
- reject unknown command types and oversized payloads.

The agent API and MCP API use separate credentials.

### 4.3 Colab Agent

A small Python package designed to run inside a Colab notebook.

Responsibilities:

- create a random `runtime_id` per Colab runtime session;
- collect runtime metadata;
- collect GPU telemetry using safe fixed probes;
- heartbeat periodically;
- poll fixed telemetry commands;
- upload sanitized results;
- shut down cleanly when the notebook process exits.

It does not request or store the user's Google password, Google OAuth token, notebook token, or browser cookies.

### 4.4 Persistence

PostgreSQL stores only operational metadata and recent telemetry. Initial schema:

- `colab_bridge_runtimes`: one row per runtime session;
- `colab_bridge_snapshots`: recent structured snapshots;
- `colab_bridge_commands`: allow-listed command queue;
- `colab_bridge_results`: command outcomes.

Rows carry timestamps and runtime IDs. Secrets are represented by non-reversible hashes where comparison is required. Raw access keys are never stored in tables.

## 5. MCP tools in v0.1

### `colab_capabilities`
No input. Returns service version, observation-only scope, supported telemetry, and whether a live runtime is currently available.

### `colab_list_runtimes`
Optional `include_stale: boolean = false`. Returns runtime ID, label, accelerator, created time, last heartbeat time, heartbeat age, and status.

### `colab_gpu_status`
Optional `runtime_id`. Returns one object per GPU:

- index;
- model name;
- UUID suffix only, never full identifiers if not needed;
- VRAM total/used/free MiB;
- utilization percent;
- temperature Celsius when available;
- power draw/limit when available;
- driver version;
- CUDA version reported by NVIDIA;
- PyTorch CUDA availability and compute capability when available.

### `colab_runtime_status`
Optional `runtime_id`. Returns runtime session status, heartbeat age, Python version, OS/kernel, Colab marker, accelerator type, PyTorch version, and uptime available to the agent.

### `colab_nvidia_smi`
Optional `runtime_id`. Returns only the predefined NVIDIA telemetry fields used by the service. It must not accept arbitrary CLI arguments.

### `colab_processes`
Optional `runtime_id`. Returns NVIDIA-compute process PID, executable/process name when available, GPU index, and GPU memory usage. It does not expose process environment variables or command lines.

### `colab_health`
No input. Returns backend availability, database reachability, most recent runtime heartbeat age, schema version, and service version. No secrets.

### `colab_disconnect`
Deferred from v0.1 public MCP surface. Disconnect is a write action and is intentionally excluded from the Pro observation-only first release.

## 6. Freshness model

- Agent heartbeat target: every 20 seconds.
- Runtime `live`: last heartbeat <= 60 seconds.
- Runtime `stale`: heartbeat > 60 seconds.
- Runtime `offline`: heartbeat > 5 minutes.
- GPU snapshots are timestamped; MCP responses always return `observed_at` and `age_seconds`.
- The MCP server must never present cached GPU data as live without its age.

## 7. Security model

The public MCP URL is no-auth at the platform JWT layer so ChatGPT can reach it, but the function implements custom authentication.

### MCP credential

- header: `X-Colab-Bridge-Key`;
- compared against a server-side secret;
- never returned by tools or logs;
- rate-limited per key/IP where supported.

### Agent credential

- header: `X-Colab-Agent-Key`;
- distinct from MCP credential;
- stored only in Colab environment/user-provided bootstrap variable and Supabase function secrets;
- runtime registration does not mint a more privileged credential.

### Command allow-list

v0.1 command types are fixed constants only:

- `refresh_gpu`;
- `refresh_runtime`;
- `refresh_processes`.

No `exec`, `shell`, `python`, `notebook`, `eval`, file read/write, Drive access, package install, model download, or arbitrary command field exists in v0.1.

## 8. Data minimization

Do not store:

- notebook source;
- Google account email;
- Google OAuth tokens;
- Drive file contents;
- shell history;
- environment variables;
- full process command lines;
- model weights;
- arbitrary filesystem paths.

Store only what is necessary to identify a runtime session and describe compute state.

## 9. Repository layout

```text
colab-bridge/
  README.md
  LICENSE
  pyproject.toml
  agent/
    colab_bridge_agent/
      __init__.py
      client.py
      config.py
      probes.py
      models.py
      main.py
    tests/
      test_probes.py
      test_client.py
      test_models.py
  notebooks/
    colab_bridge_bootstrap.ipynb
  supabase/
    migrations/
      20260912_colab_bridge.sql
    functions/
      colab-bridge-mcp/
        index.ts
        deno.json
      colab-bridge-agent/
        index.ts
        deno.json
  tests/
    mcp_contract_test.ts
    agent_api_contract_test.ts
  docs/
    superpowers/
      specs/
      plans/
    security.md
    deployment.md
```

## 10. Error behavior

Errors are explicit and structured:

- `NO_RUNTIME`: no registered runtime exists;
- `RUNTIME_STALE`: a runtime exists but heartbeat is too old;
- `NO_GPU`: live runtime has no NVIDIA GPU;
- `TELEMETRY_UNAVAILABLE`: a probe is unavailable while runtime remains live;
- `UNAUTHORIZED`: supplied bridge/agent credential is invalid;
- `COMMAND_TIMEOUT`: requested refresh did not complete inside the bounded wait;
- `BACKEND_ERROR`: database or Edge Function failure.

Tool responses distinguish absence, staleness, and backend failure.

## 11. Testing strategy

### Unit tests

- parse representative `nvidia-smi` CSV/XML output;
- PyTorch-present and PyTorch-absent paths;
- CPU-only runtime;
- one GPU and multi-GPU snapshots;
- stale heartbeat classification;
- secret comparison and unauthorized calls;
- reject unknown command types.

### Contract tests

- MCP `initialize` / `tools/list` / `tools/call` against the Edge Function handler;
- agent register/heartbeat/snapshot/poll/result APIs;
- required `Accept: application/json, text/event-stream` behavior.

### Mock end-to-end

A local fake Colab agent sends a deterministic two-GPU snapshot. MCP `colab_gpu_status` must return exactly those two GPUs with correct freshness metadata.

### Live acceptance

Run bootstrap in a real Colab runtime, then call the MCP tool and compare the returned GPU model/count/VRAM with a notebook-local `nvidia-smi` result.

## 12. Deployment

- Reuse the user's existing healthy Supabase project.
- Deploy both functions through Supabase deployment tooling.
- `verify_jwt=false` only because each function implements its own fixed-key authentication.
- Store bridge and agent keys as project/function secrets; never hardcode them.
- Apply the SQL migration before function deployment.
- Run Supabase security advisors after DDL changes.

## 13. ChatGPT integration

The ChatGPT custom app points to:

`https://<project-ref>.supabase.co/functions/v1/colab-bridge-mcp`

The app is observation-only in v0.1. Tools are scanned from the MCP server. The app should be named `Colab Bridge` and describe itself as a live compute telemetry bridge.

## 14. Non-goals for v0.1

- arbitrary notebook cell execution;
- shell execution;
- file browser;
- Google Drive access;
- model training orchestration;
- GPU reservation or Colab plan management;
- starting a Colab runtime remotely;
- keeping a Colab runtime alive against platform policy;
- multi-user tenancy;
- interactive UI widgets.

These may be evaluated in later versions only after v0.1 telemetry is stable.

## 15. Public-repository rules

The public repository must contain only source, tests, docs, and placeholders. It must not contain project refs tied to the user's environment, access keys, service-role keys, notebook tokens, cookies, or generated telemetry containing identifiable account information.

The upstream/runtime dependencies and licenses are documented in `README.md` and `LICENSE`.
