# Colab Bridge v0.2 — GPU execution upgrade

Status: implementation authorized by the user after reviewing the eight-module upgrade scope.

## Goal and release boundary

Turn the existing telemetry bridge into a single-user GPU task service usable from ChatGPT and Codex. Deliver runtime lifecycle, controlled Python/Shell execution, repository preparation, model download and experiments, durable jobs and artifacts, Drive export, and a composable pipeline for downstream device testing. Version is 0.2.0; existing seven telemetry tools and their endpoint remain compatible.

Acceptance has separate evidence levels: implemented and locally tested; deployed and API tested; real Colab tested; native ChatGPT tested. Never report a configured adapter or a simulated worker as successful real Colab wake-up. Official Colab API eligibility and Google authorization are deployment prerequisites, not assumptions. Eye Hub was inspected on 2026-09-12: actions_enabled=false, CDP connection refused. Its browser path is unavailable until restored.

## Architecture

The Supabase MCP function authenticates a read or control key, validates a job, and returns its durable identifier immediately. PostgreSQL holds jobs, leases, log events, artifacts and lifecycle requests. The Agent polls outbound HTTPS; one subprocess group executes a job while an independent telemetry loop keeps heartbeats fresh. Artifacts stream into private Supabase Storage; a mounted Drive directory or an explicitly configured Google Drive adapter provides Drive persistence.

Runtime wake is executed outside Colab. The lifecycle module supports the official colaboratory.googleapis.com API and a separately configured authenticated external wake service. The official provider obtains an OAuth access token, checks subscription/runtime eligibility, creates an assignment with a UUID requestId, and bootstraps the Agent through the documented connectionInfo and Jupyter interface. Missing credentials, allowlist denial, quota exhaustion and unavailable accelerators return distinct actionable states. A backend wake request does not imply that GPU or Agent is ready.

No artificial activity, anti-idle loops or attempts to evade platform resource controls are introduced. A restart creates a new runtime identity; job recovery restores persisted inputs/checkpoints rather than pretending the old process resumed.

## Common constraints

- Python >=3.10; Node >=22; TypeScript files remain testable by node --experimental-strip-types.
- No raw service role key, Agent key, control key, Google token or signed upload credential in source, logs, child-process environment or public artifacts.
- Read key remains read-only; new execution/lifecycle mutations require an independent control key. Authentication role is captured per MCP handler, never stored in mutable global request state.
- Agent execution is explicitly enabled with COLAB_BRIDGE_EXECUTION_ENABLED=1; old Agents keep telemetry behavior.
- Arbitrary Python/Shell are trusted single-user execution, not a sandbox for hostile code. Workspace path checks protect accidental traversal but are not claimed to isolate arbitrary Python/Shell from the runtime.
- Exactly one active job per runtime. Default timeout 900 seconds; accepted range 1..3600 seconds. Logs have monotonically increasing sequence numbers, bounded chunks of 8192 characters, and cursor pagination.
- Jobs are claimed atomically with FOR UPDATE SKIP LOCKED and a per-runtime transaction lock. A unique lease token fences every event, heartbeat, artifact registration and terminal update. Lease duration is 60 seconds, renewed every 10 seconds. Losing the lease or prolonged API connectivity causes the Agent to terminate the subprocess group.
- Idempotency keys cannot be reused with a different normalized request. Lost jobs require explicit retry; arbitrary code is never silently replayed.
- Checkpoint and artifact paths are relative to the project/job workspace, resolved and checked against traversal and symlink escapes. Artifacts include size, SHA-256, MIME type and producing job/attempt.
- Existing production telemetry tables are preserved. New tables have RLS enabled; anonymous/authenticated roles receive no direct access; queue RPCs are executable only by service_role and use SECURITY INVOKER.
- Long training/inference happens in the Agent, not inside the time-limited Edge Function.
- All adapters report actual availability and supported operations. Unsupported architecture/format combinations return an explicit error.

## Job and Agent wire contract

The Agent URL stays colab-bridge-agent and accepts new operations after custom Agent authentication. runtime_id is a UUID in every Agent request.

Job request fields: kind, spec (JSON object), project (slug), timeout_seconds, runtime_id (optional), require_gpu (boolean), idempotency_key (optional). Supported kinds: python, shell, pip, git, model_download, benchmark, lora, export, file, drive_export, pipeline. A leased job includes id, kind, spec, project, timeout_seconds, attempt, lease_token and optional restore_artifacts.

Operations:

