# Task 4 implementation report — runtime lifecycle and MCP integration

Base: `1bbdc4c71dd4859d4e3edf6f713111b181a2aa54`, branch `feat/v0.2`.
Status: DONE for Task 4 implementation and local verification; production/native/GPU acceptance remains with Root.

## Delivered behavior

- All seven existing telemetry names/endpoint/key transports remain compatible. The complete catalog has 31 tools: seven telemetry and 24 execution/lifecycle tools. Separate installed-SDK factories capture immutable `read` / `control` roles; there is no mutable global request role.
- Bridge/control lookup uses both stored hashes while retaining `bridge` as the read key kind. Invalid/missing credentials are HTTP 401 `UNAUTHORIZED`; lookup failures, including thrown transport errors, are HTTP 503 `BACKEND_UNAVAILABLE`. No invalid-key retry. Agent lookup failures likewise return 503. No existing hashes are changed.
- Google adapter implements OAuth refresh, subscription/spec checks, GPU standard-shape eligibility, UUID4-idempotent runtime creation, operation polling, runtime connectionInfo refresh and deletion through `https://colaboratory.googleapis.com`. Errors are stable codes, not provider messages. Requests use 15-second timeouts, reject redirects and do not log credentials. Dependency pins are exactly those in the brief.
- Google bootstrap carries actual generated Agent wheel bytes and SHA-256. It creates a dedicated Python kernel and executes a real Jupyter `execute_request` on WebSocket channels using `X-Colab-Runtime-Proxy-Token`. Completion requires matching parent message ID, successful execute_reply, and iopub idle. Credentials only enter in-memory Python config; history/stdin/output are disabled. User kernels and notebooks are not reset or interrupted.
- External wake is a complete authenticated fixed-route service adapter, not an assumed Colab extension. Configuration is backend-only; no caller URLs, returned poll hosts or fallback allocation are accepted. The external service owns provisioning and Agent configuration, and its provider readiness is independent of Agent telemetry.
- Lifecycle rows and request aliases are durable. A per-provider/accelerator advisory lock serializes begin/coalescing, each request UUID binds to its normalized provider+accelerator, and a 180-second worker token fences bounded advancement saves. Equivalent in-progress ensures coalesce. A fresh matching execution-enabled Agent can be reused even without provider credentials. Offline reused runtimes fail explicitly instead of silently allocating through an old request.
- Readiness requires the exact expected Agent UUID, non-draining runtime, execution_enabled, live <=60-second heartbeat, non-stale <=60-second GPU snapshot and a matching GPU name/count. Creation/operation/provider-ready/bootstrap-success alone is insufficient. Provider configuration is reported as unverified rather than a successful wake.
- Release uses the same per-runtime advisory lock as claim. Draining survives register/heartbeat and prevents future claims/affinity submissions. Running jobs become cancelling only with explicit cancel_jobs, and provider deletion waits for terminal states. Runtime/job/artifact audit rows and affinity are retained.
- Root approved `lifecycle_id` as an alternative to `runtime_id` for pre-Agent release. A separate release-intent RPC persists the request while creation is in flight; provisioning saves merge the intent and cannot overwrite it. A placeholder row uses heartbeat `epoch` and draining=true, so it is initially offline and cannot admit jobs after registration. Already-dispatched I/O may finish, but cannot erase intent or re-enable claims. Pending operation results remain available for deletion. Repeated released calls do not delete again. A manual reused runtime without a provider resource mapping returns `PROVIDER_RESOURCE_UNKNOWN`.
- Linked retry accepts one supported checkpoint option, validates the parent's exact published marker, merges only checkpoint_path (plus pipeline resume=true), and preserves kind/project/timeout/GPU requirement/requested affinity/parent linkage. SQL idempotency equivalence includes the selected spec/checkpoint. Claim restores all parent published artifacts using signed URLs; no private Storage paths reach the worker restore envelope.
- Notebook generator is owned/reviewed/refined and committed with generated notebook/payload. It verifies metadata/required modules, pins the payload checksum/version, uses getpass and runtime-only configuration, validates URL/label/optional runtime UUID, asks for execution opt-in, and provides a stoppable Agent. It explicitly installs httpx==0.28.1, then replaces only the Agent using --no-deps --force-reinstall. Both bootstrap paths filter sensitive environment names before pip subprocesses.

