# Task 3 report — model/project/Drive recipes and durable research pipelines

Status: DONE_WITH_CONCERNS (implementation complete; provider/GPU acceptance limits below).
Base: `a31587644a030824685f2c0323bf38b1e82eedf7`, branch `feat/v0.2`.

## Implemented scope

- Added `recipes.py` and lazy SDK adapter modules under `recipes_impl/` for Git/CNB source checkout, Hugging Face and ModelScope snapshot download, Transformers generation benchmark, finite PEFT LoRA training, ONNX/GGUF export, mounted/API Drive export, and serial pipelines.
- The descriptor uses exactly `argv: list[str]`, `cwd: str`, `env: dict[str,str]`, `artifacts: list[str]`, and `result_path: str`. `cwd` resolves inside the workspace; generated launchers run in the Agent's Python and load optional SDKs only in the child. Built-in Python/shell/pip descriptors delegate to the reviewed worker; the file descriptor uses the reviewed staging helper. Direct `execute_job` built-in behavior remains compatible.
- Version is `0.2.0`; package description now identifies the GPU job worker. Optional extras pin the verified SDK versions. Base dependencies remain `httpx>=0.27,<1`. There is no Torch version pin and no CPU Torch installation in bootstrap. Colab's compatible installed CUDA Torch is retained; runtime model loading checks CUDA availability.
- Two job examples and accompanying instructions show isolated-workspace research and mounted Drive flows. The research example is a single download/data/benchmark/LoRA/adapted-benchmark/ONNX pipeline. Its small public HF model revision was independently resolved through the installed SDK.
- Focused `jobs.py` integration preserves structured recipe error results, validates object-valued result JSON, retains checkpoint artifacts on failure/cancellation/timeout, and uploads checkpoints while child recipes are running. No other task's files were modified.

## Exact downstream recipe input schemas

All outer jobs retain the existing `kind`, `spec`, `project`, and `timeout_seconds` shape. Default timeout is 900 seconds; the reviewed worker accepts 1..3600. Below, `?` denotes optional and defaults appear after `=`. Paths other than the explicitly installed GGUF converter and configured Drive mount are safe workspace-relative POSIX paths. Unknown recipe fields are rejected by `validate_spec`; do not put tokens, credentials, keys, or authorization fields in specs.

### git

```text
{url: string, revision: string, output_dir?: string = "repo"}
```

`url` must be credential-free HTTPS on exactly `github.com`, `gitlab.com`, `huggingface.co`, or `cnb.cool`, with no custom port other than 443, query or fragment. `revision` must be nonempty and must not start with `-`. Checkout records `requested_revision` and the actual `git rev-parse HEAD` value as `resolved_revision`; output must not already exist. Git internals are removed from the delivered source tree, and `.colab-bridge-revision.json` records its provenance. Git is an installed runtime prerequisite. Public `file://` URLs remain rejected; the real local Git test injects only the transport.

### model_download

```text
{model_id: string, revision: string,
 provider?: "huggingface" | "modelscope" = "huggingface",
 output_dir?: string = "model", allow_patterns?: nonempty string[]}
```

`model_id` is `owner/name`, using letters, digits, `.`, `_`, and `-`. Revision is explicit. HF resolves via `HfApi.model_info(...).sha`, then downloads that SHA. ModelScope accepts a 40-character SHA directly; named revisions are checked through its installed SDK and resolved through public `git ls-remote` because the current SDK branch-detail response has no SHA. The resolved immutable SHA is passed to `snapshot_download`. `allow_patterns` optionally permits bounded downloads, such as only `config.json`; this does not imply complete model weights. Output must not already exist. Result includes provider, model ID, requested/resolved revision, actual output path, content fingerprint and artifacts.

### benchmark

```text
{model_path: string, adapter_path?: string,
 device?: "auto" | "cpu" | "cuda" = "auto",
 dtype?: "float32" | "float16" | "bfloat16" = "float32",
 cpu_threads?: integer[1,64] = 1,
 prompt?: nonempty string = "Hello",
 max_new_tokens?: integer[1,4096] = 32,
 stop_on_eos?: boolean = false}
```

