export const ALLOWED_OPERATIONS = new Set(["register", "heartbeat", "snapshot", "poll", "result"]);
export const ALLOWED_SNAPSHOT_KINDS = new Set(["runtime", "gpu", "processes"]);
export const ALLOWED_COMMAND_TYPES = new Set(["refresh_gpu", "refresh_runtime", "refresh_processes"]);
export const ALLOWED_RESULT_STATUS = new Set(["completed", "failed", "rejected"]);

export class PayloadValidationError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PayloadValidationError";
    this.code = code;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function validateAgentBody(input: unknown): Record<string, unknown> {
  if (!isObject(input)) throw new PayloadValidationError("INVALID_PAYLOAD", "body must be an object");
  const op = input.op;
  if (typeof op !== "string" || !ALLOWED_OPERATIONS.has(op)) {
    throw new PayloadValidationError("UNKNOWN_OPERATION", "operation is not allowed");
  }
  if (!isUuid(input.runtime_id)) {
    throw new PayloadValidationError("INVALID_PAYLOAD", "runtime_id must be a UUID");
  }
  if (op === "register") {
    if (typeof input.label !== "string" || input.label.length < 1 || input.label.length > 80 || !isObject(input.payload)) {
      throw new PayloadValidationError("INVALID_PAYLOAD", "invalid register payload");
    }
  }
  if (op === "heartbeat") {
    if (!isObject(input.payload)) throw new PayloadValidationError("INVALID_PAYLOAD", "heartbeat payload must be an object");
  }
  if (op === "snapshot") {
    if (typeof input.kind !== "string" || !ALLOWED_SNAPSHOT_KINDS.has(input.kind) || !isObject(input.payload)) {
      throw new PayloadValidationError("INVALID_PAYLOAD", "invalid snapshot payload");
    }
  }
  if (op === "result") {
    if (!isUuid(input.command_id) || typeof input.status !== "string" || !ALLOWED_RESULT_STATUS.has(input.status)) {
      throw new PayloadValidationError("INVALID_PAYLOAD", "invalid result envelope");
    }
    if (input.payload !== null && input.payload !== undefined && !isObject(input.payload)) {
      throw new PayloadValidationError("INVALID_PAYLOAD", "result payload must be an object or null");
    }
    if (input.error_code !== null && input.error_code !== undefined && typeof input.error_code !== "string") {
      throw new PayloadValidationError("INVALID_PAYLOAD", "error_code must be a string or null");
    }
  }
  return input;
}

export function filterAllowedCommands(commands: unknown[]): Array<{ id: string; command_type: string; payload: Record<string, unknown> }> {
  const output: Array<{ id: string; command_type: string; payload: Record<string, unknown> }> = [];
  for (const raw of commands) {
    if (!isObject(raw)) continue;
    if (typeof raw.command_type !== "string" || !ALLOWED_COMMAND_TYPES.has(raw.command_type)) continue;
    if (typeof raw.id !== "string") continue;
    output.push({
      id: raw.id,
      command_type: raw.command_type,
      payload: isObject(raw.payload) ? raw.payload : {},
    });
  }
  return output;
}
