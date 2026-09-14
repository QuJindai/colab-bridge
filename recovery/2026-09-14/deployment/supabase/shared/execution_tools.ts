import { JobService } from "./job_api.ts";
import { CONVENIENCE_KINDS, executionSchemas } from "./execution_schemas.ts";
export const EXECUTION_READ_TOOLS = new Set([
  "colab_connection_status",
  "colab_list_jobs",
  "colab_job_status",
  "colab_job_logs",
  "colab_list_artifacts",
  "colab_read_artifact",
]);
export const EXECUTION_TOOL_NAMES = [
  "connection_status",
  "ensure_runtime",
  "wake",
  "wait_ready",
  "release_runtime",
  "submit_job",
  "list_jobs",
  "job_status",
  "job_logs",
  "cancel_job",
  "retry_job",
  ...Object.keys(CONVENIENCE_KINDS),
  "list_artifacts",
  "read_artifact",
].map((x) => "colab_" + x);
export function executionAnnotations(name: string) {
  const read = EXECUTION_READ_TOOLS.has(name);
  return {
    readOnlyHint: read,
    destructiveHint: !read,
    idempotentHint: read ||
      [
        "colab_cancel_job",
        "colab_release_runtime",
        "colab_wait_ready",
        "colab_retry_job",
      ].includes(name),
    openWorldHint: !read || name === "colab_read_artifact",
  };
}
export function toolResult(value: any) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
    ...(value.ok === false ? { isError: true } : {}),
  };
}
export function registerExecutionTools(
  server: any,
  { db, role, lifecycle, z }: { db: any; role: string; lifecycle: any; z: any },
) {
  const jobs = new JobService(db), schemas = executionSchemas(z);
  const handlers: Record<string, (input: any) => Promise<any>> = {
    connection_status: () => lifecycle.connectionStatus(),
    ensure_runtime: (a) => lifecycle.ensure(a),
    wake: (a) => lifecycle.ensure(a),
    wait_ready: (a) => lifecycle.waitReady(a.lifecycle_id),
    release_runtime: (a) => lifecycle.release(a),
    submit_job: (a) => jobs.submit(a),
    list_jobs: (a) => jobs.list(a),
    job_status: (a) => jobs.status(a.job_id),
    job_logs: async (a) => {
      const result = await jobs.logs(a.job_id, a.after ?? -1, a.limit ?? 20);
      if (!result.ok || !Array.isArray(result.events)) return result;
      const events: any[] = [];
      let chars = 0;
      for (const event of result.events) {
        if (chars + event.text.length > 65536) break;
        events.push(event);
        chars += event.text.length;
      }
      return {
        ...result,
        events,
        next_after: events.at(-1)?.seq ?? a.after ?? -1,
        has_more: events.length < result.events.length ||
          result.events.length === (a.limit ?? 20),
      };
    },
    cancel_job: (a) => jobs.cancel(a.job_id),
    retry_job: (a) =>
      jobs.retry(a.job_id, a.idempotency_key, a.checkpoint_path),
    list_artifacts: (a) => jobs.artifacts(a.job_id),
    read_artifact: (a) => jobs.readArtifact(a.artifact_id),
  };
  for (const [name, kind] of Object.entries(CONVENIENCE_KINDS)) {
    handlers[name] = (a) => {
      const {
        project,
        timeout_seconds,
        require_gpu,
        runtime_id,
        idempotency_key,
        ...spec
      } = a;
      return jobs.submit({
        kind,
        spec,
        ...Object.fromEntries(
          Object.entries({
            project,
            timeout_seconds,
            require_gpu,
            runtime_id,
            idempotency_key,
          }).filter(([, v]) => v !== undefined),
        ),
      });
    };
  }
  for (const name of EXECUTION_TOOL_NAMES) {
    server.registerTool(name, {
      title: name.replace(/^colab_/, "").replaceAll("_", " "),
      description: EXECUTION_READ_TOOLS.has(name)
        ? "Read durable Colab Bridge state. Artifact downloads expire after 300 seconds."
        : "Requires control key. Returns durable lifecycle/job state; use status/logs to follow progress. Runtime release requires explicit cancel_jobs when jobs are active.",
      inputSchema: schemas[name],
      annotations: executionAnnotations(name),
    }, async (input: any) => {
      if (
        !EXECUTION_READ_TOOLS.has(name) && role !== "control"
      ) {
        return toolResult({ ok: false, error_code: "CONTROL_KEY_REQUIRED" });
      }
      const parsed = schemas[name].safeParse(input);
      if (!parsed.success) {
        return toolResult({ ok: false, error_code: "INVALID_REQUEST" });
      }
      try {
        return toolResult(await handlers[name.slice(6)](parsed.data));
      } catch {
        return toolResult({ ok: false, error_code: "BACKEND_UNAVAILABLE" });
      }
    });
  }
}