Local `AutoModelForCausalLM` and tokenizer only; `trust_remote_code=False`, `local_files_only=True`. Optional adapter is loaded through PEFT and merged. Generation uses greedy decoding and KV cache. Metrics report first-token seconds, total seconds, generated tokens, `(tokens - 1)/(total - first_token)` decode throughput, and overall tokens/second. Decode throughput is null if fewer than two tokens or zero decode duration. CUDA synchronizes before timing, after first token and subsequent forward passes, and before total measurement. CUDA peak allocated/reserved bytes are reported; CPU values are null. Timing excludes model loading/tokenization and has no warmup. Results include local content fingerprint and resolved revision when provenance exists.

### lora

```text
{model_path: string, data_path: string,
 output_dir?: string = "adapter", checkpoint_path?: string,
 device?: "auto" | "cpu" | "cuda" = "auto",
 dtype?: "float32" | "float16" | "bfloat16" = "float32",
 cpu_threads?: integer[1,64] = 1,
 max_steps?: integer[1,100000] = 10,
 checkpoint_every?: integer[1,max_steps] = min(5,max_steps),
 rank?: integer[1,256] = 8,
 alpha?: finite positive number = 2*rank,
 target_modules?: nonempty string[],
 learning_rate?: finite positive number = 0.0002,
 max_length?: integer[2,65536] = 128,
 seed?: integer[0,4294967295] = 42}
```

JSONL requires nonempty `text` strings, each tokenizing to at least two tokens. This is finite batch-one causal-LM adapter training, cycling records with AdamW; it is not a distributed trainer. Default target modules use PEFT's architecture mapping. Output includes `<output_dir>/final`, `metrics.json`, immutable checkpoints, and shared immutable input snapshots.

**LoRA `checkpoint_path` is a directory**, for example `adapter/checkpoints/<run>-step-000002`. Its exact published selection marker is **`<checkpoint_path>/checkpoint.json`**. That marker references the checkpoint's adapter files, `training.pt` optimizer/RNG state, and shared model/JSONL snapshots. The state includes `version:1`, `completed_steps`, `input_sha256`, `file_sha256`, `input_paths`, and `inputs` containing original path, snapshot path and SHA-256. Torch state loads use `weights_only=True`.

Restore **all parent published artifacts**. Merely restoring the marker is insufficient. Input snapshots are verified and copied back to the original `model_path`/`data_path` before loading. Existing differing input files fail. Model content, JSONL content, LoRA hyperparameters, dtype and seed must match; the total `max_steps` may remain the same or increase, and `checkpoint_every` may change. Resume preserves optimizer and RNG state. A checkpoint already at `max_steps` recreates final outputs with zero additional training steps. `output_dir` may be reused when it contains only restored `checkpoints`; otherwise use a new output directory. Referenced input snapshots remain output artifacts even on zero-step resume, so a later retry remains self-contained.

### export

```text
{model_path: string, format: "onnx" | "gguf",
 adapter_path?: string,
 output_path?: string = "export/model.<format>",
 cpu_threads?: integer[1,64] = 1,
 sample_text?: string = "Hello world",
 converter_path?: absolute installed path,
 outtype?: "f32" | "f16" | "bf16" | "q8_0" = "f16"}
```

Supported adapter architecture names are `gpt2` and `llama`. ONNX is a CPU float32, opset-18, fixed-shape logits graph with a precomputed causal mask; it has no generation loop or KV-cache interface. The shape is recorded and `onnx.checker.check_model` validates output. GGUF uses an installed official llama.cpp `convert_hf_to_gguf.py` from an unmodified Git checkout, records the actual converter commit and script SHA, checks `GGUF` magic/nonempty output and records file SHA/size. Optional adapters merge before export. Output files must not already exist. No TFLite conversion is advertised or implemented.

### drive_export

```text
{source_path: string,
 mode?: "mount" | "api" = "mount",
 destination?: string,
 name?: string = source basename,
 parent_id?: string}
```

