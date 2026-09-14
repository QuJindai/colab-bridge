import test from "node:test";
import assert from "node:assert/strict";
import * as z from "zod";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { createBridgeHandler } from "../supabase/shared/mcp_server.ts";
import { sha256Hex } from "../supabase/shared/auth.ts";
const jobId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
async function setup() {
  const rows = [{ key_kind: "bridge", key_hash: await sha256Hex("read-key") }, {
    key_kind: "control",
    key_hash: await sha256Hex("control-key"),
  }];
  const calls: any[] = [];
  const state = { lookupError: false };
  const db = {
    from: () => ({
      select: () => ({
        in: async () =>
          state.lookupError
            ? ({ error: { message: "private lookup endpoint" } })
            : ({ data: rows }),
        order: () => ({
          limit: () => ({ maybeSingle: async () => ({ data: null }) }),
        }),
      }),
    }),
    rpc: async (name: string, args: any) => {
      calls.push({ name, args });
      return { data: { ok: true, job_id: jobId, status: "queued" } };
    },
  };
  const handler = createBridgeHandler({
    db,
    lifecycle: { connectionStatus: async () => ({ ok: true }) },
    z,
    McpServer,
    createMcpHandler,
  });
  async function rpc(key: string, method: string, params: any = {}) {
    const response = await handler.fetch(
      new Request("https://example.test/mcp", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2025-06-18",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      }),
    );
    const text = await response.text();
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      data = JSON.parse(
        text.split("\n").find((x: string) => x.startsWith("data:"))!.slice(5),
      );
    }
    return { response, data };
  }
  return { handler, rpc, calls, state };
}
test("actual SDK concurrent read/control requests retain independent roles", async () => {
  const { handler, rpc, calls, state } = await setup();
  try {
    const args = { code: "print(1)", runtime_id: jobId };
    const [read, control] = await Promise.all(
      ["read-key", "control-key"].map((key) =>
        rpc(key, "tools/call", { name: "colab_exec_python", arguments: args })
      ),
    );
    assert.equal(read.response.status, 200);
    assert.equal(
      read.data.result.structuredContent.error_code,
      "CONTROL_KEY_REQUIRED",
    );
    assert.equal(control.data.result.structuredContent.job_id, jobId);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args.p_runtime_id, jobId);
    const invalid = await rpc("control-key", "tools/call", {
      name: "colab_benchmark_model",
      arguments: { model_path: "model", warmup_runs: 0 },
    });
    assert.ok(invalid.data.result?.isError || invalid.data.error);
    assert.equal(calls.length, 1);
    const list = await rpc("read-key", "tools/list");
    assert.equal(list.data.result.tools.length, 31);
    for (const tool of list.data.result.tools) {
      assert.equal(tool.inputSchema.type, "object", tool.name);
    }
    const missing = await rpc("bad", "tools/list");
    assert.equal(missing.response.status, 401);
    state.lookupError = true;
    const unavailable = await rpc("read-key", "tools/list");
    assert.equal(unavailable.response.status, 503);
    assert.deepEqual(unavailable.data, { error_code: "BACKEND_UNAVAILABLE" });
    state.lookupError = false;
    const caps = await rpc("read-key", "tools/call", {
      name: "colab_capabilities",
      arguments: {},
    });
    assert.equal(caps.data.result.structuredContent.execution_available, false);
  } finally {
    await handler.close();
  }
});
