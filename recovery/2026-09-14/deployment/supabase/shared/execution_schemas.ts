/** Inject Zod so Node and Deno validate precisely the same tool contracts. */
export const CONVENIENCE_KINDS: Record<string, string> = {
  exec_python: "python",
  exec_shell: "shell",
  pip_install: "pip",
  checkout_repo: "git",
  download_model: "model_download",
  benchmark_model: "benchmark",
  finetune_lora: "lora",
  export_model: "export",
  stage_file: "file",
  export_to_drive: "drive_export",
  run_pipeline: "pipeline",
};
export function executionSchemas(z: any): Record<string, any> {
  const str = () => z.string().min(1).max(65536),
    uuid = () => z.string().uuid(),
    int = (min: number, max: number) => z.number().int().min(min).max(max);
  const path = () =>
    z.string().min(1).max(512).refine(
      (v: string) =>
        !v.startsWith("/") && !v.endsWith("/") && !/[\\\x00]/.test(v) &&
        v.split("/").every((x) => x && x !== "." && x !== ".."),
      "must be a workspace-relative path",
    );
  const https = () =>
    str().refine((v: string) => {
      try {
        const u = new URL(v);
        return u.protocol === "https:" && !u.username && !u.password &&
          !u.search && !u.hash && (!u.port || u.port === "443");
      } catch {
        return false;
      }
    }, "requires credential-free HTTPS");
  const env = z.record(
    z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
    z.string().max(8192),
  ).refine(
    (v: any) =>
      Object.keys(v).every((k) =>
        !/(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|KEY|AUTH|DATABASE_URL|DSN)/i
          .test(k)
      ),
    "credentials are not job environment inputs",
  );
  const common = {
    env: env.optional(),
    artifacts: z.array(path()).max(10000).optional(),
    result_path: path().optional(),
  };
  const model = {
    model_path: path(),
    adapter_path: path().optional(),
    cpu_threads: int(1, 64).optional(),
  };
  const compute = {
    device: z.enum(["auto", "cpu", "cuda"]).optional(),
    dtype: z.enum(["float32", "float16", "bfloat16"]).optional(),
    cpu_threads: int(1, 64).optional(),
  };
  const shapes: Record<string, any> = {
    python: { code: str(), ...common },
    shell: { command: str(), ...common },
    pip: { packages: z.array(str()).min(1).max(1000), ...common },
    git: {
      url: https().refine((v: string) =>
        ["github.com", "gitlab.com", "huggingface.co", "cnb.cool"].includes(
          new URL(v).hostname,
        )
      ),
      revision: str().refine((v: string) => !v.startsWith("-")),
      output_dir: path().optional(),
    },
    model_download: {
      model_id: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
      revision: str(),
      provider: z.enum(["huggingface", "modelscope"]).optional(),
      output_dir: path().optional(),
      allow_patterns: z.array(str()).min(1).max(1000).optional(),
    },
    benchmark: {
      ...model,
      ...compute,
      prompt: str().optional(),
      max_new_tokens: int(1, 4096).optional(),
      stop_on_eos: z.boolean().optional(),
      warmup_runs: int(1, 100).optional(),
      warmup_tokens: int(1, 4096).optional(),
    },
    lora: {
      model_path: path(),
      data_path: path(),
      output_dir: path().optional(),
      checkpoint_path: path().optional(),
      ...compute,
      max_steps: int(1, 100000).optional(),
      checkpoint_every: int(1, 100000).optional(),
      rank: int(1, 256).optional(),
      alpha: z.number().positive().optional(),
      target_modules: z.array(str()).min(1).max(1000).optional(),
      learning_rate: z.number().positive().optional(),
      max_length: int(2, 65536).optional(),
      seed: int(0, 4294967295).optional(),
    },
    export: {
      ...model,
      format: z.enum(["onnx", "gguf"]),
      output_path: path().optional(),
      sample_text: str().optional(),
      converter_path: z.string().min(1).max(512).startsWith("/").optional(),
      outtype: z.enum(["f32", "f16", "bf16", "q8_0"]).optional(),
    },
    file: {
      path: path(),
      text: z.string().max(131072).optional(),
      base64: z.string().max(131072).optional(),
      source_url: https().optional(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    },
    drive_export: {
      source_path: path(),
      mode: z.enum(["mount", "api"]).optional(),
      destination: path().optional(),
      name: str().optional(),
      parent_id: str().optional(),
    },
  };
  const refine = (kind: string, s: any) =>
    kind === "file"
      ? s.refine(
        (v: any) =>
          ["text", "base64", "source_url"].filter((k) => v[k] !== undefined)
            .length === 1,
        "exactly one content source is required",
      )
      : kind === "lora"
      ? s.refine(
        (v: any) =>
          v.checkpoint_every === undefined ||
          v.checkpoint_every <= (v.max_steps ?? 10),
        "checkpoint_every must not exceed max_steps",
      )
      : kind === "pipeline"
      ? s.refine(
        (v: any) =>
          (!v.checkpoint_path || v.resume === true) &&
          new Set(v.steps.map((x: any) => x.id)).size === v.steps.length,
        "checkpoint requires resume; step ids must be unique",
      )
      : s;
  const specs: Record<string, any> = Object.fromEntries(
    Object.entries(shapes).map(([k, v]) => [k, refine(k, z.strictObject(v))]),
  );
  const step = z.discriminatedUnion(
    "kind",
    Object.entries(specs).map(([kind, spec]) =>
      z.strictObject({
        id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
        kind: z.literal(kind),
        spec,
        inputs: z.array(path()).max(10000).optional(),
      })
    ),
  );
  shapes.pipeline = {
    steps: z.array(step).min(1).max(100),
    resume: z.boolean().optional(),
    checkpoint_path: path().optional(),
  };
  specs.pipeline = refine("pipeline", z.strictObject(shapes.pipeline));
  const envelope = {
    project: z.string().regex(/^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/i)
      .optional(),
    timeout_seconds: int(1, 3600).optional(),
    require_gpu: z.boolean().optional(),
    runtime_id: uuid().optional(),
    idempotency_key: z.string().min(1).max(200).optional(),
  };
  const ensure = z.strictObject({
    provider: z.enum(["google_colab", "external"]).optional(),
    accelerator: z.string().regex(/^[A-Z][A-Z0-9_-]{0,31}$/).optional(),
    request_id: uuid().refine(
      (v: string) => v[14] === "4",
      "request_id must be UUID4",
    ).optional(),
  });
  const schemas: Record<string, any> = {
    colab_connection_status: z.strictObject({}),
    colab_ensure_runtime: ensure,
    colab_wake: ensure,
    colab_wait_ready: z.strictObject({ lifecycle_id: uuid() }),
    colab_release_runtime: z.strictObject({
      runtime_id: uuid().optional(),
      lifecycle_id: uuid().optional(),
      cancel_jobs: z.boolean().optional(),
    }).refine(
      (v: any) => !!v.runtime_id !== !!v.lifecycle_id,
      "select exactly one runtime_id or lifecycle_id",
    ),
    colab_submit_job: z.discriminatedUnion(
      "kind",
      Object.entries(specs).map(([kind, spec]) =>
        z.strictObject({ kind: z.literal(kind), spec, ...envelope })
      ),
    ),
    colab_list_jobs: z.strictObject({
      status: z.enum([
        "queued",
        "running",
        "cancelling",
        "succeeded",
        "failed",
        "cancelled",
        "timed_out",
        "lost",
      ]).optional(),
      runtime_id: uuid().optional(),
      limit: int(1, 100).optional(),
    }),
    colab_job_status: z.strictObject({ job_id: uuid() }),
    colab_job_logs: z.strictObject({
      job_id: uuid(),
      after: int(-1, Number.MAX_SAFE_INTEGER).optional(),
      limit: int(1, 100).optional(),
    }),
    colab_cancel_job: z.strictObject({ job_id: uuid() }),
    colab_retry_job: z.strictObject({
      job_id: uuid(),
      idempotency_key: z.string().min(1).max(200),
      checkpoint_path: path().optional(),
    }),
    colab_list_artifacts: z.strictObject({ job_id: uuid() }),
    colab_read_artifact: z.strictObject({ artifact_id: uuid() }),
  };
  for (const [name, kind] of Object.entries(CONVENIENCE_KINDS)) {
    schemas["colab_" + name] = refine(
      kind,
      z.strictObject({ ...shapes[kind], ...envelope }),
    );
  }
  return schemas;
}
