// Must stay first: strips DATABASE_URL / provider keys before the DB-importing tool module loads.
import "../../../scripts/smoke/_env";
/**
 * Registry snapshot (plan P0.4 / pins P8.10): tool names, order, surfaces, scopes, result
 * labels, field allowlists and each tool's input schema (as JSON Schema) against a
 * committed `tools.snapshot.json`. Regenerate deliberately with:
 *
 *   UPDATE_SNAPSHOT=1 npm run test:unit
 *
 * Descriptions are deliberately NOT snapshotted: prose churns and says nothing about shape.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { z } from "zod";
import { ORBIT_TOOLS } from "@/lib/tools/definitions";
import { toolsFor, type ToolSurface } from "@/lib/tools/registry";

const SNAPSHOT_PATH = join(process.cwd(), "src/lib/tools/tools.snapshot.json");

function inputSchemaOf(shape: Parameters<typeof z.object>[0]) {
  const json = z.toJSONSchema(z.object(shape), { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

function buildSnapshot() {
  const surfaces: ToolSurface[] = ["mcp", "chat"];
  return {
    tools: ORBIT_TOOLS.map((t) => ({
      name: t.name,
      title: t.title,
      scope: t.scope,
      surfaces: [...t.surfaces],
      resultLabel: t.resultLabel,
      annotations: t.annotations ?? null,
      fields: t.fields ?? null,
      surfaceKey: (t as { surface?: string }).surface ?? null,
      inputKeys: Object.keys(t.inputSchema),
      inputSchema: inputSchemaOf(t.inputSchema),
    })),
    toolsFor: Object.fromEntries(
      surfaces.map((s) => [
        s,
        {
          readWrite: toolsFor(ORBIT_TOOLS, s, ["read", "write"]).map((t) => t.name),
          readOnly: toolsFor(ORBIT_TOOLS, s, ["read"]).map((t) => t.name),
        },
      ])
    ),
  };
}

describe("tool registry snapshot", () => {
  it("ORBIT_TOOLS names are unique", () => {
    const names = ORBIT_TOOLS.map((t) => t.name);
    assert.equal(new Set(names).size, names.length);
  });

  it("toolsFor keeps ORBIT_TOOLS order and never offers a write tool to a read-only caller", () => {
    for (const surface of ["mcp", "chat"] as const) {
      const all = toolsFor(ORBIT_TOOLS, surface, ["read", "write"]);
      const order = ORBIT_TOOLS.filter((t) => all.includes(t));
      assert.deepEqual(all, order);
      assert.ok(toolsFor(ORBIT_TOOLS, surface, ["read"]).every((t) => t.scope === "read"));
    }
  });

  it("matches the committed snapshot (UPDATE_SNAPSHOT=1 to regenerate)", () => {
    // Round-trip through JSON so `undefined` and key order behave exactly as on disk.
    const actual = JSON.parse(JSON.stringify(buildSnapshot()));
    if (process.env.UPDATE_SNAPSHOT === "1" || !existsSync(SNAPSHOT_PATH)) {
      writeFileSync(SNAPSHOT_PATH, JSON.stringify(actual, null, 2) + "\n");
      return;
    }
    const committed = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
    assert.deepEqual(actual, committed);
  });
});
