import { createClient } from "npm:@supabase/supabase-js@2.116.0";
import { verifyKey } from "../../shared/auth.ts";
import {
  filterAllowedCommands,
  PayloadValidationError,
  validateAgentBody,
} from "../../shared/agent_logic.ts";
import {
  dispatchAgentJobOperation,
  isAgentJobOperation,
  JobService,
  validateAgentJobBody,
} from "../../shared/job_api.ts";
import { JobValidationError } from "../../shared/jobs.ts";

const MAX_BODY_BYTES = 256 * 1024;
const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const jobs = new JobService(db);

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function authorized(req: Request): Promise<boolean> {
  const raw = req.headers.get("X-Colab-Agent-Key") ?? "";
  if (!raw) return false;
  const { data, error } = await db
    .from("colab_bridge_access_keys")
    .select("key_hash")
    .eq("key_kind", "agent")
    .maybeSingle();
  if (error) throw new Error("BACKEND_UNAVAILABLE");
  if (!data?.key_hash) return false;
  return await verifyKey(raw, data.key_hash);
}

async function parseBody(req: Request): Promise<Record<string, unknown>> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new PayloadValidationError(
      "PAYLOAD_TOO_LARGE",
      "request body is too large",
    );
  }
  const text = await req.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    throw new PayloadValidationError(
      "PAYLOAD_TOO_LARGE",
      "request body is too large",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new PayloadValidationError(
      "INVALID_PAYLOAD",
      "body must be valid JSON",
    );
  }
  return isAgentJobOperation(parsed)
    ? validateAgentJobBody(parsed)
    : validateAgentBody(parsed);
}

async function handleOperation(
  body: Record<string, unknown>,
): Promise<Response> {
  const now = new Date().toISOString();
  const runtimeId = body.runtime_id as string;
  const op = body.op as string;

  if (isAgentJobOperation(body)) {
    return response(await dispatchAgentJobOperation(jobs, body));
  }

  if (op === "register") {
    const payload = body.payload as Record<string, unknown>;
    const { error } = await db.from("colab_bridge_runtimes").upsert(
      {
        runtime_id: runtimeId,
        label: body.label,
        runtime_metadata: payload,
        last_heartbeat_at: now,
      },
      { onConflict: "runtime_id" },
    );
    if (error) return response({ ok: false, error_code: "BACKEND_ERROR" }, 500);
    return response({ ok: true, runtime_id: runtimeId });
  }

  if (op === "heartbeat") {
    const payload = body.payload as Record<string, unknown>;
    const { data, error } = await db.rpc("colab_bridge_agent_heartbeat", {
      p_runtime_id: runtimeId,
      p_payload: payload,
    });
    if (error) return response({ ok: false, error_code: "BACKEND_ERROR" }, 500);
    if (!data?.ok) {
      return response(
        data ?? { ok: false, error_code: "BACKEND_ERROR" },
        data?.error_code === "NO_RUNTIME" ? 404 : 500,
      );
    }
    return response({ ok: true });
  }

  if (op === "snapshot") {
    const { error } = await db.from("colab_bridge_snapshots").insert({
      runtime_id: runtimeId,
      kind: body.kind,
      payload: body.payload,
      observed_at: now,
    });
    if (error) return response({ ok: false, error_code: "BACKEND_ERROR" }, 500);
    await db.from("colab_bridge_runtimes").update({ last_heartbeat_at: now })
      .eq("runtime_id", runtimeId);
    return response({ ok: true });
  }

  if (op === "poll") {
    const { data, error } = await db
      .from("colab_bridge_commands")
      .select("id,command_type,payload")
      .eq("runtime_id", runtimeId)
      .eq("status", "queued")
      .order("created_at", { ascending: true })
      .limit(10);
    if (error) return response({ ok: false, error_code: "BACKEND_ERROR" }, 500);
    const commands = filterAllowedCommands(data ?? []);
    const ids = commands.map((command) => command.id);
    if (ids.length > 0) {
      const { error: claimError } = await db
        .from("colab_bridge_commands")
        .update({ status: "claimed", claimed_at: now })
        .in("id", ids)
        .eq("status", "queued");
      if (claimError) {
        return response({ ok: false, error_code: "BACKEND_ERROR" }, 500);
      }
    }
    return response({ ok: true, commands });
  }

  if (op === "result") {
    const status = body.status as string;
    const resultRow = {
      command_id: body.command_id,
      runtime_id: runtimeId,
      status,
      payload: body.payload ?? null,
      error_code: body.error_code ?? null,
      created_at: now,
    };
    const { error } = await db.from("colab_bridge_results").upsert(resultRow, {
      onConflict: "command_id",
    });
    if (error) return response({ ok: false, error_code: "BACKEND_ERROR" }, 500);
    await db
      .from("colab_bridge_commands")
      .update({ status, completed_at: now })
      .eq("id", body.command_id)
      .eq("runtime_id", runtimeId);
    return response({ ok: true });
  }

  return response({ ok: false, error_code: "UNKNOWN_OPERATION" }, 400);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });
  if (req.method !== "POST") {
    return response({ ok: false, error_code: "METHOD_NOT_ALLOWED" }, 405);
  }
  try {
    if (!(await authorized(req))) {
      return response({ ok: false, error_code: "UNAUTHORIZED" }, 401);
    }
  } catch {
    return response({ ok: false, error_code: "BACKEND_UNAVAILABLE" }, 503);
  }

  try {
    const body = await parseBody(req);
    return await handleOperation(body);
  } catch (error) {
    if (
      error instanceof PayloadValidationError ||
      error instanceof JobValidationError
    ) {
      const status = error.code === "PAYLOAD_TOO_LARGE" ? 413 : 400;
      return response({
        ok: false,
        error_code: error.code,
        message: error.message,
      }, status);
    }
    console.error("colab-bridge-agent unexpected backend error");
    return response({ ok: false, error_code: "BACKEND_ERROR" }, 500);
  }
});
