/**
 * The chunked LinkedIn connections import (`src/lib/imports/linkedin-connections-staging.ts`
 * and its browser half): an export too big for one request previews and stages whole; the
 * duplicate flags are exactly the one-request preview's; the staged rows are exactly what
 * `startLinkedInImport` stages for the same selection; the upload refuses chunks out of
 * order, from someone else, or after the start; and the engine imports what was staged.
 *
 * Runs against a throwaway PGlite. Run: npx tsx scripts/smoke-linkedin-connections-chunked.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

// `requireUserId()` resolves to "demo-user" only in `isDemoMode()`; see
// smoke-related-contacts-scale.ts. The actions under test run as that user.
(process.env as Record<string, string>).NODE_ENV = "development";

import { and, asc, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, importJobRows, imports } from "../src/db/schema";
import { IMPORT_TEXT_MAX_BYTES } from "../src/lib/capture-limits";
import { previewLinkedInCsv, startLinkedInImport } from "../src/actions/imports";
import { previewConnections } from "../src/lib/imports/linkedin-connections-client";
import { CONNECTIONS_APPEND_MAX_ROWS, type StagedConnectionRow } from "../src/lib/imports/linkedin-connections-chunks";
import {
  appendConnectionsRows,
  beginConnectionsStaging,
  startConnectionsStaged,
} from "../src/lib/imports/linkedin-connections-staging";
import { parseLinkedInConnectionsCsv } from "../src/lib/linkedin-connections";
import { runImportJobById } from "../src/lib/import-job-dispatch";
import { ensureUserSettings } from "../src/lib/user-settings";

const USER = "demo-user";
const OTHER = "smoke-chunked-other";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
async function refused(fn: () => Promise<unknown>) {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
}

function csv(n: number) {
  const lines = [
    "Notes:",
    "\"When exporting your connection data, you may notice that some of the email addresses are missing.\"",
    "",
    "First Name,Last Name,URL,Email Address,Company,Position,Connected On",
  ];
  for (let i = 0; i < n; i++) {
    // Every 97th row is someone already in the network (same LinkedIn URL); every 89th shares
    // only a name with someone here, a candidate below the merge bar.
    const known = i % 97 === 0;
    const first = known ? `Known${i}` : i % 89 === 0 ? `Near${i}` : `First${i}`;
    lines.push(`${first},Last${i},https://www.linkedin.com/in/person-${i},${i % 3 ? "" : `p${i}@example.com`},Company ${i % 50},Engineer,01 Jan 2024`);
  }
  return lines.join("\n");
}

async function runJob(importId: string) {
  try {
    await runImportJobById(importId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.startsWith("Invariant: static generation store missing")) throw err;
  }
}

run(async () => {
  const db = await getDb();
  for (const u of [USER, OTHER]) {
    await db.delete(imports).where(eq(imports.userId, u));
    await db.delete(contacts).where(eq(contacts.userId, u));
    await ensureUserSettings(u);
  }
  const known = Array.from({ length: 60 }, (_, k) => k * 97).map((i) => ({
    userId: USER,
    fullName: `Known${i} Last${i}`,
    linkedinUrl: `https://www.linkedin.com/in/person-${i}`,
    company: `Company ${i % 50}`,
  }));
  const near = Array.from({ length: 30 }, (_, k) => (k + 1) * 89).filter((i) => i % 97 !== 0).map((i) => ({
    userId: USER,
    fullName: `Near${i} Last${i}`,
    company: "Somewhere Else",
  }));
  await db.insert(contacts).values([...known, ...near]);

  console.log("An export over the one-request ceiling");
  const big = csv(45_000);
  const bigBytes = new TextEncoder().encode(big).length;
  check("the file is bigger than one request allows", bigBytes > IMPORT_TEXT_MAX_BYTES, `${(bigBytes / 1e6).toFixed(1)} MB`);
  const preview = await previewConnections(big);
  check("it previews whole", !("error" in preview) && preview.totalRows === 45_000);
  if ("error" in preview) throw new Error(preview.error);
  check("the people already here are flagged", preview.duplicateCount >= 60, String(preview.duplicateCount));

  console.log("\nThe same answer as the one-request preview");
  const small = csv(3_000);
  const one = await previewLinkedInCsv(small);
  const chunked = await previewConnections(small);
  if ("error" in one || "error" in chunked) throw new Error("preview refused");
  const view = (p: { id: string; fullName: string; isRepeat: boolean; duplicate: unknown }) => JSON.stringify([p.id, p.fullName, p.isRepeat, p.duplicate]);
  check("same rows, same duplicate flags and candidates", one.people.map(view).join() === chunked.people.map(view).join());
  check("  including near matches below the merge bar", chunked.people.some((p) => p.duplicate && !p.isRepeat));
  check("same counts and warnings", one.duplicateCount === chunked.duplicateCount && JSON.stringify(one.warnings) === JSON.stringify(chunked.warnings));
  check("the one-request preview no longer carries every row twice", !("preview" in one));

  console.log("\nStaging");
  const { rows } = parseLinkedInConnectionsCsv(big);
  const selected = rows.map((_, i) => i).filter((i) => i % 5 !== 0);
  const staged = (from: number, to: number): StagedConnectionRow[] =>
    selected.slice(from, to).map((index) => ({ index, ...rows[index] }));
  const { importId } = await beginConnectionsStaging(USER, "Connections.csv");
  check("a chunk that does not start where the last ended is refused", await refused(() => appendConnectionsRows(USER, importId, 5, staged(0, 10))));
  check("someone else's upload is refused", await refused(() => appendConnectionsRows(OTHER, importId, 0, staged(0, 10))));
  check("a chunk over the size is refused", await refused(() => appendConnectionsRows(USER, importId, 0, staged(0, CONNECTIONS_APPEND_MAX_ROWS + 1))));
  check("a malformed row is refused", await refused(() => appendConnectionsRows(USER, importId, 0, [{ index: -1 }])));
  for (let start = 0; start < selected.length; start += CONNECTIONS_APPEND_MAX_ROWS) {
    await appendConnectionsRows(USER, importId, start, staged(start, start + CONNECTIONS_APPEND_MAX_ROWS));
  }
  check("a repeated chunk is refused", await refused(() => appendConnectionsRows(USER, importId, 0, staged(0, 10))));
  check("someone else cannot start it", await refused(() => startConnectionsStaged(OTHER, importId)));
  const started = await startConnectionsStaged(USER, importId);
  check("every selected row is staged", started.totalRows === selected.length, `${started.totalRows} of ${selected.length}`);
  check("it cannot be started twice", await refused(() => startConnectionsStaged(USER, importId)));
  check("nothing can be added once started", await refused(() => appendConnectionsRows(USER, importId, selected.length, staged(0, 1))));
  const empty = await beginConnectionsStaging(USER, "empty.csv");
  check("an upload with no rows does not start", await refused(() => startConnectionsStaged(USER, empty.importId)));
  await db.delete(imports).where(eq(imports.id, importId));
  await db.delete(imports).where(eq(imports.id, empty.importId));

  console.log("\nThe same rows as the one-request start, and the engine imports them");
  const pick = Array.from({ length: 300 }, (_, i) => String(i * 7));
  const legacy = await startLinkedInImport(small, "Connections.csv", pick).catch((err: Error) => {
    // `after()` outside a request; the rows are staged before it.
    if (!/after|request scope/i.test(err.message)) throw err;
    return null;
  });
  const legacyImport = legacy?.importId ?? (await db.query.imports.findFirst({ where: and(eq(imports.userId, USER), eq(imports.fileName, "Connections.csv")) }))!.id;
  const smallRows = parseLinkedInConnectionsCsv(small).rows;
  const viaChunks = await beginConnectionsStaging(USER, "chunked.csv");
  await appendConnectionsRows(USER, viaChunks.importId, 0, pick.map(Number).map((index) => ({ index, ...smallRows[index] })));
  await startConnectionsStaged(USER, viaChunks.importId);
  const stagedOf = async (id: string) =>
    JSON.stringify((await db.select({ rowIndex: importJobRows.rowIndex, payload: importJobRows.payload, status: importJobRows.status })
      .from(importJobRows).where(eq(importJobRows.importId, id)).orderBy(asc(importJobRows.rowIndex))));
  check("staged rows identical to startLinkedInImport's", (await stagedOf(legacyImport)) === (await stagedOf(viaChunks.importId)));
  await db.delete(imports).where(eq(imports.id, legacyImport));
  const before = (await db.select().from(contacts).where(eq(contacts.userId, USER))).length;
  await runJob(viaChunks.importId);
  const job = await db.query.imports.findFirst({ where: eq(imports.id, viaChunks.importId) });
  const after = (await db.select().from(contacts).where(eq(contacts.userId, USER))).length;
  check("the engine finishes the staged import", job?.status === "completed" && job.rowsProcessed === pick.length, `${job?.status} ${job?.rowsProcessed}`);
  check("  and adds the new people", after > before, `${before} -> ${after}`);

  for (const u of [USER, OTHER]) {
    await db.delete(imports).where(eq(imports.userId, u));
    await db.delete(contacts).where(eq(contacts.userId, u));
  }
  if (failures) throw new Error(`${failures} check(s) failed`);
  console.log("\nChunked connections import checks passed.");
});