- job_claim -> {ok, job: Job|null}; never returns a job already owned by another lease.
- job_heartbeat {job_id,lease_token} -> {ok,lease_valid,cancel_requested}.
- job_log {job_id,lease_token,seq,stream,text} -> {ok}; duplicate (job_id,attempt,seq) is idempotent.
- job_complete {job_id,lease_token,status,result,exit_code,error_code} -> {ok}; terminal status is succeeded, failed, cancelled or timed_out; stale lease is rejected.
- artifact_prepare {job_id,lease_token,path,bytes,sha256,mime_type} -> {ok,artifact_id,upload_url,upload_method:'PUT'}; private storage path is generated server-side. Upload uses the signed URL and Content-Type only; no Agent key is forwarded to Storage.
- artifact_complete {job_id,lease_token,artifact_id} -> {ok}; a published artifact must exist with the declared byte count.

Jobs live in colab_bridge_jobs; events in colab_bridge_job_events; artifacts in colab_bridge_artifacts; lifecycle requests in colab_bridge_lifecycle. Job states: queued, running, cancelling, succeeded, failed, cancelled, timed_out, lost. A lost lease is finalized as lost, or cancelled if cancellation was pending. Retry creates a new job linked by parent_job_id, retaining audit history. GPU jobs only reach workers advertising execution capability and an NVIDIA accelerator.

## Execution and experiment recipes

Python runs from a generated script. Shell runs through bash with an explicit command. Both are process groups with unbuffered output, filtered environment, streamed logs, return codes and timeout/cancellation termination.

Pip uses the current Python interpreter and an argument list. Repository checkout supports HTTPS GitHub/CNB repository URLs, validated refs and a recorded resolved commit. Model download supports Hugging Face and ModelScope through their maintained SDKs. Benchmark loads a supported Transformers causal LM, records exact model/revision/framework/GPU, warm-up, first-token latency, generated-token throughput, elapsed time and peak VRAM. GPU timing synchronizes CUDA. Quantized load requires supported hardware/packages and reports them honestly.

LoRA uses Transformers/PEFT with a JSONL text dataset, fixed configuration, finite max_steps, saved adapter/tokenizer/metrics and resume_from_checkpoint. Export adapters cover supported ONNX and llama.cpp GGUF workflows; each verifies source architecture/tool availability and output existence. TFLite conversion is advertised only when a matching implemented adapter exists. Pipeline steps use these same recipes, emit per-step state, and persist a checkpoint of completed steps. Recovery from a previous job requires explicit resume and persisted checkpoint/input availability.

Artifacts include result JSON, logs, model outputs and checkpoints selected by relative paths. Read tools return short-lived download URLs and digests. File staging accepts bounded text/base64 or an HTTPS source and expected checksum; it cannot write outside the workspace. Drive export copies into an existing mounted Drive location or uses explicitly configured Google authorization; no mount is silently claimed successful.

## MCP surface

Keep the seven observation tools. Add connection_status, ensure_runtime, wake, wait_ready, release_runtime; submit_job, list_jobs, job_status, job_logs, cancel_job, retry_job; exec_python, exec_shell, pip_install, checkout_repo, download_model, benchmark_model, finetune_lora, export_model, stage_file, export_to_drive, run_pipeline; list_artifacts, read_artifact. All names begin colab_. Tools return a durable job/lifecycle id and status; synchronous long-running shell execution is not exposed. Each mutation has accurate MCP annotations and control-key authorization. Destructive runtime release refuses active jobs unless the caller explicitly asks to cancel them.

## Verification gates

1. Existing Python and TypeScript tests pass after restoration.
2. Contract tests exercise validation, key separation, duplicate submissions, simultaneous claims, stale completion rejection, cancellation and lease expiry.
3. Real local subprocess tests exercise stdout/stderr streaming, nonzero exit, timeout, cancellation of descendant processes, and secrets excluded from child environment.
4. Model recipes run a small actual model benchmark where resources permit; fake/model-free test doubles are labelled unit coverage.
5. Cloud test registers a disposable execution worker, submits through MCP, gets logs/artifacts, validates a checksum, cancels a running job, and proves read credentials cannot submit work.
6. True cold-start acceptance requires a configured and eligible wake provider, a previously offline runtime, Agent registration, a GPU job, result persistence and native ChatGPT query. If provider credentials are missing, finish code/deployment/other tests and identify this specific remaining gate.

## Sources checked

- https://developers.google.com/colab/api/reference/rest
- https://developers.google.com/colab/api/reference/rest/v1beta/runtimes/create
- https://developers.google.com/colab/api/reference/rest/v1beta/runtimespecs/list
- https://research.google.com/colaboratory/faq.html
- https://supabase.com/changelog.md
- https://supabase.com/docs/guides/functions/background-tasks
- https://supabase.com/docs/guides/functions/storage-caching
