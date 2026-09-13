/**
 * Guards the undo for the largest write the app makes on a user's behalf.
 *
 * An import can add hundreds of people from a file nobody read closely, and until schema
 * v34 there was no way back: `import_job_rows` recorded WHICH contact each row produced but
 * not whether the import created that person or folded into someone already in the network.
 * Both end as `done` with a contact id. A revert built on that alone has to guess, and the
 * wrong guess deletes a contact who predates the import entirely — a worse outcome than the
 * import being undone.
 *
 * The checks below are in two groups, and the second group is the one that matters:
 *
 *   1. A revert undoes what the import did — created contacts gone, merged contacts back to
 *      their pre-import column values, the import's interactions and reminders removed.
 *   2. A revert never destroys work done AFTER the import. A created contact the user has
 *      edited is kept. A merged contact edited since is not rolled back. An interaction the
 *      user wrote by hand is not deleted just because a re-import touched its row.
 *
 * Run: npx tsx scripts/smoke-import-revert.ts
 */
import "./smoke/_env";

process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke-revert";
process.env.CLERK_SECRET_KEY ||= "sk_test_smoke-revert";

import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../src/db";
import {
  contacts,
  imports,
  importJobRows,
  interactions,
  reminders,
  userSettings,
  type ImportJobRowPayload,
} from "../src/db/schema";
import { runImportJobById } from "../src/lib/import-job-dispatch";
import { revertImport } from "../src/lib/import-revert";
import { hasRevertibleStatus } from "../src/lib/import-revert-policy";
import { ensureUserSettings } from "../src/lib/user-settings";

const USER = "smoke-import-revert-user";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}
function section(name: string) {
  console.log(`\n${name}`);
}

/** See `scripts/smoke-import-engine.ts` — `revalidatePath` has no store in a bare script. */
async function runJob(importId: string) {
  try {
    await runImportJobById(importId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.startsWith("Invariant: static generation store missing")) throw err;
  }
}

