/**
 * When someone last finished an import of a given kind — the LinkedIn line on the
 * Integrations overview. Completed runs only, newest first, one person's rows only.
 *
 * Run: npx tsx scripts/smoke-import-history.ts
 */
import "./smoke/_env";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { imports } from "../src/db/schema";
import { lastCompletedImportAt } from "../src/lib/import-history";
import { run } from "./smoke/_env";

const USER = "smoke-import-history-user";
const OTHER = "smoke-import-history-other";
const LINKEDIN = ["linkedin_connections", "linkedin_messages"] as const;

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

run(async () => {
  const db = await getDb();
  await db.delete(imports).where(eq(imports.userId, USER));
  await db.delete(imports).where(eq(imports.userId, OTHER));

  check("never imported is null", (await lastCompletedImportAt(USER, LINKEDIN)) === null);

  await db.insert(imports).values([
    { userId: USER, importType: "linkedin_connections", status: "completed", updatedAt: new Date("2026-09-10T00:00:00Z") },
    { userId: USER, importType: "linkedin_messages", status: "completed", updatedAt: new Date("2026-09-12T00:00:00Z") },
    { userId: USER, importType: "linkedin_connections", status: "failed", updatedAt: new Date("2026-09-20T00:00:00Z") },
    { userId: USER, importType: "google_contacts", status: "completed", updatedAt: new Date("2026-09-21T00:00:00Z") },
    { userId: OTHER, importType: "linkedin_connections", status: "completed", updatedAt: new Date("2026-09-22T00:00:00Z") },
  ]);

  const at = await lastCompletedImportAt(USER, LINKEDIN);
  check(
    "the newest completed LinkedIn import, of either kind — not a failed run, another type, or another person",
    at?.toISOString() === "2026-09-12T00:00:00.000Z",
    at?.toISOString()
  );
  check("an empty type list is null", (await lastCompletedImportAt(USER, [])) === null);

  // The smoke runner shares one PGlite across scripts.
  await db.delete(imports).where(eq(imports.userId, USER));
  await db.delete(imports).where(eq(imports.userId, OTHER));
});
