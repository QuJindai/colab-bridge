# Task 2 report: Agent execution worker and persistence

## Implementation

- Added `execute_job(job, workspace, emit, cancelled)` with real process-group execution for Python, shell, and pip jobs. It streams decoded stdout/stderr while the process runs, limits every emitted chunk to 8,192 characters, applies pipe backpressure with bounded process and delivery queues, records exit status, and terminates the complete process group on timeout or cancellation. Termination sends `SIGTERM`, waits a bounded grace period, and sends `SIGKILL` to the group even when its leader exited before a TERM-ignoring descendant.
- Log publication runs on a separate bounded worker, so a blocked network sink cannot delay timeout, cancellation, or lease-loss enforcement. Failed, blocked, or dropped delivery sets `logs_complete: false` and `dropped_log_chunks` in the execution outcome; `JobRunner` persists that report under `result._colab_bridge`.
- Added the built-in file job for bounded UTF-8 text, validated base64, or HTTPS content. Optional input SHA-256 is verified before the file is accepted. HTTPS staging runs in a separate streaming worker, checks the job deadline/cancellation independently, and atomically publishes only a completed verified temporary file.
- Added workspace creation at `<workspace_root>/<project>/<job_id>`, safe POSIX-relative resolution, traversal rejection, and symlink escape rejection. The default root is `/content/colab-bridge`; `COLAB_BRIDGE_WORKSPACE_ROOT` can override it.
- Added filtered child environments. Names indicating keys, tokens, secrets, passwords, credentials, cookies, authentication, database URLs, or DSNs are removed; sensitive overrides are rejected. The Agent key and every known filtered environment secret are redacted across stdout/stderr chunk boundaries before publication. Only a suffix that could begin a secret is buffered, preserving prompt delivery of normal readiness lines.
- Added result JSON loading and SHA-256/byte-count/MIME manifests for requested files and directory contents. Missing, invalid, or symlinked outputs fail explicitly.
- Added `JobRunner(config, client, runtime_id, stop_event=None)`. `run_once()` claims and executes at most one job; `run_forever()` polls without exiting on a transient claim/worker exception. Fenced mutations always use the runner's known `runtime_id` plus the claimed `job.id` and `job.lease_token`.
- Job lease renewal runs in its own thread every 10 seconds and remains active through restore download, subprocess execution, artifact upload, and terminal completion retries. An explicit invalid lease or 60 seconds without a valid renewal stops execution and prevents stale completion. Server cancellation remains under renewal, is checked again before subprocess launch, terminates an active group, and persists `cancelled` while the lease remains valid.
- Restore downloads use the claim's short-lived `download_url`, stream to a no-follow temporary file, verify byte count and SHA-256, and never forward the Agent key. Restore failure explicitly completes the job with `RESTORE_FAILED`; it never runs without the requested inputs.
- Artifact uploads stream from disk to the signed PUT URL with `Content-Type` and call `artifact_complete` only after a successful upload. Signed uploads/downloads use direct requests through the configured client's transport with client authentication disabled, so Agent headers, default authorization, cookies, and credential-like default headers are not forwarded while proxy/TLS behavior is preserved. An artifact persistence failure changes an otherwise successful job to `ARTIFACT_UPLOAD_FAILED`.
- Added the exact `AgentClient` operations `job_claim`, `job_heartbeat`, `job_log`, `job_complete`, `artifact_prepare`, and `artifact_complete`, plus credential-isolated streaming transfer helpers. Transient log delivery retries preserve the same sequence number. Terminal completion preserves an immutable outcome envelope and retries transient failures while independently renewing the lease, bounded by the lease/stop window; definitive `LEASE_INVALID` stops retries.
- Extended `AgentConfig` with validated optional `runtime_id`, explicit `execution_enabled`, workspace root, and job polling interval. `COLAB_BRIDGE_EXECUTION_ENABLED=1` is the only value that enables execution.
- Updated `run_agent` to preserve an explicit/generated runtime UUID across registration retries, isolate telemetry probe/HTTP failures, advertise `agent_version: "0.2.0"` and `execution_enabled` during registration and heartbeat, and run the execution worker separately from telemetry. Existing `max_cycles` behavior remains covered.
- Updated `colab_bridge_agent.__version__` to `0.2.0` as authorized by the task brief.

## TDD and verification evidence

The initial required subprocess tests were run before the implementation and failed during collection with `ModuleNotFoundError: No module named 'colab_bridge_agent.jobs'`. After the first Python/timeout implementation, the same focused command reported `2 passed in 1.03s`.

Further red phases recorded expected failures for missing configuration fields (`3 failed, 10 passed`), missing wire methods and registration retry behavior (`2 failed, 8 passed`), direct Agent-key redaction and transfer-time heartbeats (`2 failed, 15 passed`), transient log retry (`1 failed, 27 passed`), and a descendant holding pipes after its process leader exited (the test exceeded its five-second guard before the group-handling fix).

