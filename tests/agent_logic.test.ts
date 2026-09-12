import test from "node:test";
import assert from "node:assert/strict";
import {
  validateAgentBody,
  filterAllowedCommands,
  PayloadValidationError,
} from "../supabase/shared/agent_logic.ts";

const runtimeId = "11111111-1111-4111-8111-111111111111";

test("validateAgentBody accepts fixed register shape", () => {
  const value = validateAgentBody({
    op: "register",
    runtime_id: runtimeId,
    label: "gpu-lab",
    payload: { python_version: "3.12" },
  });
  assert.equal(value.op, "register");
  assert.equal(value.runtime_id, runtimeId);
});

test("validateAgentBody rejects unknown operations", () => {
  assert.throws(
    () => validateAgentBody({ op: "exec", runtime_id: runtimeId, payload: { cmd: "whoami" } }),
    (error: unknown) => error instanceof PayloadValidationError && error.code === "UNKNOWN_OPERATION",
  );
});

test("validateAgentBody rejects unknown snapshot kind", () => {
  assert.throws(
    () => validateAgentBody({ op: "snapshot", runtime_id: runtimeId, kind: "filesystem", payload: {} }),
    (error: unknown) => error instanceof PayloadValidationError && error.code === "INVALID_PAYLOAD",
  );
});

test("validateAgentBody rejects invalid runtime ids", () => {
  assert.throws(
    () => validateAgentBody({ op: "poll", runtime_id: "not-a-uuid" }),
    (error: unknown) => error instanceof PayloadValidationError && error.code === "INVALID_PAYLOAD",
  );
});

test("filterAllowedCommands strips non-allowlisted command types", () => {
  const commands = filterAllowedCommands([
    { id: "1", command_type: "refresh_gpu", payload: {} },
    { id: "2", command_type: "shell", payload: { cmd: "id" } },
    { id: "3", command_type: "refresh_processes", payload: {} },
  ]);
  assert.deepEqual(commands.map((x) => x.command_type), ["refresh_gpu", "refresh_processes"]);
});
