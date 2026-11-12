import "../../scripts/smoke/_env";
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_golden-note-batch";
process.env.CLERK_SECRET_KEY ||= "sk_test_golden-note-batch";

import { after, before, describe, it, mock } from "node:test";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { actionItems, contacts, interactionMentions, interactions, noteBatches, reminders } from "@/db/schema";
import { saveNoteBatch, type SaveNoteBatchInput } from "@/lib/note-batch-save";
import { hashSourceNote } from "@/lib/suggested-reminder-utils";
import { ensureUserSettings } from "@/lib/user-settings";
import { expectGolden, freezeClock, sortBy } from "@/test-support/golden";
import { fixedId, GOLDEN_USER } from "@/test-support/fixtures";

const NOTE = `Coffee with Sarah Chen (Stripe, PM). Kickoff is Sept 20. She'll intro me to Raj in two weeks.
Also met Dev Patel — wants the deck soon. Priya Raman from Notion joined for the last ten minutes.`;

function parsed(name: string, company: string | null, actions: string[], followUpDays: number | null) {
  return {
    name, company, role: null, presence: "participant" as const, location: null, email: null, linkedin_url: null, met_at: null,
    topics: ["fundraising"], action_items: actions,
    follow_up_recommendation: followUpDays ? `Follow up with ${name}` : null, follow_up_days: followUpDays,
    relationship_score_suggestion: 3, relevance: null, tags: [], summary: `Chat with ${name}`, key_facts: [], opportunities: [], implied_next_steps: [],
    shared_interests: [], suggested_next_message: null, confidence: 0.9, interaction_date: "2026-09-01",
    low_confidence_fields: [],
  };
}

const MIRA = fixedId(50);

const INPUT: SaveNoteBatchInput = {
  sourceText: NOTE,
  sourceHash: hashSourceNote(NOTE),
  anchorIso: "2026-09-01",
  anchorBasis: "note",
  entryPoint: "capture",
  participants: [
    { notes: NOTE, parsed: parsed("Sarah Chen", "Stripe", ["Send Sarah the deck"], 14), createReminder: true, relationshipScore: 3, tagNames: ["fundraising"] },
    { notes: NOTE, parsed: parsed("Dev Patel", null, [], 7), createReminder: true, relationshipScore: 2, tagNames: [] },
    { notes: NOTE, parsed: parsed("Priya Raman", "Notion", [], null), createReminder: false, relationshipScore: 4, tagNames: [] },
  ],
  commitments: [
    { title: "Kickoff", description: null, rawDatePhrase: "Sept 20", dueDateIso: "2026-09-20", yearInferred: true, personName: "Sarah Chen", actionKind: "meet", confidenceScore: 90, sourceExcerpt: "Kickoff is Sept 20.", dateBasis: "absolute", anchorIso: "2026-09-01" },
    { title: "Intro to Raj", description: null, rawDatePhrase: "in two weeks", dueDateIso: "2026-09-15", yearInferred: false, personName: "Sarah Chen", actionKind: "follow_up", confidenceScore: 80, sourceExcerpt: "She'll intro me to Raj in two weeks.", dateBasis: "relative", anchorIso: "2026-09-01" },
  ],
  mentions: [
    { text: "Raj", context: "she'll intro me to Raj", nearPerson: "Sarah Chen", contactId: null, confidence: 0, matchedBy: null },
    { text: "Mira", context: null, nearPerson: "Sarah Chen", contactId: MIRA, confidence: 0.7, matchedBy: "first_name_unique" },
  ],
  skipped: { relative: 0, unverifiable: 0, past: 0 },
};

describe("saveNoteBatch (golden)", () => {
  before(async () => {
    const db = await getDb();
    await ensureUserSettings(GOLDEN_USER);
    await db.insert(contacts).values({ id: MIRA, userId: GOLDEN_USER, fullName: "Mira Okafor", createdAt: new Date("2026-08-01T00:00:00Z") });
    freezeClock();
  });
  after(() => mock.timers.reset());

  it("pins the rows a three-person batch writes", async () => {
    const out = await saveNoteBatch(GOLDEN_USER, INPUT);
    const db = await getDb();
    const where = <T extends { userId: unknown }>(t: T) => eq(t.userId as never, GOLDEN_USER);
    const people = sortBy(await db.select().from(contacts).where(where(contacts)), (r) => r.fullName);
    // New contacts get random uuids, so every list is ordered by something human-readable.
    const nameOf = (id: string | null) => people.find((p) => p.id === id)?.fullName ?? "";
    const rows = {
      output: out,
      contacts: people,
      interactions: sortBy(await db.select().from(interactions).where(where(interactions)), (r) => nameOf(r.contactId)),
      reminders: sortBy(await db.select().from(reminders).where(where(reminders)), (r) => `${r.title}|${nameOf(r.contactId)}`),
      actionItems: await db.select().from(actionItems).where(where(actionItems)),
      mentions: sortBy(await db.select().from(interactionMentions).where(where(interactionMentions)), (r) => `${r.matchedBy}`),
      noteBatches: await db.select().from(noteBatches).where(where(noteBatches)),
    };
    expectGolden(import.meta.url, "note-batch-save", rows);
  });
});