Fix round 1 began with nine expected failures (`9 failed, 23 passed in 13.08s`) covering TERM-ignoring descendants, slow log delivery, non-Agent secret boundary leakage, cancellation during restore, completion retry, deadline/cancellation-aware file staging, and inherited signed-request credentials. A separate rejected-log regression then failed because a backend `{ok:false}` response was silently treated as delivered; it now contributes to the persisted incomplete-log report.

Fresh final commands and actual results:

- `.venv/bin/python -m pytest agent/tests/test_jobs.py -q` — `33 passed in 7.72s`.
- `.venv/bin/python -m pytest agent/tests/test_client.py -q` — `7 passed in 0.04s`.
- `.venv/bin/python -m pytest -q` — `54 passed in 7.72s`.
- `.venv/bin/python -m compileall -q agent/colab_bridge_agent agent/tests` — exit 0, no output.
- `git diff --check` — exit 0, no output.

The tests use real local subprocesses for Python output, live streaming, shell stderr/nonzero exit, pip argument execution, timeout, cancellation, TERM-ignoring descendant escalation, and large log chunking. They also cover slow/rejected log sinks, cross-boundary stdout/stderr redaction, environment filtering, traversal/symlink rejection, atomic file staging timeout/cancellation, result JSON, artifact hashes and persistence order, verified restores, cancellation and failure during restore, lease loss, transient heartbeat/log/completion failures, lease renewal during slow transfers and completion retry, exact wire envelopes, signed-transfer credential isolation, stable runtime registration, and telemetry probe resilience.

## Interfaces for Task 3

`execute_job` handles `python`, `shell`, `pip`, and `file` itself. For every other kind it imports and calls:

```python
from .recipes import build_recipe
recipe = build_recipe(job, workspace)
```

`build_recipe(job, workspace)` must return a dictionary with:

- `argv`: non-empty `list[str]`;
- `cwd`: an existing absolute or workspace-relative directory that resolves under `workspace`;
- `env`: optional `dict[str, str]`; sensitive names are rejected and the remaining entries overlay the filtered runtime environment;
- `artifacts`: `list[str]` of workspace-relative files or directories;
- `result_path`: optional workspace-relative JSON file.

Artifacts and `result_path` are checked after a zero exit. Directories are expanded deterministically to regular files. Missing files, unsafe paths, symlinks, invalid result JSON, or an invalid descriptor produce a terminal failure rather than publishing partial output.

Built-in spec shapes are `{"code": str}` for Python, `{"command": str}` for shell, `{"packages": list[str]}` for pip, and exactly one of `text`, `base64`, or `source_url` plus `path` for file. Python/shell/pip specs may also supply `env`, `artifacts`, and `result_path`.

Every `execute_job` outcome retains `status`, `result`, `exit_code`, `error_code`, and `artifacts`, and also reports `logs_complete` plus `dropped_log_chunks`. Task 3 recipes require no log-specific behavior; they continue returning only the shared execution descriptor.

## Concerns and remaining gates

- Task 3's `recipes.py` does not exist yet, so non-built-in recipe kinds intentionally return `INVALID_JOB` until that task installs `build_recipe`.
- Signed transfer behavior is covered with `httpx.MockTransport` and slow-transfer fakes; no production cloud or real Supabase Storage mutation was performed in this task.
- Arbitrary Python and shell remain trusted single-user execution as specified. Workspace checks prevent accidental traversal and symlink-based output/restore escapes, but they are not an isolation boundary against hostile code.

## Fix round 2 evidence

- Signed download redirects are followed manually with a freshly constructed credential-free request at each hop. Every target must remain HTTPS, redirects are capped at five, and the configured HTTP transport remains responsible for proxy/TLS behavior. Regression coverage starts with a client that has default headers, cookies, and Basic auth, receives a new cookie on the first response, and proves neither existing nor response cookies reach the redirected request.
- Log delivery now stops dequeuing after its 100-ms drain budget, atomically marks the sender terminal, discards and counts queued chunks, and wakes `JobRunner` retry waits. One already-running synchronous HTTP call may finish, but it cannot start another retry or dequeue another chunk after closure; the persisted job result remains marked with incomplete-log metadata.
- Red phase: `.venv/bin/python -m pytest agent/tests/test_client.py::test_signed_download_redirects_never_inherit_client_credentials agent/tests/test_jobs.py::test_log_delivery_discards_queued_chunks_after_close_budget agent/tests/test_jobs.py::test_log_retry_stops_when_delivery_closes -q` — `3 failed in 1.47s` for the three reviewed behaviors.
- Covering green phase: `.venv/bin/python -m pytest agent/tests/test_client.py agent/tests/test_jobs.py -q` — `44 passed in 8.66s`.
- `.venv/bin/python -m compileall -q agent/colab_bridge_agent agent/tests` and `git diff --check` — exit 0, no output.
