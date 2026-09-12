# Colab Bridge v0.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and deploy a read-only MCP bridge that lets ChatGPT/Codex retrieve fresh GPU and runtime telemetry from a live Google Colab runtime through the user's existing Supabase project.

**Architecture:** A Python Colab Agent performs fixed local probes and sends heartbeats/snapshots outbound to a Supabase agent Edge Function. A separate Supabase MCP Edge Function reads the latest stored telemetry and exposes read-only MCP tools over Streamable HTTP. PostgreSQL provides runtime/snapshot persistence and stores only hashes of the app/agent access keys.

**Tech Stack:** Python 3.10+, pytest, httpx, TypeScript/Deno, Model Context Protocol TypeScript SDK, Supabase Edge Functions/PostgreSQL, Node 22 + Vitest for local TypeScript contract tests.

**Spec:** `docs/superpowers/specs/2026-09-12-colab-bridge-design.md`

## Global Constraints

- v0.1 is observation-only and MUST NOT expose arbitrary Python, shell, notebook, file, Drive, or package-install execution.
- Agent heartbeat target is 20 seconds; `live <= 60s`, `stale > 60s`, `offline > 300s`.
- MCP and agent credentials are distinct; raw credentials MUST NOT be committed or stored in database tables.
- MCP tools MUST be annotated read-only for ChatGPT Pro compatibility.
- Agent API accepts only `register`, `heartbeat`, `snapshot`, `poll`, and `result` operations and fixed command types `refresh_gpu`, `refresh_runtime`, `refresh_processes`.
- Public repository MUST NOT contain the user's Supabase project ref, keys, notebook tokens, cookies, or identifiable telemetry.

---

## File map

- `agent/colab_bridge_agent/models.py`: telemetry dataclasses and freshness classification.
- `agent/colab_bridge_agent/probes.py`: fixed safe runtime/GPU/process probes.
- `agent/colab_bridge_agent/client.py`: outbound authenticated agent API client.
- `agent/colab_bridge_agent/main.py`: heartbeat/snapshot loop.
- `agent/tests/`: Python unit tests.
- `supabase/shared/auth.ts`: constant-time SHA-256 key verification helper.
- `supabase/shared/freshness.ts`: runtime freshness calculation.
- `supabase/functions/colab-bridge-agent/index.ts`: fixed agent HTTP API.
- `supabase/functions/colab-bridge-mcp/index.ts`: read-only MCP endpoint and tools.
- `supabase/migrations/20260912_colab_bridge.sql`: tables, indexes, retention-safe schema.
- `tests/`: TypeScript helper/contract tests.
- `notebooks/colab_bridge_bootstrap.ipynb`: one-cell Colab bootstrap.
- `README.md`, `docs/security.md`, `docs/deployment.md`: operator documentation.

### Task 1: Python telemetry model and fixed probes

**Files:**
- Create: `pyproject.toml`
- Create: `agent/colab_bridge_agent/__init__.py`
- Create: `agent/colab_bridge_agent/models.py`
- Create: `agent/colab_bridge_agent/probes.py`
- Test: `agent/tests/test_models.py`
- Test: `agent/tests/test_probes.py`

**Interfaces:**
- Produces: `classify_runtime_age(age_seconds: float) -> str`
- Produces: `collect_runtime_snapshot() -> dict`
- Produces: `collect_gpu_snapshot() -> dict`
- Produces: `collect_process_snapshot() -> dict`

- [ ] **Step 1: Write failing model freshness tests** for boundaries 60s and 300s.
- [ ] **Step 2: Run `pytest agent/tests/test_models.py -v` and verify RED.**
- [ ] **Step 3: Implement minimal freshness/model helpers.**
- [ ] **Step 4: Run model tests and verify GREEN.**
- [ ] **Step 5: Write failing probe parsing tests** using deterministic `nvidia-smi --query-gpu` CSV and CPU-only behavior.
- [ ] **Step 6: Run probe tests and verify RED.**
- [ ] **Step 7: Implement fixed subprocess queries only; no caller-controlled command arguments.**
- [ ] **Step 8: Run all Python tests and verify GREEN.**

### Task 2: Colab Agent client and loop

**Files:**
- Create: `agent/colab_bridge_agent/config.py`
- Create: `agent/colab_bridge_agent/client.py`
- Create: `agent/colab_bridge_agent/main.py`
- Test: `agent/tests/test_client.py`

**Interfaces:**
- Produces: `AgentConfig.from_env()`
- Produces: `AgentClient.register(snapshot: dict)`, `heartbeat(snapshot: dict)`, `snapshot(kind: str, payload: dict)`, `poll()`, `result(...)`
- Produces: `run_agent(config: AgentConfig, stop_event=None)`

- [ ] **Step 1: Write failing tests** that assert agent-key header, payload size cap, request timeout, and unknown command rejection.
- [ ] **Step 2: Run `pytest agent/tests/test_client.py -v` and verify RED.**
- [ ] **Step 3: Implement the minimal HTTP client and allow-listed command dispatch.**
- [ ] **Step 4: Run client tests and all Python tests, verify GREEN.**