## Exact tool contracts

Every new tool returns SDK `{content:[{type:"text",text:JSON.stringify(value)}], structuredContent:value}`. `isError:true` accompanies `value.ok===false`. The mutation guard returns `{ok:false,error_code:"CONTROL_KEY_REQUIRED"}` for read role. Strict Zod input objects reject unknown fields, invalid UUIDs/bounds/recipe fields; both low-level and convenience tools use the same schema builder. Tests exercise the actual SDK's tools/list JSON schemas (all root type object) and tools/call validation.

Common submission envelope `E`:

```text
project?: safe [A-Za-z0-9_-] slug, 1..64 characters, default "default"
timeout_seconds?: integer 1..3600, default 900
require_gpu?: boolean, default false
runtime_id?: UUID (requested affinity)
idempotency_key?: string 1..200
```

Recipe fields are top-level for convenience tools and nested under spec for submit_job. Defaults are applied by the reviewed JobService/worker, so schemas do not inject extra defaults into caller specs or pipeline definition hashes. Strings are bounded (generally 1..65536); workspace paths are relative POSIX paths of 1..512 characters, with no empty, `.` or `..` components, backslashes, absolute paths, trailing slash or NUL. `env` is a string map with credential-bearing names rejected. Arrays are explicitly bounded; artifact/input paths permit at most 10,000 entries.

| Tool(s), all prefixed `colab_` | Input | Value envelope |
| --- | --- | --- |
| connection_status | `{}` | `{ok:true,providers:{google_colab,external},agent_bootstrap_configured}`; provider entry `{configured,blocker,availability:"unverified"}` |
| ensure_runtime, wake | `{provider?:"google_colab"\|"external"="google_colab",accelerator?:uppercase label="T4",request_id?:UUID4}` | Lifecycle envelope below |
| wait_ready | `{lifecycle_id:UUID}` | Lifecycle envelope; advances provisioning or release; control required |
| release_runtime | exactly one of `{runtime_id:UUID}` / `{lifecycle_id:UUID}`, plus `cancel_jobs?:boolean=false` | Lifecycle envelope or structured blocker |
| submit_job | `{kind:K,spec:Recipe(K),...E}` | `{ok:true,job_id:UUID,status,idempotent?}` |
| list_jobs | `{status?:job status,runtime_id?:UUID,limit?:int[1,100]=50}` | `{ok:true,jobs:[...]}` with lease token/request hash/idempotency key removed |
| job_status | `{job_id:UUID}` | `{ok:true,job:{...}}` with same private-field removal |
| job_logs | `{job_id:UUID,after?:int[-1,MAX_SAFE_INTEGER]=-1,limit?:int[1,100]=20}` | `{ok:true,events:[...],next_after,has_more}`; complete chunks, <=65,536 text chars total |
| cancel_job | `{job_id:UUID}` | `{ok:true,job_id,status}` |
| retry_job | `{job_id:UUID,idempotency_key:string[1,200],checkpoint_path?:safe relative path}` | `{ok:true,job_id,status,idempotent}` or `CHECKPOINT_INVALID` / `IDEMPOTENCY_CONFLICT` / parent-state error |
| list_artifacts | `{job_id:UUID}` | `{ok:true,artifacts:[published metadata]}` without storage_path |
| read_artifact | `{artifact_id:UUID}` | `{ok:true,artifact,download_url,expires_in:300}`; no unbounded inline preview |

Lifecycle envelope:

```text
{ok:boolean,lifecycle_id:UUID,request_id:UUID,provider,status,
 runtime_id:UUID|null,expected_agent_id:UUID,error_code:string|null}
status = accepted | starting | bootstrapping | ready | blocked | failed | released
```

Validation/backend/setup failures can return `{ok:false,error_code}` before a durable ID is available. Calls backed by durable lifecycle rows return their ID even when blocked. `wake` uses the same normalized ensure semantics and coalescing. No synchronous long-running shell API exists.

