/**
 * Picking Granola notes from the Notes library, against a throwaway PGlite with the model
 * stubbed: which notes count as already taken, the runner's split (people already in Orbit
 * saved at once, new people left for review), the reviewed save logged as Granola's, and the
 * automatic sync standing still while auto-extract is off.
 */
import "./smoke/_env";

import { randomUUID } from "node:crypto";
import { and, eq, like } from "drizzle-orm";
import { getDb } from "../src/db";
import { captureJobs, connectorConnections, contacts, interactions, noteBatches } from "../src/db/schema";
import { createCaptureJob, getCaptureJobById, mergeCaptureBatchRows } from "../src/lib/capture-jobs";
import { buildSaveInput, runCaptureJobById } from "../src/lib/capture-job-runner";
import { syncGranola, takenGranolaNotes } from "../src/lib/connectors/granola";
import { granolaJobHints } from "../src/lib/connectors/granola-save";
import { upsertConnectorConnection } from "../src/lib/connectors/connections";
import { ensureUserSettings } from "../src/lib/user-settings";
import type { CaptureParseResult } from "../src/lib/capture/types";
import { checker } from "./smoke/check";

const t = checker();
const USER = `smoke-granola-pick-${randomUUID()}`;
const MEETING_AT = "2026-10-30T16:00:00.000-04:00";

/** A parse naming these people; anyone in `existing` is offered as a confident merge. */
function parsed(text: string, names: string[], existing: Map<string, string>, reminders = 0): CaptureParseResult {
  return {
    items: names.map((name, i) => ({
      key: `p${i}`,
      notes: text,
      parsed: {
        name, company: null, role: null, presence: "participant", location: null, email: null,
        linkedin_url: null, met_at: null, topics: [], action_items: [],
        follow_up_recommendation: null, follow_up_days: 14, relationship_score_suggestion: 3,
        relevance: 3, tags: [], summary: `Met ${name}`, key_facts: [], opportunities: [],
        implied_next_steps: [], shared_interests: [], suggested_next_message: null,
        confidence: null, interaction_date: "2026-10-30", low_confidence_fields: [],
      },
      opportunities: [], impliedSteps: [], cadence: null,
      duplicates: existing.has(name)
        ? [{ id: existing.get(name)!, fullName: name, company: null, title: null, reason: "Same email", confidence: 0.95 }]
        : [],
      suggestedMergeId: existing.get(name) ?? null,
      sharedNoteTexts: [],
      interactionDate: "2026-10-30", interactionType: "meeting",
    })) as unknown as CaptureParseResult["items"],
    sharedNotes: [], interactionDate: "2026-10-30", interactionType: "meeting",
    anchorIso: "2026-10-30", anchorBasis: "hint", hints: {}, sourceText: text,
    sourceHash: "", suggestedReminders: Array.from({ length: reminders }, (_, i) => ({
      key: `r${i}`, title: "Send the deck", description: null, rawDatePhrase: "next week",
      dueDateIso: "2099-01-01", yearInferred: false, personName: null, actionKind: "task",
      confidenceScore: 90, sourceExcerpt: "…", dateBasis: "absolute", anchorIso: "2026-10-30",
      origin: "explicit", rationale: null,
    })),
    suggestionsSkipped: { relative: 0, unverifiable: 0, past: 0 },
    mentions: [], mentionedOnly: [],
  } as unknown as CaptureParseResult;
}

async function pickJob(noteId: string, text: string) {
  return createCaptureJob(USER, {
    sourceKind: "granola",
    status: "queued",
    inputText: text,
    inputHints: granolaJobHints({ eventDate: "2026-10-30", interactionType: "meeting", granola: { noteId, meetingAt: MEETING_AT } }),
    sourceLabel: "Picked note",
  });
}

