# Colab Bridge v0.2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade Colab Bridge into a durable GPU job service with runtime lifecycle, experiments and artifact persistence.

**Architecture:** Preserve the existing MCP and Agent endpoints. Add a leased PostgreSQL job API, an independent Agent subprocess worker, reusable model recipes, and external runtime lifecycle providers. Validate each component before cloud and real-runtime integration.

**Tech Stack:** Python >=3.10, Node >=22, Deno/Supabase Edge Functions, PostgreSQL, private Supabase Storage, httpx, Transformers/PEFT/Hugging Face/ModelScope adapters.

**Spec:** docs/superpowers/specs/2026-09-12-colab-bridge-v2-design.md

## Global Constraints

- Python >=3.10; Node >=22; TypeScript files remain testable by node --experimental-strip-types.
- Version is 0.2.0. Existing seven telemetry tools and their endpoint remain compatible.
- Exactly one active job per runtime. Default timeout 900 seconds; accepted range 1..3600 seconds. Log chunks are bounded at 8192 characters.
- Lease duration is 60 seconds, renewed every 10 seconds; every mutation is fenced by runtime_id, job_id and lease_token.
- Read key remains read-only. New mutations require an independent control key. Agent execution requires COLAB_BRIDGE_EXECUTION_ENABLED=1.
- No raw credentials in source, artifacts, logs or child-process environment. New database tables have RLS and service-role-only access/RPCs.
- No automatic replay of arbitrary code after a lost lease. Retry produces a new linked job.
- External API availability is reported, not assumed. No cold-start acceptance claim without a real eligible provider and GPU job.

## Task 1: Durable job protocol and Agent backend

**Files:** create supabase/shared/jobs.ts, supabase/shared/job_api.ts, tests/jobs.test.ts and a CLI-generated migration; modify supabase/functions/colab-bridge-agent/index.ts only to route validated job operations. Keep old validation/tests intact.

**Interfaces:** export validateJobRequest(input), normalizeJobRequest(input), jobRequestHash(input), isTerminal(status), assertLease(job,runtimeId,token,now); export JobService(db) with submit(input), list(filters), status(id), logs(id,after,limit), cancel(id), retry(id,key), claim(runtimeId), heartbeat(body), log(body), complete(body), prepareArtifact(body), completeArtifact(body), artifacts(jobId), readArtifact(id). JobService methods return JSON objects with ok and error_code. Wire envelope and fields must match the Spec exactly.

- [ ] Write failing behavior tests:
```ts
assert.throws(() => validateJobRequest({kind:'python',spec:{code:'print(1)'},project:'../escape'}));
assert.throws(() => validateJobRequest({kind:'shell',spec:{command:'true'},timeout_seconds:3601}));
assert.throws(() => assertLease({runtime_id:R,lease_token:T,lease_expires_at:'2026-01-01T00:00:00Z',status:'running'},R,T,new Date('2026-01-01T00:01:01Z')));
assert.equal(await jobRequestHash(normalizeJobRequest(A)),await jobRequestHash(normalizeJobRequest({...A})));
```
- [ ] Run `node --experimental-strip-types --test tests/jobs.test.ts` and record missing implementation failures.
- [ ] Implement validation and repository operations. Use SQL RPC for atomic claims and fenced writes, not select-then-update claiming. Generate the migration with `supabase migration new colab_bridge_jobs`, then add jobs/events/artifacts/lifecycle tables, constraints, indexes, RPCs and RLS/grants.
```sql
SELECT pg_advisory_xact_lock(hashtextextended(p_runtime_id::text, 0));
SELECT id FROM public.colab_bridge_jobs
 WHERE status='queued' AND (runtime_id IS NULL OR runtime_id=p_runtime_id)
 ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1;
```
- [ ] Use a database test double only for contract tests; cover duplicate-key payload conflict, cancellation, terminal immutability and event deduplication. Add cloud SQL verification in Task 5 for actual race/lease behavior.
- [ ] Run the covering Node tests and the existing suite; commit all owned files. Write a concise report with test commands, outputs, migration filename and interfaces produced.