Source is a regular workspace file. Mount mode requires `destination` relative to the existing directory configured through runtime `COLAB_BRIDGE_DRIVE_MOUNT`; the job does not supply the mount root. Missing mount fails explicitly. Existing destinations are not overwritten. API mode uses authorized ADC with `https://www.googleapis.com/auth/drive.file` and a real resumable `files().create(...).next_chunk()` helper. Optional API name/parent select the Drive destination. `GoogleDriveProvider(client=...)` accepts an already authorized Drive v3 client, and the `DriveProvider` protocol permits injected providers. Neither raw OAuth tokens nor credentials are placed in the job spec or child environment. A configured standard ADC file/default credential source is needed for subprocess API use; passing credentials through filtered environment overrides is not supported.

### pipeline

```text
{steps: Step[1..100], resume?: boolean = false, checkpoint_path?: string}
Step = {id: unique string, kind: a non-pipeline recipe/built-in kind,
        spec: that kind's object, inputs?: string[] = []}
```

Nested pipelines are rejected. Step `inputs` lists arbitrary-code file inputs; model/data/adapter/source/checkpoint paths for known recipes are included automatically. `spec.artifacts` is used for Python/shell/pip outputs. The serial execution inherits the outer process group, so timeout/cancellation terminates its descendants.

**Pipeline `checkpoint_path` is a file**, e.g. `.colab-bridge/checkpoints/pipeline-<run>/step-0002/checkpoint.json`. Require `resume:true` when specifying it. Its state contains `version:1`, `definition_sha256` of the exact ordered steps, `completed` step results, and `files` with original/snapshot paths and SHA-256. Restore all published parent artifacts; the recipe verifies the full selected checkpoint before restoring snapshots and skipping the completed prefix. Changed definitions, corrupt/missing snapshots and missing requested checkpoints fail as `CHECKPOINT_INVALID`.

A new `resume:true` pipeline without any claimed previous source can start normally. If `attempt>1`, a `parent_job_id`, or restored parent artifacts are present, `resume:true` without `checkpoint_path` fails before any code runs. No implicit latest-checkpoint selection occurs. Task 4 owns the linked retry API/SQL additions that select and restore the published marker. Fresh standalone jobs cannot see earlier job workspaces.

Completed arbitrary-code steps are skipped only after explicit validated resume. Code/process environment side effects are not file snapshots: installed packages, remote writes, and partially executed arbitrary-code effects need user judgment and environment preparation before explicitly resuming. If loss occurred before the first marker was persisted, no safe completed-step checkpoint exists; an explicit fresh run is required after deciding whether effects can be repeated.

### Built-ins

The reviewed worker shapes remain `python: {code, env?, artifacts?, result_path?}`, `shell: {command, env?, artifacts?, result_path?}`, `pip: {packages, env?, artifacts?, result_path?}` and `file: {path, exactly one of text/base64/source_url, sha256?}`. Pip packages are a nonempty string list; shell uses `/bin/bash -euo pipefail -c`; file staging retains its bounded streaming/checksum behavior. Object-valued Python job results remain unchanged. List/scalar result JSON fails locally with `OUTPUT_INVALID`, avoiding an invalid Agent API terminal payload.

## Durability and error integration

