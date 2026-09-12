/**
 * Per-message direction on LinkedIn imports: who said what, and whether a re-upload can
 * teach an existing row something it did not know.
 *
 * Two things here are load-bearing and neither is obvious from the code.
 *
 * The first is the BACKFILL. `interactions.direction` is unrecoverable after the fact — the
 * sender was never persisted by earlier imports, and `raw_notes` holds only the body — so
 * re-uploading the export is the only way an existing row can ever learn it. That works only
 * because `linkedInMessageExternalId` hashes (conversation, date, content) and NOT direction:
 * a re-upload therefore reproduces every id exactly, hits the engine's ON CONFLICT branch,
 * and updates in place. Drop `direction` from that conflict `set` and the re-upload silently
 * accomplishes nothing, with no error and no changed row count. That is what the round-trip
 * below is for: it asserts the count did not move AND that the value appeared.
 *
 * The second is the OWNER GUESS. `resolveSelfIdentity` decides whose messages are "out", and
 * getting it backwards inverts an entire export rather than degrading gracefully. The
 * historical bug was ranking profiles by message count: in a 1:1 thread every message names
 * both parties, so the counts tie and the winner is whoever the Map saw first — i.e. whoever
 * messaged first. The cases below pin the conversation-count ranking that replaced it, and
 * pin that an unresolvable owner yields null rather than a coin flip.
 *
 * Run: npx tsx scripts/smoke-linkedin-direction.ts
 */
import "./smoke/_env";

process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke-direction";
process.env.CLERK_SECRET_KEY ||= "sk_test_smoke-direction";

import { and, count, eq, isNotNull } from "drizzle-orm";
import { getDb } from "../src/db";
import {
  contacts,
  imports,
  importJobRows,
  interactions,
  userSettings,
  type ImportJobRowPayload,
  type LinkedInMessageThreadRowPayload,
} from "../src/db/schema";
import { runImportJobById } from "../src/lib/import-job-dispatch";
import {
  messageDirection,
  parseLinkedInMessagesCsv,
  resolveSelfIdentity,
} from "../src/lib/linkedin-messages";
import { ensureUserSettings } from "../src/lib/user-settings";
import { run } from "./smoke/_env";

const USER = "smoke-direction-user";
const SELF = "https://www.linkedin.com/in/me-owner";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