## Task 2: Agent execution worker and persistence

**Files:** create agent/colab_bridge_agent/jobs.py, agent/colab_bridge_agent/workspace.py, agent/tests/test_jobs.py; modify config.py, client.py and main.py; preserve existing probe behavior.

**Interfaces:** JobRunner(config,client,runtime_id,stop_event=None).run_once() claims and executes at most one job; run_forever() polls. execute_job(job,workspace,emit,cancelled) returns {status,result,exit_code,error_code,artifacts}. Recipe adapters are called through `build_recipe(job, workspace)` from recipes.py when available; Python/Shell/Pip and file staging must work independently. AgentClient gets the exact job_* and artifact_* methods from the Spec. Artifact upload uses the returned URL and registers completion only after success. Workspace root defaults to /content/colab-bridge or an explicitly supplied path.

- [ ] Write real subprocess failures first:
```python
def test_python_result(tmp_path):
    result = execute_job(job('python', {'code': 'print("bridge-ok")'}), tmp_path, events.append, lambda: False)
    assert result['status'] == 'succeeded'
    assert any('bridge-ok' in e['text'] for e in events)
def test_timeout_kills_group(tmp_path):
    result = execute_job(job('python', {'code': 'import time; time.sleep(30)'}, timeout_seconds=1), tmp_path, lambda e: None, lambda: False)
    assert result['status'] == 'timed_out'
```
- [ ] Run the focused Python tests and record expected failures.
- [ ] Implement filtered environment, project/path resolution, subprocess groups, streaming stdout/stderr, timeout/cancel, bounded log buffers and SHA-256 artifact manifests. Heartbeat/lease renewal occurs independently of stdout reads and long GPU work. Terminate the group on lease loss.
```python
proc = subprocess.Popen(argv, cwd=workspace, env=child_env, stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE, start_new_session=True, text=True)
```
- [ ] Keep Agent registration/runtime_id stable across transient retries; do not let one HTTP or probe exception terminate the telemetry loop. Advertise agent_version and execution_enabled during registration/heartbeat. Preserve `max_cycles` test behavior.
- [ ] Run tests for cancellation, nonzero exit, environment redaction, symlink escape, temporary network failure, logs and artifact checksum. Commit owned files and record the report.

## Task 3: Project/model recipes and research pipeline

**Files:** create agent/colab_bridge_agent/recipes.py and focused adapter modules under agent/colab_bridge_agent/recipes_impl/; create agent/tests/test_recipes.py and examples/ job JSON files; update pyproject.toml optional pinned dependency groups only.

**Interfaces:** build_recipe(job, workspace) -> a validated execution descriptor consumed by execute_job. The shared descriptor is a dict with argv: list[str], cwd: str (resolved under workspace), env: dict[str,str] (non-secret overrides), artifacts: list[str] (workspace-relative paths), and optional result_path: str (workspace-relative JSON result). Recipes may create a Python script and return its argv. Built-ins use the same descriptor. Supported kinds are git, model_download, benchmark, lora, export, drive_export and pipeline, plus built-ins from Task 2. Record model/repo revision and actual output paths.

- [ ] Write failing tests with real small local Git repositories and dependency injection for network/model SDKs:
```python
assert benchmark_metrics(first_token_seconds=0.2, total_seconds=1.2, generated_tokens=11)['decode_tokens_per_second'] == 10.0
with pytest.raises(ValueError): validate_repo_url('file:///etc/passwd')
with pytest.raises(ValueError): validate_export('unknown-model', 'unknown-format')
```
- [ ] Implement Git/CNB checkout with HTTPS host allowlist and pinned revision recording; HF/ModelScope download; Transformers inference/benchmark with CUDA synchronization, TTFT/decode throughput and peak allocated/reserved VRAM; explicit missing-dependency and OOM errors.
- [ ] Implement finite LoRA training with JSONL text, PEFT, checkpoint resume and saved adapter/metrics. Implement supported ONNX and llama.cpp GGUF export paths with output checks. Do not advertise an unimplemented TFLite converter.
- [ ] Implement Drive export into a configured mounted path and a provider interface for authorized Drive API transfer; fail clearly if the Drive mount/credentials are absent. Implement serial recipe pipelines with per-step checkpoints and explicit resume; no silent restart of completed arbitrary-code steps.
- [ ] Run meaningful local recipe/metric/path/timeout tests; build a tiny local causal model for CPU smoke validation where installed dependencies allow. Commit owned files and report what was actually exercised versus adapter-only coverage.