- Recipes atomically write version-1 JSON manifests under `.colab-bridge/publish/`, with `artifacts:list[str]` naming only closed immutable files. The parent validates safe regular paths, computes checksums, uploads using its fenced client, and renames a successful manifest to `.ack`. No API credentials are added to recipe environments.
- One parent uploader thread polls at 100 ms independently of process supervision, log delivery and lease renewal. Limits are 1 MiB per manifest, 10,000 file entries, and 2,048 manifest directory entries per workspace; only one upload is admitted at a time. Choose checkpoint intervals that fit these bounds. Pipeline snapshots copy selected files; shared LoRA input snapshots avoid copying the base model once per training checkpoint, although pipeline step snapshots still incur storage costs.
- `checkpoint.json` markers register after their referenced data; nested snapshot checkpoint files register before the outer pipeline marker. Server paths are immutable. Upload computes/compares file hashes before registration and rejects mutated already-published paths.
- Lease checks guard preparation, signed upload, and registration. Explicit lease rejection from either artifact mutation stops further admission immediately. Existing server fencing remains authoritative. Lease loss terminates execution and suppresses terminal completion under the stale lease.
- Failed/cancelled/timed-out recipes retain available checkpoint manifests. Parent persistence continues only under a valid lease. Publication drains for at most five seconds once supervision ends; an over-budget in-flight request may return, but the abort guard prevents later registration/admission. Incomplete publication is persisted as `result.checkpoint_publication.complete:false`; an otherwise successful job becomes `ARTIFACT_UPLOAD_FAILED` while existing recipe/timeout/cancel failure codes are preserved.
- Structured launcher codes include `MISSING_DEPENDENCY`, `OUT_OF_MEMORY`, `UNSUPPORTED_FORMAT`, `UNSUPPORTED_ARCHITECTURE`, `MODEL_MISSING`, `CUDA_UNAVAILABLE`, `CHECKPOINT_INVALID`, `CHECKPOINT_TOO_LARGE`, `PIPELINE_STEP_FAILED`, `DRIVE_MOUNT_MISSING`, `DRIVE_AUTH_MISSING`, `CONVERTER_MISSING`, `CONVERTER_INVALID`, `EXPORT_INVALID`, `REVISION_UNRESOLVED`, `OUTPUT_EXISTS`, and `NONFINITE_LOSS`. Unexpected SDK exceptions become `RECIPE_FAILED` with only the exception type, not potentially credential-bearing exception text. These error objects survive child nonzero exit into the durable result.

## TDD and self-review evidence

Initial focused red phase: `6 failed in 0.08s`, covering missing recipe modules, real local Git revision recording, pipeline checkpoint retention, Drive behavior, and non-object result rejection. After the initial implementation: `6 failed, 2 passed` demonstrated the worker still discarded error/checkpoint outputs. Later focused red phases exposed and then fixed:

- in-flight checkpoint retention and terminal result propagation;
- invalid publication JSON, missing resume selection after a previous attempt, and immutable ModelScope revision selection (`3 failed, 13 passed, 1 skipped`);
- strict fields/ranges (`1 failed, 18 passed, 1 skipped`);
- real LoRA resume in an empty restored workspace (`1 failed` before model/JSONL input snapshots were added);
- checkpoint marker registration before referenced data (`1 failed`), including nested checkpoint files (`1 failed`);
- unbounded publication drain and late registration (`1 failed`);
- exact-final-step LoRA resume and retained inputs on its zero-step output (`1 failed` each);
- repeated artifact mutation after explicit `LEASE_INVALID` (`1 failed`, six preparations before the fix; green asserts exactly one and no terminal mutation).

Self-review additionally verified module/descriptor compatibility, scoped ownership, process-group behavior in nested built-ins, workspace safety, absence of raw credentials in specs/environments, optional dependency isolation, provider availability claims, actual artifact checksums, and retry semantics. No helpers/reviewers/subagents were used.

### Actual model and provider evidence

Actual model Python: `/workspace/scratch/203f1bd95405/colab-model-validation/bin/python` with Torch `2.14.0+cpu`, Transformers `4.57.6`, PEFT `0.18.1`, Accelerate `1.15.0`, ONNX `1.22.0`, onnxscript `0.7.2`. Source fixtures were copied into each job workspace.