/** See smoke-import-engine's runJob: revalidatePath has no store outside a Next request. */
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
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(imports).where(eq(imports.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await ensureUserSettings(USER);
}

async function seedJob(payloads: LinkedInMessageThreadRowPayload[]) {
  const db = await getDb();
  const [job] = await db
    .insert(imports)
    .values({
      userId: USER,
      importType: "linkedin_messages",
      fileName: "messages.csv",
      status: "processing",
      totalRows: payloads.length,
      stats: {},
    })
    .returning();
  await db.insert(importJobRows).values(
    payloads.map((payload, i) => ({
      importId: job.id,
      userId: USER,
      rowIndex: i,
      payload: payload as ImportJobRowPayload,
    }))
  );
  return job.id;
}

/**
 * A thread whose two messages keep the SAME external ids across calls — the ids are literals
 * here rather than hashes precisely so the re-upload case is unmistakable: nothing about the
 * identity of these rows changes, only what we know about them.
 */
function thread(
  direction: { a: "in" | "out" | null; b: "in" | "out" | null } | "absent"
): LinkedInMessageThreadRowPayload {
  const base = { kind: "linkedin_message_thread" as const,
    conversationId: "conv-1",
    fullName: "Dana Reyes",
    firstName: "Dana",
    lastName: "Reyes",
    linkedinUrl: "https://www.linkedin.com/in/dana-reyes",
  };
  if (direction === "absent") {
    // Exactly the shape a job queued before this column existed replays as: the key is
    // missing from the persisted JSONB, not present-and-null.
    return {
      ...base,
      messages: [
        { id: "li-msg:conv-1:a", body: "Good to meet you", sentAt: "2025-01-05T10:00:00.000Z" },
        { id: "li-msg:conv-1:b", body: "Likewise — let's talk", sentAt: "2025-01-06T10:00:00.000Z" },
      ],
    };
  }
  return {
    ...base,
    messages: [
      { id: "li-msg:conv-1:a", body: "Good to meet you", sentAt: "2025-01-05T10:00:00.000Z", direction: direction.a },
      { id: "li-msg:conv-1:b", body: "Likewise — let's talk", sentAt: "2025-01-06T10:00:00.000Z", direction: direction.b },
    ],
  };
}

async function messageRows() {
  const db = await getDb();
  return db.query.interactions.findMany({
    where: and(
      eq(interactions.userId, USER),
      eq(interactions.interactionType, "linkedin_message")
    ),
  });
}

// ---------------------------------------------------------------------------------------
// Parse layer: who owns the export, and who sent each message
// ---------------------------------------------------------------------------------------

function csv(rows: string[]) {
  return [
    "CONVERSATION ID,CONVERSATION TITLE,FROM,SENDER PROFILE URL,TO,RECIPIENT PROFILE URLS,DATE,SUBJECT,CONTENT,FOLDER",
    ...rows,
  ].join("\n");
}

function parseChecks() {
  console.log("\nOwner inference and per-message direction…");

  // Two threads. The owner appears in both; each counterpart in only one.
  const multi = csv([
    `c1,,Me Owner,${SELF},Dana Reyes,https://www.linkedin.com/in/dana,2025-01-05 10:00:00 UTC,,Hi Dana,INBOX`,
    `c1,,Dana Reyes,https://www.linkedin.com/in/dana,Me Owner,${SELF},2025-01-06 10:00:00 UTC,,Hi back,INBOX`,
    `c2,,Sam Cole,https://www.linkedin.com/in/sam,Me Owner,${SELF},2025-02-01 10:00:00 UTC,,Hello,INBOX`,
    `c2,,Me Owner,${SELF},Sam Cole,https://www.linkedin.com/in/sam,2025-02-02 10:00:00 UTC,,Hello back,INBOX`,
  ]);
  const { messages } = parseLinkedInMessagesCsv(multi);
  const self = resolveSelfIdentity(messages);
  check("the profile present in every thread is picked as the owner", self.slug === "me-owner", self.slug);
  check("a clear owner is confident", self.confident);
  check(
    "the owner's own message is outbound and the reply is inbound",
    messageDirection(messages[0], self) === "out" &&
      messageDirection(messages[1], self) === "in"
  );

  // The historical inversion: ONE 1:1 thread, counterpart messages first and most.
  // Under message-count ranking the counterpart wins the tie and every label flips.
  const single = csv([
    `c1,,Dana Reyes,https://www.linkedin.com/in/dana,Me Owner,${SELF},2025-01-05 10:00:00 UTC,,First,INBOX`,
    `c1,,Dana Reyes,https://www.linkedin.com/in/dana,Me Owner,${SELF},2025-01-06 10:00:00 UTC,,Second,INBOX`,
    `c1,,Me Owner,${SELF},Dana Reyes,https://www.linkedin.com/in/dana,2025-01-07 10:00:00 UTC,,Reply,INBOX`,
  ]);
  const singleParsed = parseLinkedInMessagesCsv(single).messages;
  const guessed = resolveSelfIdentity(singleParsed);
  check(
    "a single-thread export refuses to name an owner rather than guessing",
    !guessed.confident
  );
  check(
    "and therefore labels nothing at all",
    singleParsed.every((m) => messageDirection(m, guessed) === null)
  );

  // The user's own settings URL outranks anything the file implies.
  const told = resolveSelfIdentity(singleParsed, SELF);
  check("an explicit self URL from settings is trusted outright", told.confident && told.slug === "me-owner");
  check(
    "and it recovers the direction the file alone could not",
    messageDirection(singleParsed[0], told) === "in" &&
      messageDirection(singleParsed[2], told) === "out"
  );

  // A blank SENDER PROFILE URL is common in real exports and means "unknown", not "them".
  const blankSender = csv([
    `c1,,Me Owner,,Dana Reyes,https://www.linkedin.com/in/dana,2025-01-05 10:00:00 UTC,,No sender url,INBOX`,
  ]);
  const blank = parseLinkedInMessagesCsv(blankSender).messages;
  check(
    "a message with no sender URL is left unknown, not assumed inbound",
    messageDirection(blank[0], told) === null
  );
}

// ---------------------------------------------------------------------------------------
// Write layer: direction persists, and a re-upload backfills it in place
// ---------------------------------------------------------------------------------------

async function writeChecks() {
  console.log("\nPersisting direction through the import engine…");

  await reset();
  await runJob(await seedJob([thread({ a: "out", b: "in" })]));
  let rows = await messageRows();
  check("both messages logged", rows.length === 2, `got ${rows.length}`);
  check(
    "direction is stored per message, not per thread",
    rows.find((r) => r.externalId === "li-msg:conv-1:a")?.direction === "out" &&
      rows.find((r) => r.externalId === "li-msg:conv-1:b")?.direction === "in"
  );

  console.log("\nA payload from before the column existed…");
  await reset();
  await runJob(await seedJob([thread("absent")]));
  rows = await messageRows();
  check("it still imports", rows.length === 2, `got ${rows.length}`);
  check(
    "and its rows read as unknown rather than being guessed at",
    rows.every((r) => r.direction === null)
  );

  console.log("\nRe-uploading the export to backfill it…");
  const db = await getDb();
  await runJob(await seedJob([thread({ a: "out", b: "in" })]));
  const after = await messageRows();
  // These two assertions have to hold together. Either alone is satisfiable by a bug:
  // duplicating every row would "populate direction", and doing nothing at all would
  // "leave the count unchanged".
  check(
    "the re-upload adds no rows — the external id is unchanged, so it conflicts",
    after.length === 2,
    `got ${after.length}`
  );
  check(
    "and it writes direction onto the rows that had none",
    after.find((r) => r.externalId === "li-msg:conv-1:a")?.direction === "out" &&
      after.find((r) => r.externalId === "li-msg:conv-1:b")?.direction === "in"
  );

  console.log("\nA stale queued job replayed after a good re-upload…");
  await runJob(await seedJob([thread("absent")]));
  const [{ known }] = await db
    .select({ known: count() })
    .from(interactions)
    .where(and(eq(interactions.userId, USER), isNotNull(interactions.direction)));
  check(
    "cannot clobber the direction already established",
    Number(known) === 2,
    `${known} of 2 rows still directed`
  );
}

run(async () => {
  parseChecks();
  await writeChecks();
  await reset();
  console.log("\nAll LinkedIn direction checks passed.");
});
