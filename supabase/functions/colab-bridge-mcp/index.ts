import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { createMcpHandler, McpServer } from "npm:@modelcontextprotocol/server@2.0.0";
import * as z from "npm:zod@4";
import { extractPresentedKey, verifyKey } from "../../shared/auth.ts";
import { runtimeState } from "../../shared/freshness.ts";
import {
  buildGpuStatus,
  buildProcessesStatus,
  buildRuntimeStatus,
  MCP_TOOL_CATALOG,
  sanitizeNvidiaSmi,
} from "../../shared/mcp_tools.ts";

const SERVICE_VERSION = "0.1.0";
const SCHEMA_VERSION = "20260912";
const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

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
    .select("runtime_id,label,accelerator,runtime_metadata,created_at,last_heartbeat_at");
  if (runtimeId) query = query.eq("runtime_id", runtimeId);
  else query = query.order("last_heartbeat_at", { ascending: false }).limit(1);
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error("BACKEND_ERROR");
  return data ?? null;
}

async function latestSnapshot(runtimeId: string, kind: "runtime" | "gpu" | "processes") {
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

function buildServer() {
  const server = new McpServer(
    { name: "colab-bridge", version: SERVICE_VERSION },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "colab_capabilities",
    {
      title: "Colab Bridge capabilities",
      description: "Report the read-only capabilities of Colab Bridge and whether a live Colab runtime is available.",
      inputSchema: z.object({}),
      annotations: toolAnnotations("colab_capabilities"),
    },
    async () => {
      const runtime = await resolveRuntime();
      const state = runtime ? runtimeState(runtime.last_heartbeat_at) : null;
      return toolResult({
        service: "colab-bridge",
        version: SERVICE_VERSION,
        scope: "observation-only",
        supported_tools: MCP_TOOL_CATALOG.map((tool) => tool.name),
        supported_telemetry: ["runtime", "gpu", "nvidia_smi", "gpu_processes"],
        live_runtime_available: state?.status === "live",
        most_recent_runtime_status: state?.status ?? "none",
      });
    },
  );

  server.registerTool(
    "colab_list_runtimes",
    {
      title: "List Colab runtimes",
      description: "List registered Colab runtime sessions with heartbeat freshness. Stale/offline runtimes are omitted unless requested.",
      inputSchema: z.object({ include_stale: z.boolean().optional().default(false) }),
      annotations: toolAnnotations("colab_list_runtimes"),
    },
    async ({ include_stale }) => {
      const { data, error } = await db
        .from("colab_bridge_runtimes")
        .select("runtime_id,label,accelerator,created_at,last_heartbeat_at")
        .order("last_heartbeat_at", { ascending: false })
        .limit(50);
      if (error) return toolResult({ ok: false, error_code: "BACKEND_ERROR" });
      const runtimes = (data ?? []).map((row) => {
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
      }).filter((row) => include_stale || row.status === "live");
      return toolResult({ ok: true, runtimes });
    },
  );

  server.registerTool(
    "colab_gpu_status",
    {
      title: "Get Colab GPU status",
      description: "Return live GPU inventory, VRAM, utilization, temperature, power, driver and CUDA telemetry from the selected or most recent Colab runtime.",
      inputSchema: z.object({ runtime_id: z.string().uuid().optional() }),
      annotations: toolAnnotations("colab_gpu_status"),
    },
    async ({ runtime_id }) => {
      try {
        const runtime = await resolveRuntime(runtime_id);
        const snapshot = runtime ? await latestSnapshot(runtime.runtime_id, "gpu") : null;
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
      description: "Return heartbeat freshness and safe Python, platform, Colab and PyTorch runtime metadata.",
      inputSchema: z.object({ runtime_id: z.string().uuid().optional() }),
      annotations: toolAnnotations("colab_runtime_status"),
    },
    async ({ runtime_id }) => {
      try {
        const runtime = await resolveRuntime(runtime_id);
        const snapshot = runtime ? await latestSnapshot(runtime.runtime_id, "runtime") : null;
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
      description: "Return only the predefined safe NVIDIA telemetry fields used by Colab Bridge. Arbitrary nvidia-smi arguments are not accepted.",
      inputSchema: z.object({ runtime_id: z.string().uuid().optional() }),
      annotations: toolAnnotations("colab_nvidia_smi"),
    },
    async ({ runtime_id }) => {
      try {
        const runtime = await resolveRuntime(runtime_id);
        const snapshot = runtime ? await latestSnapshot(runtime.runtime_id, "gpu") : null;
        return toolResult(sanitizeNvidiaSmi(buildGpuStatus(runtime, snapshot)));
      } catch {
        return toolResult({ ok: false, error_code: "BACKEND_ERROR", gpus: [] });
      }
    },
  );

  server.registerTool(
    "colab_processes",
    {
      title: "Get Colab GPU processes",
      description: "Return safe NVIDIA compute-process metadata: PID, process name, GPU index when available, and GPU memory usage.",
      inputSchema: z.object({ runtime_id: z.string().uuid().optional() }),
      annotations: toolAnnotations("colab_processes"),
    },
    async ({ runtime_id }) => {
      try {
        const runtime = await resolveRuntime(runtime_id);
        const snapshot = runtime ? await latestSnapshot(runtime.runtime_id, "processes") : null;
        return toolResult(buildProcessesStatus(runtime, snapshot));
      } catch {
        return toolResult({ ok: false, error_code: "BACKEND_ERROR", processes: [] });
      }
    },
  );

  server.registerTool(
    "colab_health",
    {
      title: "Get Colab Bridge health",
      description: "Check backend/database reachability and the freshness of the most recent runtime without exposing secrets.",
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
      const state = data?.last_heartbeat_at ? runtimeState(data.last_heartbeat_at) : null;
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

  return server;
}

const handler = createMcpHandler(buildServer);

async function authorized(req: Request): Promise<boolean> {
  const raw = extractPresentedKey(req.url, req.headers, "X-Colab-Bridge-Key");
  if (!raw) return false;
  const { data, error } = await db
    .from("colab_bridge_access_keys")
    .select("key_hash")
    .eq("key_kind", "bridge")
    .maybeSingle();
  if (error || !data?.key_hash) return false;
  return await verifyKey(raw, data.key_hash);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
        "access-control-allow-headers": "content-type,accept,mcp-session-id,x-colab-bridge-key,authorization",
      },
    });
  }
  if (!(await authorized(req))) {
    return new Response(JSON.stringify({ error_code: "UNAUTHORIZED" }), {
      status: 401,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }
  return await handler.fetch(req);
});
