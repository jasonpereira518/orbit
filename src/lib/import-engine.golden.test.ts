import "../../scripts/smoke/_env";

import { after, before, describe, it, mock } from "node:test";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts, importJobRows, imports, interactions, type ImportJobRowPayload } from "@/db/schema";
import { runImportJobById } from "@/lib/import-job-dispatch";
import { parseLinkedInConnectionsCsv } from "@/lib/linkedin-connections";
import { ensureUserSettings } from "@/lib/user-settings";
import { expectGolden, freezeClock, sortBy } from "@/test-support/golden";
import { fixedId, GOLDEN_USER } from "@/test-support/fixtures";

// A LinkedIn Connections.csv: the preamble the real export carries, three people from
// e2e/fixtures/linkedin-connections.csv, plus the shapes that exercise the engine's branches
// (an existing contact matched by profile URL, a repeated person inside the file, a row with
// no profile URL, and an email-only identity).
const CSV = `Notes:
"When exporting your connection data, you may notice that some of the email addresses are missing."

First Name,Last Name,URL,Email Address,Company,Position,Connected On
Grace,Hopper,https://www.linkedin.com/in/grace-hopper-e2e,,Navy Labs,Rear Admiral,15 Jan 2024
Alan,Turing,https://www.linkedin.com/in/alan-turing-e2e,,Bletchley Park,Cryptanalyst,02 Mar 2023
Katherine,Johnson,https://www.linkedin.com/in/katherine-johnson-e2e,,NASA,Mathematician,10 Jun 2022
Grace,Hopper,https://www.linkedin.com/in/grace-hopper-e2e,,Navy Labs,Rear Admiral,15 Jan 2024
Dorothy,Vaughan,,dorothy@example.test,NACA,Supervisor,01 Feb 2021
Mary,Jackson,,,NASA,Engineer,not a date
`;

/**
 * `revalidatePath` needs a Next.js request store. In a bare process it throws this invariant
 * AFTER every database write of the run is done (the same tolerance scripts/smoke-import-engine.ts
 * applies), so it is swallowed and nothing else is.
 */
async function runJob(importId: string) {
  try {
    await runImportJobById(importId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.startsWith("Invariant: static generation store missing")) throw err;
  }
}

describe("runImportJob (golden)", () => {
  before(async () => {
    await ensureUserSettings(GOLDEN_USER);
    freezeClock();
  });
  after(() => mock.timers.reset());

  it("runs a LinkedIn connections CSV to completion", async () => {
    const db = await getDb();
    // Alan already exists under the same profile URL: the import must merge, not duplicate.
    await db.insert(contacts).values({
      id: fixedId(1),
      userId: GOLDEN_USER,
      fullName: "Alan Turing",
      company: "Old Company",
      title: "Old Title",
      linkedinUrl: "https://www.linkedin.com/in/alan-turing-e2e",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    });

    const parsed = parseLinkedInConnectionsCsv(CSV);
    const [job] = await db
      .insert(imports)
      .values({
        id: fixedId(1, 5),
        userId: GOLDEN_USER,
        importType: "linkedin_connections",
        fileName: "Connections.csv",
        status: "processing",
        totalRows: parsed.rows.length,
        stats: {},
      })
      .returning();
    await db.insert(importJobRows).values(
      parsed.rows.map((row, i) => ({
        importId: job.id,
        userId: GOLDEN_USER,
        rowIndex: i,
        payload: { index: i, ...row } as unknown as ImportJobRowPayload,
      }))
    );

    await runJob(job.id);

    const importRow = await db.query.imports.findFirst({ where: eq(imports.id, job.id) });
    // Wall-clock durations and statement counts vary run to run; everything else is kept.
    const { durationMs: _d, statements: _s, ...stats } = (importRow?.stats ?? {}) as Record<string, unknown>;
    const rawRows = await db.select().from(importJobRows).where(eq(importJobRows.importId, job.id));
    // Two rows of the file can name the same person (and, today, create two contacts), so a name
    // alone does not order contacts: break ties by the file row that produced each one.
    const rowOf = (id: string) => String(rawRows.find((r) => r.contactId === id)?.rowIndex ?? 99).padStart(3, "0");
    const people = sortBy(await db.select().from(contacts).where(eq(contacts.userId, GOLDEN_USER)), (c) => `${c.fullName}|${rowOf(c.id)}`);
    const nameOf = (id: string | null) => people.find((p) => p.id === id)?.fullName ?? null;
    const jobRows = rawRows.map((r) => ({ ...r, contactName: nameOf(r.contactId) }));

    expectGolden(import.meta.url, "import-engine-linkedin", {
      parserWarnings: parsed.warnings,
      import: {
        status: importRow?.status,
        totalRows: importRow?.totalRows,
        rowsProcessed: importRow?.rowsProcessed,
        contactsCreated: importRow?.contactsCreated,
        contactsUpdated: importRow?.contactsUpdated,
        stats,
        errorMessage: importRow?.errorMessage ?? null,
      },
      rows: sortBy(jobRows, (r) => String(r.rowIndex).padStart(4, "0")),
      contacts: people,
      interactions: sortBy(
        await db.select().from(interactions).where(eq(interactions.userId, GOLDEN_USER)),
        (i) => `${nameOf(i.contactId)}|${i.interactionType}`
      ),
    });
  });
});
