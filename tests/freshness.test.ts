import test from "node:test";
import assert from "node:assert/strict";
import { runtimeState } from "../supabase/shared/freshness.ts";

const now = new Date("2026-09-12T10:00:00.000Z");

test("runtime is live through 60 seconds", () => {
  assert.deepEqual(runtimeState("2026-09-12T09:59:00.000Z", now), { status: "live", ageSeconds: 60 });
});

test("runtime is stale after 60 through 300 seconds", () => {
  assert.equal(runtimeState("2026-09-12T09:58:59.000Z", now).status, "stale");
  assert.deepEqual(runtimeState("2026-09-12T09:55:00.000Z", now), { status: "stale", ageSeconds: 300 });
});

test("runtime is offline after 300 seconds", () => {
  assert.equal(runtimeState("2026-09-12T09:54:59.000Z", now).status, "offline");
});