- Tiny causal model content fingerprint: `52f7df18cc9d37454283aad806d3c71a7d1f8fe6de5bd9bb7a2283d0c756c94d`. Actual eight-token CPU benchmark reported positive TTFT and decode throughput; CPU VRAM values are null. Representative measured run: TTFT `0.005538976 s`, total `0.022518210 s`, decode `412.268304 tokens/s`. These are CPU smoke values, not GPU acceptance or comparative model quality claims.
- Real LoRA losses for uninterrupted steps 1..3: `[2.3557906151, 2.3338596821, 2.4421010017]`. Two-step checkpoint restored into a genuinely new workspace using only published files, recovered model and data, then resumed from step 2 to step 3. Its final adapter `.safetensors` bytes equal uninterrupted three-step output. A checkpoint at total step 2 also recreated final output with an empty loss list and no optimizer step.
- Actual GPT2 ONNX export: `33,279 bytes`, opset 18, input shape `[1,2]`, checker passed, SHA-256 `f357844c365afa16f58407a2df5c42d3422aace1eb020b91ffb05f6ab7395317`. The original trace failed in Transformers causal-mask tracing; the fixed-shape precomputed causal mask resolved that real failure.
- Actual Llama GGUF export: `54,784 bytes`, `f32`, magic `GGUF`, output SHA-256 `9391fe6203aa72869e3973064dda6dfe4de260e4a069f00fe7f46845849e104e`. Official converter revision `89fe24240548456477870b2a627cd8021fea1e39`; script SHA `e9a1da876330bbce9687541ab31736542a01b4ac43c6686126514a50f122fb7f`. This exercised the actual export recipe, not only the upstream converter.
- Actual combined local pipeline: training-data staging, baseline benchmark, four LoRA steps, merged-adapter benchmark, and merged ONNX export all succeeded; five pipeline checkpoints and `168` collected artifacts. Training losses `[2.2110247612, 2.2036352158, 2.2204718590, 2.2193520069]`. Merged ONNX `[1,3]`, `33,312 bytes`, SHA `de47dcdf7685d8fe93770ee9eb188d39079cd836cd70228f63c9fdd3acdec3e0`. This used the public example's flow with the local tiny fixture staged in place of its network download step.
- Actual HF adapter config-only download: `Qwen/Qwen2.5-0.5B-Instruct`, `main` resolved to `7ae557604adf67be50417f59c2c2f167def9a775`.
- Actual ModelScope adapter config-only download: the same model, `master` resolved to `186d8559ad54c32cf47dc3a8225f993742c507b8` via public Git and downloaded with that exact SHA. Both adapters delivered `config.json`, `659 bytes`, SHA `18e18afcaccafade98daf13a54092927904649e1dd4eba8299ab717d5d94ff45`. No model weights or private files were downloaded in these provider probes.
- Public example `sshleifer/tiny-gpt2` SHA was resolved through `HfApi`: `5f91d94bd9cd7190a9f3216ff93cd1dd95f2c7be`.
- Mounted Drive was exercised against an explicitly configured existing local directory. The API helper was exercised with the real installed `MediaFileUpload` class and an injected authorized-client substitute that completed after two resumable chunks; source `abc` SHA `ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad`. Injected absent ADC produced `DRIVE_AUTH_MISSING`. These are adapter tests, not an authorized live Google Drive upload.
- Local Git test used a real initialized/committed repository, injected its checkout transport, and asserted the returned resolved HEAD equals the source commit. Public URL allowlisting stayed intact; no live CNB checkout was claimed.

## Validation commands and limitations

The final command/results are recorded below after completion. Logs and exploratory driver scripts remained in scratch; report evidence is committed here. Root-prepared `scripts/` and `tests/integration/` remained untouched and uncommitted.

Remaining acceptance limits: no CUDA runtime/GPU timing or VRAM measurement, no real Colab cold start, no live authorized Google Drive API transfer, no production Storage/Agent writes, and no live CNB checkout. ONNX acceptance is a fixed-shape GPT2 graph checked structurally; no ONNX Runtime numerical comparison or large external-weight export was exercised. GGUF acceptance is the compatible tiny Llama fixture with official conversion; tokenizer compatibility for other models remains converter-dependent. Pipeline durability snapshots selected files, not installed packages/process state/remote side effects. Large-model checkpoint copy/upload costs remain operational and are reported without claiming a cloud persistence benchmark. Root owns deployment, publication, browser acceptance and any eligible real GPU run.

Final verification:

- `COLAB_BRIDGE_REAL_MODEL_TESTS=1 .venv/bin/python -m pytest -q` — **84 passed in 40.27s**. This includes all existing Agent/client/config/worker tests and all new recipes, durability, fresh-workspace resume and real tiny-model tests; no skipped test in this command.
- `.venv/bin/python -m pytest -q` before the final focused lease regression — **82 passed, 1 skipped in 15.08s** (the explicit real-model fixture test is skipped unless opted in).
- `.venv/bin/python -m compileall -q agent/colab_bridge_agent agent/tests` — exit 0, no output.
- `git diff --check` — exit 0, no output.
- Actual public-provider, installed Drive-client adapter, and combined local-model pipeline commands exited 0 with the results above. No production action was performed.