async function main() {
  const db = await getDb();
  await ensureUserSettings(USER);
  const [priya] = await db.insert(contacts).values({ userId: USER, fullName: "Priya Raman" }).returning();
  const existing = new Map([["Priya Raman", priya!.id]]);
  const run = (id: string, names: string[], reminders = 0) =>
    runCaptureJobById(id, {
      enrich: false,
      parse: async (_u, corpus) => ({ ...parsed(corpus, names, existing, reminders), sourceText: corpus, sourceHash: `h-${id}` }),
    });

  // --- which notes are taken ---------------------------------------------------------------
  await db.insert(interactions).values({ userId: USER, contactId: priya!.id, externalId: `granola:n-logged:${priya!.id}`, source: "granola" });
  await pickJob("n-open", "Meeting: open");
  const gone = await pickJob("n-gone", "Meeting: gone");
  await db.update(captureJobs).set({ status: "discarded" }).where(eq(captureJobs.id, gone.id));
  const taken = await takenGranolaNotes(USER, ["n-logged", "n-open", "n-gone", "n-fresh"]);
  t.check("a note already logged on someone is taken", taken.has("n-logged"));
  t.check("a note picked and still in the queue is taken", taken.has("n-open"));
  t.check("a discarded pick can be picked again", !taken.has("n-gone"));
  t.check("an untouched note is pickable", !taken.has("n-fresh"));
  t.check("nothing asked, nothing taken", (await takenGranolaNotes(USER, [])).size === 0);

  // --- the split: Priya is in Orbit, Marco is new ------------------------------------------
  const mixedText = "Meeting: Sync\n\nPriya Raman and Marco Bellini talked roadmap.";
  const mixed = await pickJob("n-mixed", mixedText);
  const afterMixed = await run(mixed.id, ["Priya Raman", "Marco Bellini"]);
  t.check("a note with someone new waits for review", afterMixed?.status === "ready", String(afterMixed?.status));
  t.check(
    "only the new person is left on the review",
    afterMixed?.result?.items.map((i) => i.parsed.name).join(",") === "Marco Bellini",
    JSON.stringify(afterMixed?.result?.items.map((i) => i.parsed.name)),
  );
  const [priyaLog] = await db
    .select()
    .from(interactions)
    .where(and(eq(interactions.userId, USER), eq(interactions.externalId, `granola:n-mixed:${priya!.id}`)));
  t.check("the person already in Orbit is updated right away", Boolean(priyaLog));
  t.check("logged as Granola's", priyaLog?.source === "granola", String(priyaLog?.source));
  t.check(
    "at the meeting's real time, not noon",
    priyaLog?.interactionDate.toISOString() === "2026-10-30T20:00:00.000Z",
    priyaLog?.interactionDate.toISOString(),
  );
  const marcoRows = await db.select().from(contacts).where(and(eq(contacts.userId, USER), eq(contacts.fullName, "Marco Bellini")));
  t.check("the new person is not created before review", marcoRows.length === 0);

  // The reviewed save is Granola's too, so the sync never logs it again.
  const row = await getCaptureJobById(mixed.id);
  // What the reviewer does: accept Marco's card.
  const input = await buildSaveInput({
    ...row!,
    decisions: {
      people: {
        p1: { decision: "accept", index: 0, mergeContactId: null, relationshipScore: 3, tagNames: [], decidedAt: new Date().toISOString() },
      },
      reminders: { checked: [], overrides: {} },
    },
  });
  t.check("the review save is logged as Granola's", input.participants.every((p) => p.interactionSource === "granola"));
  t.check("under the note's own id", input.participants.every((p) => p.externalIdBase === "granola:n-mixed"));
  t.check(
    "at the meeting's real time",
    input.participants.length > 0 && input.participants.every((p) => p.interactionDate === MEETING_AT),
    JSON.stringify(input.participants.map((p) => p.interactionDate)),
  );
  t.check("the direct save didn't take the job's batch hash", !(await db.select().from(noteBatches).where(and(eq(noteBatches.userId, USER), eq(noteBatches.sourceHash, `h-${mixed.id}`)))).length);

  // --- two notes picked together, reviewed as one deck ---------------------------------------
  // "Review everyone" folds a pick's jobs into one new job (`mergeCaptureBatchRows`) that has
  // none of their hints — the live bug: those saves landed at noon, as plain captures.
  const batch = randomUUID();
  const pickInBatch = (noteId: string, text: string, meetingAt: string) =>
    createCaptureJob(USER, {
      sourceKind: "granola",
      status: "queued",
      inputText: text,
      inputHints: granolaJobHints({ granola: { noteId, meetingAt } }),
      batchGroupId: batch,
      sourceLabel: noteId,
    });
  const one = await pickInBatch("n-b1", "Meeting: One\n\nCoffee with Lena Okafor.", "2026-10-30T15:30:00.000-04:00");
  const two = await pickInBatch("n-b2", "Meeting: Two\n\nLunch with Omar Haddad.", "2026-10-27T15:33:00.000-04:00");
  await run(one.id, ["Lena Okafor"]);
  await run(two.id, ["Omar Haddad"]);
  const combined = await mergeCaptureBatchRows(USER, batch);
  t.check("the two picks fold into one review", Boolean(combined) && combined!.result!.items.length === 2);
  const combinedInput = await buildSaveInput({
    ...combined!,
    decisions: {
      people: Object.fromEntries(
        combined!.result!.items.map((item, index) => [
          item.key,
          { decision: "accept", index, mergeContactId: null, relationshipScore: 3, tagNames: [], decidedAt: new Date().toISOString() },
        ]),
      ),
      reminders: { checked: [], overrides: {} },
    },
  });
  const byName = new Map(combinedInput.participants.map((p) => [p.parsed.name, p]));
  t.check(
    "each person keeps their own note's id",
    byName.get("Lena Okafor")?.externalIdBase === "granola:n-b1" && byName.get("Omar Haddad")?.externalIdBase === "granola:n-b2",
    JSON.stringify([...byName.values()].map((p) => p.externalIdBase)),
  );
  t.check(
    "and their own meeting's real time",
    byName.get("Lena Okafor")?.interactionDate === "2026-10-30T15:30:00.000-04:00" &&
      byName.get("Omar Haddad")?.interactionDate === "2026-10-27T15:33:00.000-04:00",
  );
  t.check("logged as Granola's", combinedInput.participants.every((p) => p.interactionSource === "granola"));

  // --- everyone already in Orbit: nothing to review ------------------------------------------
  const known = await pickJob("n-known", "Meeting: Catch-up\n\nQuick catch-up with Priya Raman.");
  const afterKnown = await run(known.id, ["Priya Raman"]);
  t.check("a note with only known people settles as saved", afterKnown?.status === "saved", String(afterKnown?.status));
  t.check("and points at the batch it wrote", Boolean(afterKnown?.noteBatchId));

  // A dated commitment still needs a look, even when everyone is known.
  const dated = await pickJob("n-dated", "Meeting: Deck\n\nPriya Raman sends the deck next week.");
  const afterDated = await run(dated.id, ["Priya Raman"], 1);
  t.check("a commitment keeps the note in review", afterDated?.status === "ready", String(afterDated?.status));
  t.check("with nobody left to decide on", afterDated?.result?.items.length === 0);

  // --- auto-extract off: the sync stands still ------------------------------------------------
  const { id: connId } = await upsertConnectorConnection({
    userId: USER,
    connectorId: "granola",
    authKind: "oauth2",
    accessToken: "not-a-real-token",
    capabilities: [],
    syncCursor: { syncedThrough: "2026-10-01T00:00:00.000Z" },
  });
  await syncGranola(connId); // would throw on the fake token if it called Granola
  const [conn] = await db.select().from(connectorConnections).where(eq(connectorConnections.id, connId));
  t.check("off: the pass completes without calling Granola", conn?.syncStatus === "idle" && Boolean(conn?.lastSyncedAt), String(conn?.syncStatus));
  t.check("off: the watermark stays put", conn?.syncCursor?.syncedThrough === "2026-10-01T00:00:00.000Z", JSON.stringify(conn?.syncCursor));

  // Clean up everything this user wrote.
  await db.delete(interactions).where(eq(interactions.userId, USER));
  await db.delete(captureJobs).where(eq(captureJobs.userId, USER));
  await db.delete(noteBatches).where(eq(noteBatches.userId, USER));
  await db.delete(connectorConnections).where(eq(connectorConnections.userId, USER));
  await db.delete(contacts).where(like(contacts.userId, `${USER}%`));
  t.done("granola pick smoke tests");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