### Task 3: PostgreSQL schema and shared TypeScript helpers

**Files:**
- Create: `supabase/migrations/20260912_colab_bridge.sql`
- Create: `supabase/shared/auth.ts`
- Create: `supabase/shared/freshness.ts`
- Create: `package.json`
- Create: `tests/auth.test.ts`
- Create: `tests/freshness.test.ts`

**Interfaces:**
- Produces tables: `colab_bridge_runtimes`, `colab_bridge_snapshots`, `colab_bridge_commands`, `colab_bridge_results`, `colab_bridge_access_keys`.
- Produces: `verifyKey(raw: string, storedHash: string): Promise<boolean>`
- Produces: `runtimeState(lastHeartbeat: string, now?: Date): {status, ageSeconds}`

- [ ] **Step 1: Write failing Vitest tests** for SHA-256 verification and live/stale/offline boundaries.
- [ ] **Step 2: Run `npm test -- --run tests/auth.test.ts tests/freshness.test.ts` and verify RED.**
- [ ] **Step 3: Implement minimal shared helpers and schema.**
- [ ] **Step 4: Run TypeScript tests and verify GREEN.**

### Task 4: Agent Edge Function

**Files:**
- Create: `supabase/functions/colab-bridge-agent/index.ts`
- Create: `supabase/functions/colab-bridge-agent/deno.json`
- Create: `supabase/shared/agent_logic.ts`
- Test: `tests/agent_logic.test.ts`

**Interfaces:**
- HTTP JSON body union with operations `register`, `heartbeat`, `snapshot`, `poll`, `result`.
- Uses `X-Colab-Agent-Key` and database hash verification.

- [ ] **Step 1: Write failing pure logic tests** for allowed operations, payload validation, and fixed command-type filtering.
- [ ] **Step 2: Run targeted Vitest and verify RED.**
- [ ] **Step 3: Implement validation/normalization helpers.**
- [ ] **Step 4: Implement Edge handler around Supabase client using those helpers.**
- [ ] **Step 5: Run all TypeScript tests and verify GREEN.**

### Task 5: MCP Edge Function

**Files:**
- Create: `supabase/functions/colab-bridge-mcp/index.ts`
- Create: `supabase/functions/colab-bridge-mcp/deno.json`
- Create: `supabase/shared/mcp_tools.ts`
- Test: `tests/mcp_tools.test.ts`

**Interfaces:**
- MCP tools: `colab_capabilities`, `colab_list_runtimes`, `colab_gpu_status`, `colab_runtime_status`, `colab_nvidia_smi`, `colab_processes`, `colab_health`.
- Every tool annotated `readOnlyHint: true`.
- Auth: `X-Colab-Bridge-Key`, verified from database hash.

- [ ] **Step 1: Write failing tests** for tool catalog, read-only annotations, stale/no-runtime/no-GPU normalization, and secret-free output.
- [ ] **Step 2: Run targeted Vitest and verify RED.**
- [ ] **Step 3: Implement tool metadata and response normalization.**
- [ ] **Step 4: Implement Streamable HTTP MCP server and Supabase read queries.**
- [ ] **Step 5: Run all TypeScript tests and verify GREEN.**

### Task 6: Bootstrap notebook and operator docs

**Files:**
- Create: `notebooks/colab_bridge_bootstrap.ipynb`
- Create: `README.md`
- Create: `docs/security.md`
- Create: `docs/deployment.md`
- Create: `.gitignore`
- Create: `LICENSE`

**Interfaces:**
- Bootstrap cell installs the local package from GitHub or uploaded wheel/source and requires only endpoint plus agent key as user-supplied runtime variables.

- [ ] **Step 1: Add a notebook structure validation test.**
- [ ] **Step 2: Verify test fails before notebook exists.**
- [ ] **Step 3: Create one-cell bootstrap notebook and documentation.**
- [ ] **Step 4: Re-run full Python and TypeScript suites.**

### Task 7: Deploy and acceptance

**Files:**
- No committed secret-bearing files.

**Interfaces:**
- Existing Supabase project `QuJindai's Project` is the deployment target, but its project ref is supplied only to deployment tools and never committed.

- [ ] **Step 1: Generate independent random bridge and agent keys locally; store only SHA-256 hashes in Supabase.**
- [ ] **Step 2: Apply migration through Supabase migration tooling.**
- [ ] **Step 3: Deploy `colab-bridge-agent` and `colab-bridge-mcp` with `verify_jwt=false` because custom key auth is implemented.**
- [ ] **Step 4: Seed key hashes through SQL without committing them.**
- [ ] **Step 5: Run unauthorized/authorized HTTP smoke tests against both endpoints.**
- [ ] **Step 6: Run Supabase security advisors and remediate issues caused by this schema.**
- [ ] **Step 7: Create/push the public `QuJindai/colab-bridge` repository when repository-creation capability is available; otherwise leave a complete verified local Git repository and report the connector limitation precisely.**
- [ ] **Step 8: Report the exact one-cell Colab bootstrap values needed for live GPU acceptance without exposing the bridge MCP key in repository content.**
