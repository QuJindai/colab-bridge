import { authenticateBridge } from "./auth.ts";
import { runtimeState } from "./freshness.ts";
import {
  buildGpuStatus,
  buildProcessesStatus,
  buildRuntimeStatus,
  MCP_TOOL_CATALOG,
  sanitizeNvidiaSmi,
} from "./mcp_tools.ts";
import { registerExecutionTools } from "./execution_tools.ts";
const SERVICE_VERSION = "0.2.0";
const SCHEMA_VERSION = "20260914113920";
/** Dependencies are injected only at the runtime edge; role is captured by independent factories. */
export function createBridgeHandler(
  { db, lifecycle, z, McpServer, createMcpHandler }: any,
) {
  function toolAnnotations(name: string) {
    return MCP_TOOL_CATALOG.find((tool) => tool.name === name)?.annotations ?? {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    };
  }

  function toolResult(value: Record<string, unknown>) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify(value) }],
      structuredContent: value,
    };
  }

  async function resolveRuntime(runtimeId?: string) {
    let query = db
      .from("colab_bridge_runtimes")
      .select(
        "runtime_id,label,accelerator,runtime_metadata,draining,created_at,last_heartbeat_at",
      );
    if (runtimeId) query = query.eq("runtime_id", runtimeId);
    else {query = query.order("last_heartbeat_at", { ascending: false }).limit(
        1,
      );}
    const { data, error } = await query.maybeSingle();
    if (error) throw new Error("BACKEND_ERROR");
    return data ?? null;
  }

  async function latestSnapshot(
    runtimeId: string,
    kind: "runtime" | "gpu" | "processes",
  ) {
    const { data, error } = await db
      .from("colab_bridge_snapshots")
      .select("payload,observed_at")
      .eq("runtime_id", runtimeId)
      .eq("kind", kind)
      .order("observed_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error("BACKEND_ERROR");
    return data ?? null;
  }

  function buildServer(role: "read" | "control") {
    const server = new McpServer(
      { name: "colab-bridge", version: SERVICE_VERSION },
      { capabilities: { tools: {} } },
    );

    server.registerTool(
      "colab_capabilities",
      {
        title: "Colab Bridge capabilities",
        description:
          "Report role-specific execution availability, provider setup blockers and live Agent telemetry.",
        inputSchema: z.object({}),
        annotations: toolAnnotations("colab_capabilities"),
      },
      async () => {
        const runtime = await resolveRuntime().catch(() => null);
        const state = runtime ? runtimeState(runtime.last_heartbeat_at) : null;
        return toolResult({
          service: "colab-bridge",
          version: SERVICE_VERSION,
          scope: role === "control"
            ? "observation-and-execution"
            : "observation-only",
          role,
          control_authorized: role === "control",
          execution_available: role === "control" && state?.status === "live" &&
            runtime?.runtime_metadata?.execution_enabled === true &&
            runtime?.draining !== true,
          setup: await lifecycle.connectionStatus(),
          features: {
            telemetry: { supported: true },
            jobs: { supported: true, authorized: role === "control" },
            recipes: {
              supported: true,
              authorized: role === "control",
              dependencies: "runtime-dependent",
            },
            artifacts: { supported: true },
            runtime_lifecycle: {
              supported: true,
              authorized: role === "control",
            },
          },
          supported_tools: MCP_TOOL_CATALOG.map((tool) => tool.name),
          supported_telemetry: [
            "runtime",
            "gpu",
            "nvidia_smi",
            "gpu_processes",
          ],
          live_runtime_available: state?.status === "live",
          most_recent_runtime_status: state?.status ?? "none",
        });
      },
    );

    server.registerTool(
      "colab_list_runtimes",
      {
        title: "List Colab runtimes",
        description:
          "List registered Colab runtime sessions with heartbeat freshness. Stale/offline runtimes are omitted unless requested.",
        inputSchema: z.object({
          include_stale: z.boolean().optional().default(false),
        }),
        annotations: toolAnnotations("colab_list_runtimes"),
      },
      async ({ include_stale }: any) => {
        const { data, error } = await db
          .from("colab_bridge_runtimes")
          .select("runtime_id,label,accelerator,created_at,last_heartbeat_at")
          .order("last_heartbeat_at", { ascending: false })
          .limit(50);
        if (error) {
          return toolResult({ ok: false, error_code: "BACKEND_ERROR" });
        }
        const runtimes = (data ?? []).map((row: any) => {
          const state = runtimeState(row.last_heartbeat_at);
          return {
            runtime_id: row.runtime_id,
            label: row.label,
            accelerator: row.accelerator,
            created_at: row.created_at,
            last_heartbeat_at: row.last_heartbeat_at,
            heartbeat_age_seconds: state.ageSeconds,
            status: state.status,
          };
        }).filter((row: any) => include_stale || row.status === "live");
        return toolResult({ ok: true, runtimes });
      },
    );

    server.registerTool(
      "colab_gpu_status",
      {
        title: "Get Colab GPU status",
        description:
          "Return live GPU inventory, VRAM, utilization, temperature, power, driver and CUDA telemetry from the selected or most recent Colab runtime.",
        inputSchema: z.object({ runtime_id: z.string().uuid().optional() }),
        annotations: toolAnnotations("colab_gpu_status"),
      },
      async ({ runtime_id }: any) => {
        try {
          const runtime = await resolveRuntime(runtime_id);
          const snapshot = runtime
            ? await latestSnapshot(runtime.runtime_id, "gpu")
            : null;
          return toolResult(buildGpuStatus(runtime, snapshot));
        } catch {
          return toolResult({ ok: false, error_code: "BACKEND_ERROR" });
        }
      },
    );

    server.registerTool(
      "colab_runtime_status",
      {
        title: "Get Colab runtime status",
        description:
          "Return heartbeat freshness and safe Python, platform, Colab and PyTorch runtime metadata.",
        inputSchema: z.object({ runtime_id: z.string().uuid().optional() }),
        annotations: toolAnnotations("colab_runtime_status"),
      },
      async ({ runtime_id }: any) => {
        try {
          const runtime = await resolveRuntime(runtime_id);
          const snapshot = runtime
            ? await latestSnapshot(runtime.runtime_id, "runtime")
            : null;
          return toolResult(buildRuntimeStatus(runtime, snapshot));
        } catch {
          return toolResult({ ok: false, error_code: "BACKEND_ERROR" });
        }
      },
    );

    server.registerTool(
      "colab_nvidia_smi",
      {
        title: "Get sanitized NVIDIA telemetry",
        description:
          "Return only the predefined safe NVIDIA telemetry fields used by Colab Bridge. Arbitrary nvidia-smi arguments are not accepted.",
        inputSchema: z.object({ runtime_id: z.string().uuid().optional() }),
        annotations: toolAnnotations("colab_nvidia_smi"),
      },
      async ({ runtime_id }: any) => {
        try {
          const runtime = await resolveRuntime(runtime_id);
          const snapshot = runtime
            ? await latestSnapshot(runtime.runtime_id, "gpu")
            : null;
          return toolResult(
            sanitizeNvidiaSmi(buildGpuStatus(runtime, snapshot)),
          );
        } catch {
          return toolResult({
            ok: false,
            error_code: "BACKEND_ERROR",
            gpus: [],
          });
        }
      },
    );

    server.registerTool(
      "colab_processes",
      {
        title: "Get Colab GPU processes",
        description:
          "Return safe NVIDIA compute-process metadata: PID, process name, GPU index when available, and GPU memory usage.",
        inputSchema: z.object({ runtime_id: z.string().uuid().optional() }),
        annotations: toolAnnotations("colab_processes"),
      },
      async ({ runtime_id }: any) => {
        try {
          const runtime = await resolveRuntime(runtime_id);
          const snapshot = runtime
            ? await latestSnapshot(runtime.runtime_id, "processes")
            : null;
          return toolResult(buildProcessesStatus(runtime, snapshot));
        } catch {
          return toolResult({
            ok: false,
            error_code: "BACKEND_ERROR",
            processes: [],
          });
        }
      },
    );

    server.registerTool(
      "colab_health",
      {
        title: "Get Colab Bridge health",
        description:
          "Check backend/database reachability and the freshness of the most recent runtime without exposing secrets.",
        inputSchema: z.object({}),
        annotations: toolAnnotations("colab_health"),
      },
      async () => {
        const { data, error } = await db
          .from("colab_bridge_runtimes")
          .select("last_heartbeat_at")
          .order("last_heartbeat_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        const state = data?.last_heartbeat_at
          ? runtimeState(data.last_heartbeat_at)
          : null;
        return toolResult({
          ok: !error,
          backend_available: !error,
          database_reachable: !error,
          schema_version: SCHEMA_VERSION,
          service_version: SERVICE_VERSION,
          most_recent_runtime_status: state?.status ?? "none",
          most_recent_heartbeat_age_seconds: state?.ageSeconds ?? null,
        });
      },
    );

    registerExecutionTools(server, { db, role, lifecycle, z });
    return server;
  }

  const handlers = {
    read: createMcpHandler(() => buildServer("read")),
    control: createMcpHandler(() => buildServer("control")),
  };
  return {
    async fetch(req: Request) {
      if (req.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
            "access-control-allow-headers":
              "content-type,accept,mcp-session-id,mcp-protocol-version,x-colab-bridge-key,authorization",
          },
        });
      }
      const auth = await authenticateBridge(req, db);
      if (!auth.ok) {
        return new Response(JSON.stringify({ error_code: auth.error_code }), {
          status: auth.status,
          headers: {
            "content-type": "application/json",
            "cache-control": "no-store",
          },
        });
      }
      try {
        return await handlers[auth.role].fetch(req);
      } catch {
        return new Response(
          JSON.stringify({ error_code: "BACKEND_UNAVAILABLE" }),
          {
            status: 503,
            headers: {
              "content-type": "application/json",
              "cache-control": "no-store",
            },
          },
        );
      }
    },
    async close() {
      await Promise.all([handlers.read.close(), handlers.control.close()]);
    },
  };
}
