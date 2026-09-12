import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync("supabase/migrations/20260912_colab_bridge.sql", "utf8");
const tables = [
  "colab_bridge_access_keys",
  "colab_bridge_runtimes",
  "colab_bridge_snapshots",
  "colab_bridge_commands",
  "colab_bridge_results",
];

test("migration has explicit deny-all RLS policies for public API roles", () => {
  for (const table of tables) {
    assert.match(sql, new RegExp(`create policy ${table}_deny_public`, "i"), table);
    assert.match(sql, new RegExp(`on public\\.${table}[\\s\\S]*?to anon, authenticated[\\s\\S]*?using \\(false\\)[\\s\\S]*?with check \\(false\\)`, "i"), table);
  }
});

test("migration covers the results runtime foreign key with an index", () => {
  assert.match(
    sql,
    /create index if not exists colab_bridge_results_runtime_idx\s+on public\.colab_bridge_results \(runtime_id, created_at desc\)/i,
  );
});
