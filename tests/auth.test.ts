import test from "node:test";
import assert from "node:assert/strict";
import { sha256Hex, verifyKey } from "../supabase/shared/auth.ts";

test("verifyKey accepts a raw key matching the stored SHA-256 hash", async () => {
  const hash = await sha256Hex("bridge-secret");
  assert.equal(await verifyKey("bridge-secret", hash), true);
});

test("verifyKey rejects a different raw key", async () => {
  const hash = await sha256Hex("bridge-secret");
  assert.equal(await verifyKey("wrong-secret", hash), false);
});

test("verifyKey rejects malformed stored hashes", async () => {
  assert.equal(await verifyKey("bridge-secret", "not-a-hash"), false);
});

import { extractPresentedKey } from "../supabase/shared/auth.ts";

test("extractPresentedKey prefers the dedicated bridge header", () => {
  const headers = new Headers({
    "X-Colab-Bridge-Key": "header-secret",
    "Authorization": "Bearer bearer-secret",
  });
  assert.equal(
    extractPresentedKey("https://example.test/mcp?access_token=url-secret", headers, "X-Colab-Bridge-Key"),
    "header-secret",
  );
});

test("extractPresentedKey accepts Bearer authentication without OAuth", () => {
  const headers = new Headers({ Authorization: "Bearer bearer-secret" });
  assert.equal(extractPresentedKey("https://example.test/mcp", headers, "X-Colab-Bridge-Key"), "bearer-secret");
});

test("extractPresentedKey supports an endpoint token fallback for no-auth app setup", () => {
  const headers = new Headers();
  assert.equal(
    extractPresentedKey("https://example.test/mcp?access_token=url-secret", headers, "X-Colab-Bridge-Key"),
    "url-secret",
  );
});

test("extractPresentedKey rejects non-Bearer Authorization values and blank URL tokens", () => {
  assert.equal(
    extractPresentedKey("https://example.test/mcp?access_token=", new Headers({ Authorization: "Basic abc" }), "X-Colab-Bridge-Key"),
    "",
  );
});