| Convenience tool | Kind | Exact recipe fields (plus E above) |
| --- | --- | --- |
| exec_python | python | `{code,env?,artifacts?,result_path?}` |
| exec_shell | shell | `{command,env?,artifacts?,result_path?}` |
| pip_install | pip | `{packages:nonempty string[],env?,artifacts?,result_path?}` |
| checkout_repo | git | `{url,revision,output_dir?}`; credential-free HTTPS on github.com/gitlab.com/huggingface.co/cnb.cool; revision cannot start `-` |
| download_model | model_download | `{model_id:owner/name,revision,provider?:huggingface\|modelscope,output_dir?,allow_patterns?:nonempty string[]}` |
| benchmark_model | benchmark | `{model_path,adapter_path?,device?:auto\|cpu\|cuda,dtype?:float32\|float16\|bfloat16,cpu_threads?:int[1,64],prompt?,max_new_tokens?:int[1,4096],stop_on_eos?:boolean,warmup_runs?:int[1,100],warmup_tokens?:int[1,4096]}`; worker defaults warmup_runs=1 and warmup_tokens=min(4,max_new_tokens) |
| finetune_lora | lora | `{model_path,data_path,output_dir?,checkpoint_path?,device?,dtype?,cpu_threads?,max_steps?:int[1,100000],checkpoint_every?:int[1,max_steps],rank?:int[1,256],alpha?:positive finite number,target_modules?:nonempty string[],learning_rate?:positive finite number,max_length?:int[2,65536],seed?:int[0,4294967295]}` |
| export_model | export | `{model_path,format:onnx\|gguf,adapter_path?,output_path?,cpu_threads?:int[1,64],sample_text?,converter_path?:absolute installed path,outtype?:f32\|f16\|bf16\|q8_0}`; no TFLite advertised |
| stage_file | file | `{path,exactly one of text\|base64\|source_url,sha256?:lowercase 64 hex}`; HTTPS URL credential/query restrictions; inline text/base64 <=131072 characters |
| export_to_drive | drive_export | `{source_path,mode?:mount\|api,destination?,name?,parent_id?}` |
| run_pipeline | pipeline | `{steps:Step[1,100],resume?:boolean,checkpoint_path?}`; checkpoint requires resume=true; Step `{id:unique safe identifier,kind:non-pipeline K,spec:Recipe(K),inputs?:relative path[]}` |

Annotations: six added reads (connection_status/list_jobs/job_status/job_logs/list_artifacts/read_artifact) have readOnlyHint=true, destructiveHint=false, idempotentHint=true. All 18 added mutations have readOnlyHint=false and destructiveHint=true. cancel_job/release_runtime/wait_ready/retry_job are idempotentHint=true; other mutations false because optional request keys/new execution may create work. openWorldHint=true for mutations and read_artifact; false for other added reads. The seven original telemetry annotations remain unchanged.

## Configuration and provider protocol

Backend env prerequisites:

- Standard Supabase `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.
- Google `COLAB_GOOGLE_CLIENT_ID`, `COLAB_GOOGLE_CLIENT_SECRET`, `COLAB_GOOGLE_REFRESH_TOKEN`; optional `COLAB_GOOGLE_QUOTA_PROJECT`. OAuth scope `https://www.googleapis.com/auth/colaboratory`, API beta allowlist and eligible subscription/spec are real prerequisites.
- Automated Google bootstrap `COLAB_BOOTSTRAP_AGENT_URL`, `COLAB_BOOTSTRAP_AGENT_KEY`.
- External `COLAB_EXTERNAL_WAKE_URL`, `COLAB_EXTERNAL_WAKE_TOKEN`.
- Runtime manual execution opt-in `COLAB_BRIDGE_EXECUTION_ENABLED=1`, or affirmative notebook prompt. Optional `COLAB_BRIDGE_RUNTIME_ID` is validated by actual AgentConfig.

No provider URL/token/OAuth field is a tool argument or durable request field. Durable request metadata contains only expected UUID, reuse/allocation/bootstrap/release flags, sanitized operation/resource names and dedicated kernel ID. Proxy connectionInfo is refreshed and used in memory only.