## Fix round 1 — benchmark provenance and publication/resume durability

Fix base: `67dc51a763b90e254fc1729ddd08f30144da585f`. All three Important findings in `task-3-fix-1.md` are addressed. This section supersedes the earlier no-warmup benchmark description and terminal-publication drain implementation description.

### Benchmark interface and behavior

The complete supported benchmark input is now:

```text
{model_path: string, adapter_path?: string,
 device?: "auto" | "cpu" | "cuda" = "auto",
 dtype?: "float32" | "float16" | "bfloat16" = "float32",
 cpu_threads?: integer[1,64] = 1,
 prompt?: nonempty string = "Hello",
 max_new_tokens?: integer[1,4096] = 32,
 stop_on_eos?: boolean = false,
 warmup_runs?: integer[1,100] = 1,
 warmup_tokens?: integer[1,4096] = min(4,max_new_tokens)}
```

Warm-up runs the same synchronized greedy generation path with a fresh prompt/KV cache for each run. It completes before the measured generation, which also starts with a fresh cache. CUDA synchronizes before/after warm-up and during token generation; peak-memory counters reset after warm-up. Warm-up counts/configuration and elapsed seconds are recorded separately and excluded from TTFT/total/throughput. The `stop_on_eos` setting applies to warm-up too, so the actual warm-up token count is recorded separately from the requested tokens per run.

Existing result fields remain. Added result fields:

- `warmup: {runs:int, tokens_per_run:int, generated_tokens:int, elapsed_seconds:number}`.
- `framework_versions: {torch:string, transformers:string, cuda:string|null, cudnn:int|null, peft:string|null}`. PEFT is recorded when an adapter is used; CUDA/cuDNN are null for CPU execution.
- `hardware: {device_type:"cpu"|"cuda", cpu_architecture:string, cpu_threads:int, gpu:null|{index:int,name:string,total_memory_bytes:int,compute_capability:[int,int]}}`. CUDA metadata comes from actual device properties; CPU execution explicitly reports no GPU.
- `timing_scope` now reads `synchronized generation only; excludes model load/tokenization and warm-up`.

`torch_version`, model content fingerprint, and resolved revision fields are preserved. No quantization input option was added in this fix; the supported dtype/schema remains as listed above.

### One bounded publisher for running and terminal artifacts

Removed the synchronous terminal `persist()` fallback. The existing uploader thread now receives terminal artifacts and pending manifests after execution, wakes immediately, and processes all publication under the same five-second terminal drain deadline. Publication network I/O and upload hash rechecks remain off the completion thread. Deadline/abort/lease checks occur before artifact preparation, signed upload and registration, and after potentially slow upload/hash work. Existing active-lease heartbeat, immediate lease-rejection handling and nested-marker-last ordering remain covered.

If the budget expires, the runner marks publication incomplete, stops admitting work and finishes without waiting for a blocked upload to return. An already-issued request may return later; it cannot cause a subsequent registration/admission after the deadline. Available uploaded data without artifact registration is not claimed as a published checkpoint. A formerly successful job becomes `ARTIFACT_UPLOAD_FAILED` with `result.checkpoint_publication.complete:false`; failed/cancelled/timed-out recipe status remains intact with the same incomplete-publication report.

This also applies to **large terminal-only model exports**: if upload and registration cannot finish in the five-second drain, the job reports failed artifact persistence. This fix does not claim multi-GB persistence from tiny fixtures, expand Storage limits, or add an unbounded upload bypass. Task 5 must document the effective Storage/upload/drain limits. The existing output collection before publication still computes artifact metadata; the drain deadline bounds the publication stage.

### Fully completed pipeline resume

