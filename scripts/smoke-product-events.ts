/**
 * Guards the product-event taxonomy: schemas reject free text, the helper validates and
 * dedupes, and every schema has an ownership entry in analytics/events/README.md.
 *
 * Run: npx tsx scripts/smoke-product-events.ts
 */
import "./smoke/_env";

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { productEvents } from "../src/db/schema";
import { assertNoFreeText, eventSchemas } from "../src/lib/product-event-schemas";
import { buildProductEvent, trackNow } from "../src/lib/product-events";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

async function main() {
  console.log("schemas");
  const problems = Object.entries(eventSchemas).flatMap(([name, schema]) => assertNoFreeText(schema, name));
  check("no event admits an unbounded string", problems.length === 0, problems.join("; "));

  const readme = readFileSync("analytics/events/README.md", "utf8");
  const documented = new Set([...readme.matchAll(/^## ([a-z_]+)/gm)].map((m) => m[1]));
  const missing = Object.keys(eventSchemas).filter((n) => !documented.has(n));
  check("every event has an ownership entry", missing.length === 0, `undocumented: ${missing.join(", ")}`);
  const stale = [...documented].filter((n) => !(n in eventSchemas) && n !== "gate_hit");
  check("no ownership entry for a removed event", stale.length === 0, `stale: ${stale.join(", ")}`);

  console.log("\nhelper");
  let threw = false;
  try {
    buildProductEvent("capture_saved", { capture_job_id: "not-a-uuid", source_kind: "text", people_created: 1, people_updated: 0 });
  } catch {
    threw = true;
  }
  check("an invalid property throws outside production", threw);

  threw = false;
  try {
    // @ts-expect-error: a property the schema does not declare must not be accepted silently
    buildProductEvent("followup_snoozed", { reminder_id: randomUUID(), note: "call her tomorrow" });
  } catch {
    threw = true;
  }
  // zod strips unknown keys by default; the row must not carry them either way.
  const row = (() => {
    try {
      // @ts-expect-error: see above
      return buildProductEvent("followup_snoozed", { reminder_id: randomUUID(), note: "call her tomorrow" });
    } catch {
      return null;
    }
  })();
  check("an undeclared property never reaches the row", threw || !JSON.stringify(row?.properties ?? {}).includes("call her"));

  const id = randomUUID();
  const props = { capture_job_id: randomUUID(), source_kind: "text" as const, people_created: 2, people_updated: 0 };
  await trackNow("capture_saved", props, { id, userId: "user_smoke_events" });
  await trackNow("capture_saved", props, { id, userId: "user_smoke_events" });
  const db = await getDb();
  const rows = await db.select().from(productEvents).where(eq(productEvents.id, id));
  check("a repeated id is one row", rows.length === 1, `got ${rows.length}`);
  check("version and actor are stamped", rows[0]?.version === 1 && rows[0]?.actor === "user" && rows[0]?.surface === "web");

  const future = buildProductEvent("followup_snoozed", { reminder_id: randomUUID() }, { occurredAt: new Date(Date.now() + 3_600_000) });
  check("a far-future timestamp is replaced with now", future.occurredAt!.getTime() < Date.now() + 60_000);

  await db.delete(productEvents).where(eq(productEvents.userId, "user_smoke_events"));
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall checks passed");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