External protocol: configured HTTPS base + fixed POST `/wake` `{request_id,accelerator,expected_agent_id}`, `/status` `{resource_id}`, `/release` `{resource_id}`; backend bearer header. Response `{state:"starting"|"ready"|"failed"|"released",resource_id}`. Status/release require the same returned resource ID as requested; any URLs in responses are ignored. The external service must implement idempotent wake and independently provision/start the configured Agent. Its `ready` cannot bypass backend telemetry checks.

Official references used: [create](https://developers.google.com/colab/api/reference/rest/v1beta/runtimes/create), [runtime/connectionInfo](https://developers.google.com/colab/api/reference/rest/v1beta/runtimes), plus the controller's verified provider-reference.md for subscription/spec/operation/Jupyter protocol and SDK pins.

## Migration and race boundaries

CLI-generated migration: `supabase/migrations/20260914113920_colab_bridge_lifecycle_integration.sql` from `npx --yes supabase@2.117.0 migration new colab_bridge_lifecycle_integration`, after inspecting `migration new --help`.

New service-role-only SECURITY INVOKER RPCs (fixed public,pg_temp search_path):

```text
colab_bridge_lifecycle_begin(uuid,text,text)
colab_bridge_lifecycle_acquire(uuid)
colab_bridge_lifecycle_save(uuid,uuid,text,jsonb,uuid,text,boolean)
colab_bridge_begin_release(uuid,boolean,boolean)
colab_bridge_request_release(uuid,boolean)
colab_bridge_agent_heartbeat(uuid,jsonb)
colab_bridge_retry_job(uuid,text,text default null)  # replaces compatible two-argument call
```

New alias table has RLS, no public grant/policy, and service_role-only access. Runtime draining is a separate boolean column, not mutable Agent metadata. Existing claim and submit RPCs retain grants and add the shared lock/draining guard. All runtime/audit rows remain; no destructive runtime SQL deletion or affinity clearing is performed. SQL tests run actual PostgreSQL-compatible functions using PGlite, with only the unused pgcrypto extension declaration removed in the test harness; SHA-256 uses PostgreSQL core. One PGlite connection validates behavior/locks but cannot establish interconnection production concurrency.

## TDD and verification evidence

Focused RED phases:

1. `node --experimental-strip-types --test tests/lifecycle.test.ts`: module-not-found failure before lifecycle/provider implementation.
2. `node --experimental-strip-types --test tests/execution_tools.test.ts`: module-not-found failure before schemas/tool registration/auth extension.
3. Full LifecycleService/SQL regression first exposed duplicate release deletion: expected 1 delete, observed 2. Fixed released-state idempotency.
4. `node --experimental-strip-types --test --test-name-pattern='release intent' tests/lifecycle_sql.test.ts`: failed, expected starting but release had no pre-Agent/operation mapping. Added durable request_release RPC, placeholder and save-merge behavior. Same regression now asserts intent survives in-flight create and no bootstrap/job claim occurs afterward.
5. Notebook functional test failed because actual AgentConfig.runtime_id was None; generator now passes the validated configured UUID. A later focused red caught missing subprocess env filtering; both bootstrap paths now filter sensitive names.
6. Uncertain Google allocation regression failed expected released/actual blocked after simulated response loss; deterministic read-only runtime lookup now reconciles that release without a second create.
7. Log cap regression failed aggregate <=65536 assertion; tool now returns complete events under the aggregate cap and a resumable cursor.

Focused GREEN evidence:

- Provider/readiness tests: 7/7 passed, covering missing OAuth/bootstrap, 403 allowlist, 429 quota, ineligible spec/no create, failed operation/no secret message, expected Agent/fresh GPU and fixed external paths.
- Actual SDK test: passed concurrent read/control factories, only one authorized submit RPC, invalid benchmark schema rejected before RPC, all 31 tools/root object schemas, invalid-key 401, lookup-failure 503, read capabilities false for execution.
- Actual ws server test: passed custom proxy header, shell execute_request, store_history=false, allow_stdin=false, ignored unrelated error reply, and required matching reply plus delayed idle.
- SQL covering tests: coalescing/equivalence/worker fencing; claim/drain/cancel/audit; exact pipeline and LoRA marker validation; all-file restore and signed envelopes; duplicate/conflicting retry; affinity; complete lifecycle progression; pending-create release intent; fresh manual reuse without credentials.
- Notebook tests: 3/3 passed; generated cell executes against actual AgentConfig/main imports with pip/network/thread substitutes, checks runtime UUID/opt-in/key handling, isolated import restoration, filtered pip env and stopping.
- Generated provider Python source compiles with hostile quote/newline/backslash key input. Embedded wheel hash verifies in Node.

Deno:

- Initial exact required command with `DENO_TLS_CA_STORE=system .../deno check --node-modules-dir=auto` failed because registry.npmjs.org connection was refused. TLS verification was not weakened.
- Supported alternative `DENO_TLS_CA_STORE=system /workspace/scratch/203f1bd95405/colab-deno-validation/node_modules/.bin/deno check --cached-only --node-modules-dir=manual supabase/functions/colab-bridge-mcp/index.ts supabase/functions/colab-bridge-agent/index.ts` used npm-installed exact packages. First pass caught six union-return property errors; explicit ProviderProgress return types fixed them. Final checks pass both functions with exit 0.
- Deno 2.9.6, TypeScript 6.0.3. Node v24.19.0. npm lockfile records exact direct/transitive packages and Node >=22.

Bootstrap build: `pip wheel --no-deps --no-build-isolation` initially lacked setuptools.build_meta in the existing venv. The standard isolated build `pip wheel --no-deps --wheel-dir /tmp/colab-task4-wheels .` succeeded. The generator produced Agent version 0.2.0, wheel 36,865 bytes, SHA-256 `e0f8efc4063412ec99166aa953b0ded98acab3decd3c9505582dde7e12fb61a8`. Final Task 5 should regenerate both outputs from its final wheel build; this checksum belongs to this reviewed source build, not a fabricated published release.

## Self-review and limitations

Self-review corrected: release idempotency, pre-Agent release reachability, in-flight create intent preservation, placeholder heartbeat false-liveness, fresh manual reuse without OAuth, installed-SDK root object schemas, provider status/resource identity validation, aggregate logs/cursor, pip dependency replacement scope and credential environment filtering. No helpers or reviewers were spawned. Root's scripts/release.py and tests/integration drafts are not part of this commit.

No live OAuth/provider credentials were available. No Google cold start, real GPU job, live external service, production migration/Edge deployment, cloud concurrency, production artifact upload or native ChatGPT control-key acceptance was performed. Root owns those gates. Actual ws is local with injected transport; HTTP provider responses are substitutes. PGlite is real SQL execution on one connection, not a cloud load test.

If Google creation times out before returning an operation, release looks up the deterministic `runtimes/cb-<request_id>` without allocating again, persists the resource and deletes it when observed. A lookup 404 remains blocked rather than claiming absence while creation could still be in flight. External wake response loss before resource ID requires provider-side reconciliation; release does not issue another wake. Unknown allocation outcomes are never called released. Manual runtimes without provider mapping are explicitly not released. The worker does not snapshot process/package/remote-side-effect state; explicit checkpoint resume retains Task 3's limitations and Storage/drain limits. Model recipe dependencies are runtime-dependent and not installed silently by lifecycle bootstrap. No successful cloud acceptance is claimed.

## Final covering results and commit

- `npm test` — **72 passed, 0 failed, 0 skipped**, 11.78 seconds. npm emitted only the environment's existing unknown `http-proxy` config warning; test output otherwise clean.
- `COLAB_BRIDGE_REAL_MODEL_TESTS=1 .venv/bin/python -m pytest -q` — **91 passed in 42.57s**, no skipped tests. This includes all prior worker/model recipes and the new notebook functional test.
- After the uncertain-allocation fix, `node --experimental-strip-types --test tests/lifecycle_sql.test.ts` — **7 passed, 0 failed**, 10.57 seconds. This covers all lifecycle/SQL behavior amended after the full Node suite; no Python implementation changed afterward.
- `DENO_TLS_CA_STORE=system .../deno check --cached-only --node-modules-dir=manual` — both production functions pass, exit 0.
- `python -m py_compile scripts/build_notebook.py` and `git diff --check` — exit 0.

Implementation commit: `4053646855fad3a0b572d99c669a4b06afc3640a` — `feat: add runtime lifecycle and complete execution MCP tools`. This report is committed separately so it can record the exact implementation commit. No production action occurred.


## Changed files

```text
agent/tests/test_notebook.py
docs/deployment.md
notebooks/colab_bridge_bootstrap.ipynb
package-lock.json
package.json
scripts/build_notebook.py
supabase/functions/colab-bridge-agent/index.ts
supabase/functions/colab-bridge-mcp/index.ts
supabase/migrations/20260914113920_colab_bridge_lifecycle_integration.sql
supabase/shared/auth.ts
supabase/shared/bootstrap.ts
supabase/shared/bootstrap_payload.ts
supabase/shared/execution_schemas.ts
supabase/shared/execution_tools.ts
supabase/shared/job_api.ts
supabase/shared/lifecycle.ts
supabase/shared/mcp_server.ts
supabase/shared/mcp_tools.ts
supabase/shared/providers.ts
tests/bootstrap.test.ts
tests/execution_tools.test.ts
tests/lifecycle.test.ts
tests/lifecycle_sql.test.ts
tests/mcp_handler.test.ts
tests/mcp_tools.test.ts
.superpowers/sdd/2026-09-12-colab-bridge-v2/task-4-report.md
```

Root-owned `scripts/release.py` and `tests/integration/` remain uncommitted for Task 5.

## Fix round 1 — draining retry admission, allocation ownership/retirement, bootstrap environment

Fix BASE: `8224915b3890d212d1f991121ec0af88537f6f8d`. Addressed all four Important findings and the validation-environment minor in `task-4-fix-1.md`. No migration was deployed; the Task 4 migration was amended in place as authorized. No subagents, production actions, broader feature work, full-suite reruns, or changes to Root's release/integration drafts.

### Findings and implemented changes

1. **Retry admission respects draining.** Retry first reads immutable requested affinity without a job-row lock, takes the same per-runtime advisory admission lock as submit/claim/release, and checks `draining`. Only then does it reap leases and lock the source job. A draining target returns `RUNTIME_DRAINING` before insertion; unassigned parents remain unassigned and may still queue. A defensive recheck rejects externally changed affinity rather than inserting under an unrelated admission lock. Exact published checkpoint selection, idempotency, original project/kind/timeout/GPU/affinity, parent linkage and restore envelopes remain unchanged.
2. **Managed reuse retains ownership.** The lifecycle table now has nullable self-FK `allocation_owner_id`. Fresh managed reuse records the original allocation owner's ID rather than duplicating provider/resource identity into a caller-provider alias. Same-provider ensures continue coalescing; cross-provider reuse remains a separate stable request binding. `request_release` resolves the immutable owner before taking its row lock, and the service advances the returned owner's lifecycle/provider. Both `runtime_id` and alias `lifecycle_id` release therefore reach the original provider resource. Repeated alias release returns the same released owner without deleting twice. Manual runtimes with no known allocation owner still return `PROVIDER_RESOURCE_UNKNOWN`.
3. **Definitively absent allocations retire.** An authenticated Google runtime GET 404 is marked internally as definitive resource absence. For an already-recorded resource, the lifecycle saves `allocation_absent=true` and terminal `failed/PROVIDER_NOT_FOUND`. New request IDs no longer coalesce onto that owner or its aliases, and its old Agent telemetry cannot make it reusable. Old request IDs remain bound to their original terminal lifecycle. Alias `wait_ready` also checks owner absence/release before accepting telemetry. OAuth and operation 404s are not definitive absence; neither are deterministic-name probes after an uncertain create that has no recorded resource. Those paths stay blocked, keep their bindings and do not create again or claim released during release. No arbitrary job/code replay was added.
4. **Bootstrap pip environment is credential-free.** The generator now defines one shared Python environment-filter function and emits it in both the notebook and `BOOTSTRAP_INSTALL_ENV_PYTHON` export in the provider payload. Both execution paths call that exact function. A small allowlist retains ordinary path/temp/locale, proxy, package-index and TLS certificate settings. URL userinfo (including percent-encoded and scheme-less proxy forms), query/fragment-bearing URL values and unrecognized settings are rejected. Multi-index settings are rejected as a whole if any URL is credential-bearing. Credential-free HTTP/SOCKS proxies, public indexes, local find-links and TLS CA settings retain their original values; no trusted-host/TLS bypass is introduced. Tests use only synthetic environment values and execute the generated filter body from each actual output.
5. **Validation environment noise removed.** Only unsupported npm `http-proxy` configuration variables were removed from validation subprocesses with `env -u npm_config_http_proxy -u NPM_CONFIG_HTTP_PROXY`. Standard proxy/TLS variables remain. `npm --version` printed only `11.9.0`; the covering tests emitted no npm configuration warning or other warnings.

### Red/green evidence

- Initial SQL reproductions: **4 failed**. Draining retry returned no error instead of `RUNTIME_DRAINING`; the two ownership fixtures initially had a SQL parameter-cast error, corrected before using them as behavior evidence; definitive absence stayed `blocked` instead of terminal `failed`.
- Corrected ownership-only RED: `node --experimental-strip-types --test --test-name-pattern='managed reuse' tests/lifecycle_sql.test.ts` — **2 failed**, release by runtime ID and alias lifecycle ID each lacked the expected released result. After owner-reference/RPC resolution fixes, the four SQL finding regressions passed.
- Notebook RED: `.venv/bin/python -m pytest agent/tests/test_notebook.py -q` — **1 failed, 2 passed**; `PIP_INDEX_URL` with synthetic URL userinfo survived the old filter. The test now replaces `os.environ` with a synthetic mapping, so failure evidence cannot dump real environment credentials. After regeneration, **3 passed**.
- Related owner-retirement RED: the reused alias remained `ready` after its owner's authoritative absence marker. The owner-state check fixed it; focused alias/uncertain-operation tests then **2 passed**.
- Provider-context RED: an authenticated runtime 404 had no definitive-absence marker. The adapter now sets that marker only around runtime GET, after OAuth succeeds. The single focused context test passes for OAuth, operation and runtime 404 cases.
- Existing uncertain-create protection and pending-create release-intent tests remain in the covering SQL run. They assert no new create during release and no premature released/retired result for unknown allocation outcomes.

### Final covering commands and actual output

```text
env -u npm_config_http_proxy -u NPM_CONFIG_HTTP_PROXY node --experimental-strip-types --test tests/lifecycle_sql.test.ts tests/lifecycle.test.ts tests/bootstrap.test.ts tests/jobs.test.ts

ℹ tests 44
ℹ suites 0
ℹ pass 44
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 20311.168872
```

This covers actual SQL behavior and admission-lock ordering; same/cross-provider owner-preserving release by both selectors; owner retirement and stable old bindings; stale alias telemetry; operation/uncertain-create safeguards; original checkpoint/retry/restore/affinity behavior; provider/readiness handling; actual WebSocket exchange; both generated Python environment filters; and the specifically impacted existing JobService tests. Output was clean.

```text
.venv/bin/python -m pytest agent/tests/test_notebook.py -q
...                                                                      [100%]
3 passed in 0.02s

DENO_TLS_CA_STORE=system /workspace/scratch/203f1bd95405/colab-deno-validation/node_modules/.bin/deno check --cached-only --node-modules-dir=manual supabase/functions/colab-bridge-mcp/index.ts supabase/functions/colab-bridge-agent/index.ts
Check supabase/functions/colab-bridge-mcp/index.ts
Check supabase/functions/colab-bridge-agent/index.ts
# exit 0; no warnings/errors

.venv/bin/python -m py_compile scripts/build_notebook.py
# exit 0; no output

git diff --check
# exit 0; no output
```

Both embedded outputs were regenerated using:

```text
.venv/bin/python scripts/build_notebook.py --wheel /tmp/colab-task4-wheels/colab_bridge_agent-0.2.0-py3-none-any.whl
{"bytes": 36865, "sha256": "e0f8efc4063412ec99166aa953b0ded98acab3decd3c9505582dde7e12fb61a8", "version": "0.2.0", "wheel": "colab_bridge_agent-0.2.0-py3-none-any.whl"}
```

No Agent package implementation changed, so the already-verified wheel bytes/checksum remain the same; the generated environment helper and notebook code changed. Node 22 minimum-version/full-suite and final release generation remain Task 5's gates as instructed.

### Changed files and remaining limits

Amended migration, lifecycle/provider services, bootstrap service and generated payload, generator/notebook, deployment notes, four named covering test files (`lifecycle_sql`, `lifecycle`, `bootstrap`, `test_notebook`), and this report. No other implementation files changed. This report is included in the fix commit named `fix: preserve lifecycle ownership and guard runtime admission`; the controller receives its exact SHA in the completion reply.

The same declared acceptance limits remain: PGlite is one PostgreSQL-compatible connection, not a proof of interconnection cloud concurrency; live OAuth/provider/GPU/native acceptance has not occurred; unknown external-wake outcomes still require provider-side reconciliation. These fixes do not weaken uncertain-create protection, alter key separation, propagate authenticated proxy credentials to pip, or introduce automatic job replay.

## Fix round 2 — ownership before the owner's first ready poll

Fix BASE: `f1028daefd1d9e7216447d1966660b626afdce9f`. Addressed the remaining finding in `task-4-fix-2.md`: Agent registration and fresh GPU telemetry can precede association of `owner.runtime_id`, so cross-provider reuse must resolve the allocation owner using its durable expected Agent identity.

### Change and self-review

The migration's allocation-owner lookup now matches either `owner.runtime_id` or `owner.request.expected_agent_id` against the reusable Agent UUID. It still resolves aliases to the original owner and requires an existing ownership/provider resource or operation mapping. The retirement/reuse exclusion already matches both identities; the new regression verifies that contract while the owner's runtime ID remains null. No service, provider, schema envelope, bootstrap or notebook changes were needed.

Three added actual-SQL regressions create the lifecycle through its RPC, use its generated expected Agent UUID, insert registration/fresh GPU telemetry, and explicitly leave the owner's runtime ID null before reuse. Both supported release selectors reach the original Google owner/resource and repeated alias release does not delete twice. The third regression retires the owner while its runtime ID is still null: its alias cannot remain ready, and a subsequent ensure cannot reuse the old fresh telemetry or coalesce onto the retired alias.

Self-review checked the small SQL predicate diff, immutable alias owner resolution, null identity behavior, test assertions and scope. Existing owner retirement, uncertain-create and admission behavior remain covered. Changed files are only the lifecycle integration migration, `tests/lifecycle_sql.test.ts`, and this report. Root's release/integration drafts are excluded. The fix commit subject is `fix: correlate allocation ownership before readiness poll`; its exact SHA is supplied in the completion reply.

### TDD and covering evidence

Before the SQL change:

```text
env -u npm_config_http_proxy -u NPM_CONFIG_HTTP_PROXY node --experimental-strip-types --test --test-name-pattern='pre-ready-poll' tests/lifecycle_sql.test.ts

Both release-selector regressions: allocation_owner_id was null instead of the original owner UUID.
Retirement regression: alias status was ready instead of failed.
ℹ tests 3
ℹ pass 0
ℹ fail 3
ℹ duration_ms 5481.242324
```

These were behavior failures from the missing owner correlation, with no fixture errors. After the minimal SQL change and formatting the added tests:

```text
/workspace/scratch/203f1bd95405/colab-deno-validation/node_modules/.bin/deno fmt tests/lifecycle_sql.test.ts
Checked 1 file

env -u npm_config_http_proxy -u NPM_CONFIG_HTTP_PROXY node --experimental-strip-types --test tests/lifecycle_sql.test.ts

✔ pre-ready-poll registered Agent retains allocation owner for release by runtime_id (1405.515492ms)
✔ pre-ready-poll registered Agent retains allocation owner for release by lifecycle_id (1274.292316ms)
✔ pre-ready-poll owner retirement still excludes its registered Agent and reuse aliases (1534.303665ms)
ℹ tests 17
ℹ suites 0
ℹ pass 17
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 23834.721195

git diff --check
# exit 0; no output
```

The complete named SQL file passed with clean output, including its existing owner-retirement, alias, uncertain-create, release-intent and admission regressions. Per the scoped fix instructions, no broad reruns or service-only test run were needed. PGlite remains a single PostgreSQL-compatible connection rather than cloud concurrency evidence; no production migration/provider action or live acceptance was performed.
