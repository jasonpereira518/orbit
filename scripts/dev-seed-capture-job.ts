/**
 * DEV ONLY: put a ready-to-review capture job in the local PGlite for `demo-user`, so the
 * review deck can be exercised without an AI key. Refuses to run against a remote database.
 *
 * Run (dev server stopped): DATABASE_URL="" npx tsx scripts/dev-seed-capture-job.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();
if (process.env.DATABASE_URL) {
  console.error("Refusing: DATABASE_URL is set. Run with DATABASE_URL=\"\".");
  process.exit(1);
}
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "";
process.env.CLERK_SECRET_KEY = "";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { captureJobs, contacts } from "../src/db/schema";
import { hashSourceNote } from "../src/lib/suggested-reminder-utils";
import { ensureUserSettings } from "../src/lib/user-settings";
import type { CaptureJobResult } from "../src/lib/capture/types";

const USER = "demo-user";
const NOTE = `Demo day afterparty. Met Ada Lovelace (Analytical Engines, founder) — building a compiler for looms, wants an intro to our infra team next week. Grace Hopper from the Navy: COBOL veteran, strong mentor energy, said to call her before the 20th. Alan Turing was there briefly, cryptography at Bletchley, quiet but sharp. Charles Babbage came up a lot — Ada's collaborator.`;

function parsed(over: Record<string, unknown>) {
  return {
    name: null, company: null, role: null, presence: "participant" as const, location: null, email: null, linkedin_url: null, met_at: "Demo day afterparty",
    topics: ["compilers"], action_items: [], follow_up_recommendation: null, follow_up_days: null, relationship_score_suggestion: 3, relevance: 3,
    tags: [], summary: null, key_facts: [], opportunities: [], shared_interests: [], suggested_next_message: null, confidence: 0.9,
    interaction_date: "2026-09-10", low_confidence_fields: [] as string[],
    ...over,
  };
}

async function main() {
  const db = await getDb();
  await ensureUserSettings(USER);
  await db.delete(captureJobs).where(eq(captureJobs.userId, USER));
  let sarah = await db.query.contacts.findFirst({ where: eq(contacts.userId, USER) });
  if (!sarah) {
    [sarah] = await db.insert(contacts).values({ userId: USER, fullName: "Ada Lovelace", company: "Analytical Engines", title: "Founder" }).returning();
  }
  const ada = await db.query.contacts.findFirst({ where: eq(contacts.fullName, "Ada Lovelace") });
  const dupId = ada?.id ?? sarah!.id;

  const result: CaptureJobResult = {
    items: [
      { key: "0-Ada Lovelace", notes: "Met Ada Lovelace (Analytical Engines, founder) — building a compiler for looms, wants an intro to our infra team next week.", parsed: parsed({ name: "Ada Lovelace", company: "Analytical Engines", role: "Founder", summary: "Building a compiler for looms; wants an intro to the infra team next week.", action_items: ["Intro Ada to the infra team"], follow_up_recommendation: "Intro her to the infra team", follow_up_days: 7, relationship_score_suggestion: 4, relevance: 5, tags: ["founder", "compilers"], low_confidence_fields: ["role"] }), duplicates: [{ id: dupId, fullName: "Ada Lovelace", company: "Analytical Engines", title: "Founder", reason: "Same name + company", confidence: 0.9 }], suggestedMergeId: dupId, sharedNoteTexts: ["Demo day afterparty."], interactionDate: "2026-09-10", interactionType: "meeting_note" },
      { key: "1-Grace Hopper", notes: "Grace Hopper from the Navy: COBOL veteran, strong mentor energy, said to call her before the 20th.", parsed: parsed({ name: "Grace Hopper", company: "US Navy", role: "Rear Admiral", summary: "COBOL veteran with mentor energy. Said to call before the 20th.", relationship_score_suggestion: 5, relevance: 4, tags: ["mentor"], key_facts: ["Invented the compiler"], low_confidence_fields: ["company", "role"] }), duplicates: [], suggestedMergeId: null, sharedNoteTexts: ["Demo day afterparty."], interactionDate: "2026-09-10", interactionType: "meeting_note" },
      { key: "2-Alan Turing", notes: "Alan Turing was there briefly, cryptography at Bletchley, quiet but sharp.", parsed: parsed({ name: "Alan Turing", company: "Bletchley Park", role: "Cryptographer", summary: "Quiet but sharp. Brief chat about cryptography.", relationship_score_suggestion: 2, relevance: 2 }), duplicates: [], suggestedMergeId: null, sharedNoteTexts: [], interactionDate: "2026-09-10", interactionType: "meeting_note" },
    ],
    sharedNotes: [{ text: "Demo day afterparty.", person_names: ["Ada Lovelace", "Grace Hopper"], met_at: "Demo day afterparty", topics: [] }],
    interactionDate: "2026-09-10",
    interactionType: "meeting_note",
    anchorIso: "2026-09-10",
    anchorBasis: "note",
    hints: {},
    suggestedReminders: [
      { key: "0-before the 20th", title: "Call Grace Hopper", description: null, rawDatePhrase: "before the 20th", dueDateIso: "2026-09-20", yearInferred: true, personName: "Grace Hopper", actionKind: "call", confidenceScore: 85, sourceExcerpt: "said to call her before the 20th", dateBasis: "absolute", anchorIso: "2026-09-10" },
    ],
    suggestionsSkipped: { relative: 0, unverifiable: 0, past: 0 },
    mentions: [{ text: "Charles Babbage", context: "Ada's collaborator", nearPerson: "Ada Lovelace", contactId: null, confidence: 0, matchedBy: null }],
    mentionedOnly: [],
  };

  const [job] = await db
    .insert(captureJobs)
    .values({ userId: USER, sourceKind: "messy", status: "ready", inputText: NOTE, sourceText: NOTE, sourceHash: hashSourceNote(NOTE), result })
    .returning();
  console.log(`seeded capture job ${job!.id} (ready, 3 people) for ${USER}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