After validating a checkpoint whose completed prefix includes every pipeline step, the recipe republishes the selected marker and every referenced snapshot, and includes that closure in the new job's artifacts alongside restored original outputs. The selected checkpoint remains immutable; no completed code is rerun. The regression runs a source pipeline followed by two successive linked restores in different workspaces, restores only artifacts actually registered by its preceding runner, and proves that each resumed job republishes the marker/snapshots and retains original `data.txt == "1"`.

### Exact red/green and final validation

- Red: `.venv/bin/python -m pytest agent/tests/test_jobs.py::test_terminal_only_publication_obeys_deadline agent/tests/test_recipes.py::test_completed_pipeline_checkpoint_survives_two_linked_restores agent/tests/test_recipes.py::test_benchmark_warmup_schema -q` — **4 failed in 1.37s**. Terminal-only regular artifacts and checkpoints both exceeded the budget; the completed-resume marker was absent; warm-up fields were unsupported.
- Red: `.venv/bin/python -m pytest agent/tests/test_recipes.py::test_benchmark_warmup_is_outside_timing_and_records_hardware -q` — **2 failed in 0.10s**, CPU and CUDA substitute cases lacked warm-up metadata.
- Green: `.venv/bin/python -m pytest agent/tests/test_jobs.py::test_terminal_only_publication_obeys_deadline agent/tests/test_recipes.py::test_completed_pipeline_checkpoint_survives_two_linked_restores agent/tests/test_recipes.py::test_benchmark_warmup_schema agent/tests/test_recipes.py::test_benchmark_warmup_is_outside_timing_and_records_hardware -q` — **6 passed in 0.64s**.
- Covering: `.venv/bin/python -m pytest agent/tests/test_jobs.py agent/tests/test_recipes.py -q` — **66 passed, 1 skipped in 15.93s** (explicit real-model fixture test not enabled in this command).
- Final, including the installed real model Python: `COLAB_BRIDGE_REAL_MODEL_TESTS=1 .venv/bin/python -m pytest -q -s` — **90 passed in 40.59s**.
- `.venv/bin/python -m compileall -q agent/colab_bridge_agent agent/tests` and `git diff --check` — exit 0, no output.

The terminal-only upload regression sets a `0.05 s` drain budget against an upload that waits up to `0.5 s`, requires `run_once()` to finish in less than `0.2 s`, checks `ARTIFACT_UPLOAD_FAILED` and incomplete-publication metadata, then releases the upload and verifies no late registration and no second preparation. Both regular terminal artifacts and terminal-only checkpoints are covered. The synthetic benchmark uses a controlled clock and model calls to prove that two three-token warm-up runs consume six seconds outside a two-second measured generation, reset each KV cache, and synchronize/reset CUDA counters in the required order. Its CUDA device is a test substitute, not real GPU acceptance.

Actual tiny-model benchmark from the final suite:

```json
{
  "model_path": "model",
  "content_sha256": "52f7df18cc9d37454283aad806d3c71a7d1f8fe6de5bd9bb7a2283d0c756c94d",
  "resolved_revision": null,
  "device": "cpu",
  "framework_versions": {"torch":"2.14.0+cpu","transformers":"4.57.6","cuda":null,"cudnn":null,"peft":null},
  "hardware": {"device_type":"cpu","cpu_architecture":"x86_64","cpu_threads":1,"gpu":null},
  "warmup": {"runs":1,"tokens_per_run":4,"generated_tokens":4,"elapsed_seconds":0.01199310900119599},
  "metrics": {
    "first_token_seconds": 0.0024183059995266376,
    "total_seconds": 0.01683373600099003,
    "generated_tokens": 8,
    "decode_tokens_per_second": 485.59078704481175,
    "overall_tokens_per_second": 475.23615669923197,
    "peak_allocated_vram_bytes": null,
    "peak_reserved_vram_bytes": null
  }
}
```

The model is the local fixture, hence no remote revision is fabricated. The existing real LoRA fresh-workspace/byte-equivalence, ONNX and GGUF tests also passed in this final command. GPU identity/timing remains validated only through substitutes plus honest CPU execution; no real GPU, large cloud upload, authorized live Drive transfer or production action occurred. No unrelated edits, helper agents, or changes to Root's `scripts/` / `tests/integration/` drafts were made.