## Task 4: Runtime providers and complete MCP integration

**Files:** create supabase/shared/lifecycle.ts, supabase/shared/execution_tools.ts, tests/lifecycle.test.ts and tests/execution_tools.test.ts; modify MCP index.ts, tool catalog, auth.ts and deployment documentation; create a documented external-wake service adapter and updated bootstrap generator.

**Interfaces:** LifecycleService(db,config,fetcher).connectionStatus(), ensure(input), waitReady(id), release(input); registerExecutionTools(server, {db, role, lifecycle}) registers the Spec's new tool surface. Every write callback requires role='control'. Factory handlers separately capture read/control roles.

- [ ] Write provider tests for missing OAuth, allowlist denial, ineligible runtime specs, failed operation, quota exhaustion, GPU present but Agent absent, and an actual ready snapshot requirement.
```ts
assert.equal((await lifecycle.ensure({accelerator:'T4'})).error_code,'GOOGLE_AUTH_NOT_CONFIGURED');
assert.equal((await readClient.call('colab_submit_job', request)).error_code,'CONTROL_KEY_REQUIRED');
```
- [ ] Implement OAuth refresh and official Colab subscription/spec/runtime/operation calls with idempotent requestId, bounded request timeouts and no credential logging. Validate connectionInfo against official documentation before Agent bootstrap. Store progress durably and expose accepted/starting/bootstrapping/ready/blocked/failed states.
- [ ] Implement authenticated external wake adapter only for an explicitly configured HTTPS endpoint; provider readiness must be independent of Colab's Agent. Refuse release while jobs are active unless explicit cancellation was requested.
- [ ] Register all Spec tools with accurate schemas and read/write/destructive annotations; map convenience actions to JobService submit and return durable IDs. Cap logs/preview sizes. Update capabilities to report per-feature availability and setup blockers.
- [ ] Generate a self-contained v0.2 bootstrap with pinned wheel checksum, stoppable Agent, execution opt-in, safe runtime input, and no credentials in saved notebook. Run Node/Agent compatibility tests and commit owned files.

## Task 5: Integration, cloud deployment and native acceptance

**Files:** update docs/deployment.md, docs/security.md, README.md; create tests/integration and scripts/release.py; commit dependency lockfiles and release evidence without secrets.

**Interfaces:** Use the complete outputs of Tasks 1–4 unchanged. Publish version 0.2.0 and preserve the existing function URLs.

- [ ] Run all Python and TypeScript suites, type-check Edge Functions, build/install the wheel in an isolated environment, and run secret/path checks on the publish set.
- [ ] Apply the migration to the existing Supabase project, deploy both functions, create the private artifact bucket, add an independent control key without rotating the working read/Agent keys, and run database advisors for the changed tables/RPCs.
- [ ] Exercise an actual worker against the deployed APIs: submit Python, retrieve logs, download/hash an artifact, cancel a child process, verify timeout, reject an expired lease and reject submission with a read key. Test actual atomic SQL claiming with independent concurrent clients.
- [ ] Restore/launch the updated Agent in a real Colab runtime where authorized access allows. Run a bounded model benchmark. Execute true cold-start acceptance only if the Google/external provider is actually authorized and available; otherwise finish all other gates and report the exact missing prerequisite.
- [ ] Refresh the existing ChatGPT connector tool list; run a native job submission/status/log/artifact readback. Publish source to QuJindai/colab-bridge and save the final evidence. Clearly distinguish implemented, deployed, locally exercised and real-GPU exercised features.