async function reset() {
  const db = await getDb();
  await db.delete(interactions).where(eq(interactions.userId, USER));
  await db.delete(reminders).where(eq(reminders.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(imports).where(eq(imports.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await ensureUserSettings(USER);
}

function connection(i: number, over: Partial<Record<string, string>> = {}) {
  return {
    index: i,
    firstName: `Rev${i}`,
    lastName: `Tester${i}`,
    email: `rev${i}@example.com`,
    company: `Imported Co ${i}`,
    position: `Imported Title ${i}`,
    connectedOn: "15 Mar 2024",
    url: `https://www.linkedin.com/in/rev-${i}`,
    ...over,
  };
}

async function seedJob(rows: object[], importType = "linkedin_connections") {
  const db = await getDb();
  const [job] = await db
    .insert(imports)
    .values({
      userId: USER,
      importType,
      fileName: "revert-fixture.csv",
      status: "processing",
      totalRows: rows.length,
      stats: {},
    })
    .returning();
  await db.insert(importJobRows).values(
    rows.map((payload, i) => ({
      importId: job.id,
      userId: USER,
      rowIndex: i,
      payload: payload as ImportJobRowPayload,
    }))
  );
  return job.id;
}

const countContacts = async () => {
  const db = await getDb();
  return (await db.query.contacts.findMany({ where: eq(contacts.userId, USER) })).length;
};

async function main() {
  const db = await getDb();
  await reset();

  // ==================================================== 1. the plain create-then-undo case
  section("An import of new people can be undone completely");

  const jobA = await seedJob([connection(1), connection(2), connection(3)]);
  await runJob(jobA);

  check("three contacts were created", (await countContacts()) === 3, `got ${await countContacts()}`);

  const rowsA = await db.query.importJobRows.findMany({
    where: eq(importJobRows.importId, jobA),
  });
  check(
    "every written row recorded its outcome",
    rowsA.length === 3 && rowsA.every((r) => r.outcome === "created"),
    `got ${JSON.stringify(rowsA.map((r) => r.outcome))}`
  );
  check(
    "a created row carries no snapshot — the contact itself is the undo",
    rowsA.every((r) => r.revertSnapshot === null)
  );

  const importA = await db.query.imports.findFirst({ where: eq(imports.id, jobA) });
  check("the job finished", importA?.status === "completed", `got ${importA?.status}`);
  check("and reads as revertible", hasRevertibleStatus(importA!));

  const revertA = await revertImport(USER, jobA);
  check("the revert succeeded", revertA.ok);
  check(
    "it deleted all three",
    revertA.ok && revertA.stats.contactsDeleted === 3,
    revertA.ok ? `got ${revertA.stats.contactsDeleted}` : ""
  );
  check("the contacts are really gone", (await countContacts()) === 0);

  const afterA = await db.query.imports.findFirst({ where: eq(imports.id, jobA) });
  check("the import is stamped reverted", Boolean(afterA?.revertedAt));
  check("and carries what it did", afterA?.revertStats?.contactsDeleted === 3);
  check("a reverted import is no longer offered as revertible", !hasRevertibleStatus(afterA!));

  const twice = await revertImport(USER, jobA);
  check(
    "a second revert is refused rather than re-run",
    !twice.ok && twice.reason === "already_reverted",
    !twice.ok ? `got ${twice.reason}` : ""
  );

  // =========================================== 2. an edit made after the import is not lost
  section("A contact edited since the import is kept, not deleted");

  await reset();
  const jobB = await seedJob([connection(10), connection(11)]);
  await runJob(jobB);
  check("two contacts created", (await countContacts()) === 2);

  const [edited] = await db.query.contacts.findMany({
    where: eq(contacts.userId, USER),
    orderBy: (c, { asc }) => [asc(c.fullName)],
  });
  // The shape of a real edit: a column change with the timestamp every write path stamps.
  await db
    .update(contacts)
    .set({ notes: "I met them again at the summit.", updatedAt: new Date() })
    .where(eq(contacts.id, edited.id));

  const revertB = await revertImport(USER, jobB);
  check("the revert succeeded", revertB.ok);
  check(
    "only the untouched contact was deleted",
    revertB.ok && revertB.stats.contactsDeleted === 1,
    revertB.ok ? `got ${revertB.stats.contactsDeleted}` : ""
  );
  check(
    "and the edited one is reported as kept",
    revertB.ok && revertB.stats.contactsKept === 1,
    revertB.ok ? `got ${revertB.stats.contactsKept}` : ""
  );
  const survivor = await db.query.contacts.findFirst({ where: eq(contacts.id, edited.id) });
  check("the edited contact still exists", Boolean(survivor));
  check(
    "with the note the user wrote after the import",
    survivor?.notes === "I met them again at the summit.",
    `got ${JSON.stringify(survivor?.notes)}`
  );

  // ======================================================== 3. a fold-in is rolled back
  section("A merge is rolled back to the pre-import values");

  await reset();
  const [existing] = await db
    .insert(contacts)
    .values({
      userId: USER,
      fullName: "Dana Whitfield",
      email: "dana@example.com",
      company: "Original Co",
      title: "Original Title",
      relationshipScore: 4,
    })
    .returning();

  const jobC = await seedJob([
    connection(20, {
      firstName: "Dana",
      lastName: "Whitfield",
      email: "dana@example.com",
      company: "Imported Co",
      position: "Imported Title",
    }),
  ]);
  await runJob(jobC);

  const merged = await db.query.contacts.findFirst({ where: eq(contacts.id, existing.id) });
  check(
    "the import really did overwrite the company — this is what must be undoable",
    merged?.company === "Imported Co",
    `got ${JSON.stringify(merged?.company)}`
  );
  check("no second contact was created", (await countContacts()) === 1);

  const rowC = await db.query.importJobRows.findFirst({
    where: eq(importJobRows.importId, jobC),
  });
  check("the row is recorded as a merge", rowC?.outcome === "merged", `got ${rowC?.outcome}`);
  check(
    "and carries the pre-merge values",
    rowC?.revertSnapshot?.company === "Original Co" &&
      rowC?.revertSnapshot?.title === "Original Title",
    `got ${JSON.stringify(rowC?.revertSnapshot)}`
  );

  const revertC = await revertImport(USER, jobC);
  check("the revert succeeded", revertC.ok);
  check(
    "one merge rolled back, nothing deleted",
    revertC.ok && revertC.stats.mergesReverted === 1 && revertC.stats.contactsDeleted === 0,
    revertC.ok ? JSON.stringify(revertC.stats) : ""
  );

  const restored = await db.query.contacts.findFirst({ where: eq(contacts.id, existing.id) });
  check("the contact still exists — a merged-into person is never deleted", Boolean(restored));
  check("company restored", restored?.company === "Original Co", `got ${restored?.company}`);
  check("title restored", restored?.title === "Original Title", `got ${restored?.title}`);
  check(
    "a column the import did not write is untouched",
    restored?.relationshipScore === 4,
    `got ${restored?.relationshipScore}`
  );

  // ============================================= 4. a merge edited afterwards is left alone
  section("A merged contact edited since the import is not rolled back");

  await reset();
  const [existing2] = await db
    .insert(contacts)
    .values({
      userId: USER,
      fullName: "Sam Reyes",
      email: "sam@example.com",
      company: "Before Co",
    })
    .returning();

  const jobD = await seedJob([
    connection(30, {
      firstName: "Sam",
      lastName: "Reyes",
      email: "sam@example.com",
      company: "Imported Co",
    }),
  ]);
  await runJob(jobD);

  // The user corrects the company by hand after the import.
  await db
    .update(contacts)
    .set({ company: "Company I Chose Myself", updatedAt: new Date() })
    .where(eq(contacts.id, existing2.id));

  const revertD = await revertImport(USER, jobD);
  check("the revert succeeded", revertD.ok);
  check(
    "the merge was kept, not rolled back",
    revertD.ok && revertD.stats.mergesKept === 1 && revertD.stats.mergesReverted === 0,
    revertD.ok ? JSON.stringify(revertD.stats) : ""
  );
  const notClobbered = await db.query.contacts.findFirst({
    where: eq(contacts.id, existing2.id),
  });
  check(
    "the user's own value survives the undo",
    notClobbered?.company === "Company I Chose Myself",
    `got ${JSON.stringify(notClobbered?.company)}`
  );

  // ============================================ 5. provenance: only the import's own rows go
  section("A revert deletes only what the import inserted");

  await reset();
  const jobE = await seedJob([connection(40)]);
  await runJob(jobE);
  const [imported] = await db.query.contacts.findMany({ where: eq(contacts.userId, USER) });

  // A second, unrelated contact with a hand-written interaction. Neither belongs to the
  // import, and neither may be touched by its undo.
  const [mine] = await db
    .insert(contacts)
    .values({ userId: USER, fullName: "My Own Person" })
    .returning();
  await db.insert(interactions).values({
    userId: USER,
    contactId: mine.id,
    rawNotes: "Coffee, my own note.",
    interactionType: "note",
  });
  // And one written by hand against the *imported* contact — the harder case, because the
  // contact does belong to the import.
  await db.insert(interactions).values({
    userId: USER,
    contactId: imported.id,
    rawNotes: "I called them after the import.",
    interactionType: "call",
  });
  // Which counts as an edit to that contact, so the contact itself is kept too.
  await db
    .update(contacts)
    .set({ updatedAt: new Date() })
    .where(eq(contacts.id, imported.id));

  const handWritten = await db.query.interactions.findMany({
    where: and(eq(interactions.userId, USER), isNull(interactions.importId)),
  });
  check(
    "hand-written interactions carry no import provenance",
    handWritten.length === 2,
    `got ${handWritten.length}`
  );

  const revertE = await revertImport(USER, jobE);
  check("the revert succeeded", revertE.ok);

  const left = await db.query.interactions.findMany({
    where: eq(interactions.userId, USER),
  });
  check(
    "both hand-written interactions survive",
    left.length === 2 && left.every((i) => i.importId === null),
    `got ${left.length}: ${JSON.stringify(left.map((i) => i.rawNotes))}`
  );
  check(
    "the unrelated contact is untouched",
    Boolean(await db.query.contacts.findFirst({ where: eq(contacts.id, mine.id) }))
  );

  // =================================== 5b. the import's OWN interactions do go, by provenance
  section("The interactions an import logged are removed with it");

  await reset();
  const threads = [1, 2].map((i) => ({
    kind: "linkedin_message_thread" as const,
    conversationId: `rev-conv-${i}`,
    fullName: `Msg Person ${i}`,
    firstName: "Msg",
    lastName: `Person ${i}`,
    linkedinUrl: `https://www.linkedin.com/in/rev-msg-${i}`,
    messages: [
      { id: `rm-${i}-a`, body: "first message", sentAt: "2024-03-01T10:00:00Z" },
      { id: `rm-${i}-b`, body: "second message", sentAt: "2024-03-02T10:00:00Z" },
    ],
  }));
  const jobM = await seedJob(threads, "linkedin_messages");
  await runJob(jobM);

  const logged = await db.query.interactions.findMany({
    where: eq(interactions.userId, USER),
  });
  check("the import logged interactions", logged.length === 4, `got ${logged.length}`);
  check(
    "every one carries this import's id",
    logged.length > 0 && logged.every((i) => i.importId === jobM),
    `got ${JSON.stringify([...new Set(logged.map((i) => i.importId))])}`
  );

  const revertM = await revertImport(USER, jobM);
  check("the revert succeeded", revertM.ok);
  check(
    "the contacts went, taking their interactions by cascade",
    revertM.ok && revertM.stats.contactsDeleted === 2,
    revertM.ok ? JSON.stringify(revertM.stats) : ""
  );
  check(
    "no interaction is left behind",
    (await db.query.interactions.findMany({ where: eq(interactions.userId, USER) })).length === 0
  );

  // ================================================== 6. rows from before the outcome column
  section("An import that predates the provenance columns is refused, not guessed at");

  await reset();
  const jobF = await seedJob([connection(50)]);
  await runJob(jobF);
  const [preV34] = await db.query.contacts.findMany({ where: eq(contacts.userId, USER) });

  // Exactly what a pre-v34 row looks like: done, with a contact id, and no outcome.
  await db
    .update(importJobRows)
    .set({ outcome: null, revertSnapshot: null })
    .where(eq(importJobRows.importId, jobF));

  const revertF = await revertImport(USER, jobF);
  check("the revert still returns ok — there was simply nothing traceable", revertF.ok);
  check(
    "the untraceable row is counted",
    revertF.ok && revertF.stats.rowsUnknown === 1,
    revertF.ok ? JSON.stringify(revertF.stats) : ""
  );
  check(
    "and nothing was deleted on a guess",
    revertF.ok && revertF.stats.contactsDeleted === 0
  );
  check(
    "the contact is still there",
    Boolean(await db.query.contacts.findFirst({ where: eq(contacts.id, preV34.id) }))
  );

  // ================================================================= 7. ownership and state
  section("Refusals");

  const notMine = await revertImport("someone-else", jobF);
  check(
    "another user cannot revert this import",
    !notMine.ok && notMine.reason === "not_found",
    !notMine.ok ? `got ${notMine.reason}` : ""
  );

  await reset();
  const jobG = await seedJob([connection(60)]);
  // Left in `processing`, which is how a running job looks.
  const running = await revertImport(USER, jobG);
  check(
    "a running import is refused",
    !running.ok && running.reason === "still_running",
    !running.ok ? `got ${running.reason}` : ""
  );
  check(
    "and its status alone says so",
    !hasRevertibleStatus({ status: "processing", revertedAt: null })
  );
  check(
    "a cancelled import IS revertible — a half-finished one is the likeliest undo",
    hasRevertibleStatus({ status: "cancelled", revertedAt: null })
  );

  await reset();

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll import-revert guards passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
