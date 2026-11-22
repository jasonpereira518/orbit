/**
 * Review-card quality: who gets a card, who it is matched to, and what the web fills in.
 *
 * - the user is never a card (by name, "me", email or LinkedIn) unless the card clearly is
 *   someone else with their first name
 * - a company or team the model filed as a person is dropped
 * - one person mentioned twice is one card ("Sarah" + "Sarah Chen")
 * - "Mike" / "Mike Torres" / "Jose" find Michael Torres / José, offered below the merge bar
 * - a save never shrinks a name, and a "new" card whose email is a contact's updates them
 * - the web lookup fills EMPTY fields from a confident answer only, and stops on refusal
 *
 * Run: npx tsx scripts/smoke-capture-review-quality.ts
 */
import "./smoke/_env";

import { eq, like } from "drizzle-orm";
import { getDb } from "../src/db";
import { aiResultCache, contacts, noteBatches, rateLimitBuckets, userSettings } from "../src/db/schema";
import { collapseSamePeople } from "../src/lib/capture/person-cleanup";
import { isPersonName } from "../src/lib/names/classify";
import type { BulkNotePersonPreview } from "../src/lib/capture/types";
import { fillFromDossier, lookUpNewPeople, wouldCreate } from "../src/lib/capture/web-lookup";
import { createContactForUser } from "../src/lib/contact-writes";
import { DUPLICATE_MERGE_CONFIDENCE, findLooseNameCandidates, type LooseNameSubject } from "../src/lib/duplicates";
import { isSelf } from "../src/lib/meeting-digest";
import { saveNoteBatch, type SaveNoteBatchInput } from "../src/lib/note-batch-save";
import { shouldReplaceName } from "../src/lib/names/compare";
import { RateLimitedError } from "../src/lib/rate-limit";
import { hashSourceNote } from "../src/lib/suggested-reminder-utils";
import { ensureUserSettings } from "../src/lib/user-settings";
import { normalizePersonSubject, type PersonResearcher, type PersonSubject } from "../src/lib/web-research";

const USER = "smoke-capture-review-quality-user";
const OPTS = { skipRevalidate: true, skipEmbedding: true, skipSummary: true, skipCloseness: true } as const;

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

// ── who gets a card ───────────────────────────────────────────────────────────────────

function selfChecks() {
  console.log("self");
  const me = { firstName: "Jason", lastName: "Pereira", email: "jason@example.com", linkedinUrl: "https://linkedin.com/in/jasonp" };
  check("full name is self", isSelf("Jason Pereira", me));
  check("'me' is self", isSelf("Me", me));
  check("accents and case fold", isSelf("JASÓN pereira", { ...me, firstName: "Jasón" }));
  check("own email is self, whatever the name", isSelf("J.", me, { email: "Jason@example.com" }));
  check("own LinkedIn is self", isSelf("JP", me, { linkedinUrl: "https://www.linkedin.com/in/JasonP/" }));
  check("bare first name is self", isSelf("Jason", me));
  check("first name + someone else's email is not", !isSelf("Jason", me, { email: "jason@stripe.com" }));
  check("first name + a company is not ('Jason from Stripe')", !isSelf("Jason", me, { company: "Stripe" }));
  check("someone else is not", !isSelf("Priya Raman", me));
}

function orgChecks() {
  console.log("organizations");
  for (const name of ["Acme Labs", "Sequoia Capital", "University of Michigan", "Growth Team", "IBM", "Y Combinator 2024", "Smith & Co"]) {
    check(`"${name}" is not a person`, !isPersonName(name));
  }
  check("a name equal to its own company is not a person", !isPersonName("Stripe", { company: "Stripe" }));
  for (const name of ["the recruiter", "jane@acme.com", "Speaker 1", "Unknown"]) {
    check(`"${name}" is not a person`, !isPersonName(name));
  }
  for (const name of ["Sarah Chen", "Ai Nakamura", "José Ruiz", "Mary-Kate O'Neil", "Priya"]) {
    check(`"${name}" is a person`, isPersonName(name, { company: "Stripe" }));
  }
}

function collapseChecks() {
  console.log("collapse");
  const one = collapseSamePeople([
    { name: "Sarah", email: null, topics: ["ml"], source_excerpt: "Sarah said hi" },
    { name: "Sarah Chen", email: "sarah@stripe.com", topics: ["payments"], source_excerpt: "Sarah Chen runs PM" },
    { name: "Dev Patel", email: null, topics: [] as string[], source_excerpt: "Dev" },
  ]);
  check("Sarah + Sarah Chen collapse to one", one.length === 2, JSON.stringify(one.map((p) => p.name)));
  const sarah = one.find((p) => p.name === "Sarah Chen");
  check("  keeps the fuller name and the email", Boolean(sarah && sarah.email === "sarah@stripe.com"));
  check("  unions the lists", JSON.stringify([...(sarah?.topics ?? [])].sort()) === JSON.stringify(["ml", "payments"]));
  check("  keeps both excerpts", Boolean(sarah?.source_excerpt.includes("Sarah said hi") && sarah.source_excerpt.includes("runs PM")));

  const byEmail = collapseSamePeople([
    { name: "S. Chen", email: "sarah@stripe.com" },
    { name: "Sarah Chen", email: "SARAH@stripe.com" },
  ]);
  check("same email collapses despite different spellings", byEmail.length === 1);

  const ambiguous = collapseSamePeople([{ name: "Sarah" }, { name: "Sarah Chen" }, { name: "Sarah Lee" }]);
  check("a bare first name with two candidates stays apart", ambiguous.length === 3);

  const twoAccents = collapseSamePeople([{ name: "José Ruiz" }, { name: "jose ruiz" }]);
  check("accent/case variants collapse", twoAccents.length === 1);
}

// ── matching existing contacts ────────────────────────────────────────────────────────

function looseMatchChecks() {
  console.log("loose matching");
  const existing: LooseNameSubject[] = [
    { id: "michael", fullName: "Michael Torres", email: null, linkedinUrl: null, xHandle: null, company: "Ramp", title: null },
    { id: "jose", fullName: "José Ruiz", email: null, linkedinUrl: null, xHandle: null, company: "Figma", title: null },
    { id: "sarah-a", fullName: "Sarah Chen", email: null, linkedinUrl: null, xHandle: null, company: "Stripe", title: null, lastInteractionAt: new Date("2026-01-01") },
    { id: "sarah-b", fullName: "Sarah Lee", email: null, linkedinUrl: null, xHandle: null, company: null, title: null, lastInteractionAt: new Date("2026-10-01") },
    { id: "kat", fullName: "Katherine Wu", preferredName: "Kit", email: null, linkedinUrl: null, xHandle: null, company: null, title: null },
  ];
  const mike = findLooseNameCandidates(existing, { fullName: "Mike" });
  check("'Mike' finds Michael Torres at 0.70", mike[0]?.contact.id === "michael" && mike[0].confidence === 0.7, JSON.stringify(mike));
  check("  below the merge bar", mike[0]!.confidence < DUPLICATE_MERGE_CONFIDENCE);
  const mikeT = findLooseNameCandidates(existing, { fullName: "Mike Torres" });
  check("'Mike Torres' finds Michael Torres", mikeT[0]?.contact.id === "michael" && mikeT[0].confidence < DUPLICATE_MERGE_CONFIDENCE);
  check("'Mike Smith' finds nobody", findLooseNameCandidates(existing, { fullName: "Mike Smith" }).length === 0);
  const jose = findLooseNameCandidates(existing, { fullName: "Jose Ruiz" });
  check("'Jose Ruiz' finds José Ruiz", jose[0]?.contact.id === "jose" && jose[0].confidence === 0.6);
  const joseCo = findLooseNameCandidates(existing, { fullName: "Jose Ruiz", company: "figma" });
  check("  with the same company it is the exact tier", joseCo[0]?.confidence === 0.9);
  const sarah = findLooseNameCandidates(existing, { fullName: "Sarah" });
  check("'Sarah' with two Sarahs lists both, most recent first", sarah.length === 2 && sarah[0]!.contact.id === "sarah-b" && sarah.every((m) => m.confidence === 0.6), JSON.stringify(sarah.map((m) => m.contact.id)));
  const sarahStripe = findLooseNameCandidates(existing, { fullName: "Sarah", company: "Stripe" });
  check("  a shared company puts its Sarah first", sarahStripe[0]?.contact.id === "sarah-a" && sarahStripe[0].confidence === 0.7);
  check("a preferred name matches ('Kit')", findLooseNameCandidates(existing, { fullName: "Kit" })[0]?.contact.id === "kat");

  check("name upgrade: Sarah → Sarah Chen", shouldReplaceName("Sarah", "Sarah Chen"));
  check("never shrinks: Sarah Chen ← Sarah", !shouldReplaceName("Sarah Chen", "Sarah"));
  check("never swaps: Michael Torres ← Mike Torres", !shouldReplaceName("Michael Torres", "Mike Torres"));
  check("replaces a handle", shouldReplaceName("sarahc92", "Sarah Chen"));
}

// ── web lookup ────────────────────────────────────────────────────────────────────────

function subjectChecks() {
  console.log("lookup subject");
  const ctx = normalizePersonSubject({ fullName: "Priya Raman", context: "PM; met at the AI mixer; Austin" });
  check("full name + note context is an anchor", ctx.ok && ctx.subject.context === "PM; met at the AI mixer; Austin");
  const first = normalizePersonSubject({ fullName: "Priya", context: "PM; met at the AI mixer" });
  check("a first name + context is still refused", !first.ok && first.reason === "no_anchor");
  const co = normalizePersonSubject({ fullName: "Priya Raman", company: "Ramp", context: "PM" });
  check("context is dropped when a company anchors (stable cache key)", co.ok && co.subject.context === undefined);
}

function parsed(name: string) {
  return {
    name, company: null as string | null, role: null as string | null, presence: "participant" as const, location: null as string | null,
    email: null as string | null, linkedin_url: null as string | null, met_at: null, topics: [], action_items: [],
    follow_up_recommendation: null, follow_up_days: null, relationship_score_suggestion: 3, relevance: null, tags: [],
    summary: null, key_facts: [], opportunities: [], implied_next_steps: [], shared_interests: [], suggested_next_message: null,
    confidence: 0.9, interaction_date: "2026-09-01", low_confidence_fields: [],
  };
}

function card(name: string, extra: Record<string, unknown> = {}, duplicates: BulkNotePersonPreview["duplicates"] = []): BulkNotePersonPreview {
  return {
    key: `0-${name}`,
    notes: "",
    parsed: { ...parsed(name), ...extra },
    opportunities: [],
    impliedSteps: [],
    cadence: null,
    duplicates,
    suggestedMergeId: null,
    sharedNoteTexts: [],
    interactionDate: null,
    interactionType: null,
  } as unknown as BulkNotePersonPreview;
}

const CONFIDENT = {
  match: "confident",
  name: "Priya Raman",
  headline: "PM at Ramp",
  current: { organization: "Ramp", title: "Product Manager" },
  location: "Austin, TX",
  summary: "PM at Ramp.",
  talkingPoints: [],
  experiences: [{ kind: "role", organization: "Ramp", title: "Product Manager", isCurrent: true, startYear: 2024 }],
};

function dossierFor(name: string) {
  return {
    ...CONFIDENT,
    kind: "person",
    subject: { fullName: name, company: "Ramp", domain: null, linkedinUrl: null },
    experiences: [],
    sources: [],
    researchedAt: "",
  } as unknown as Parameters<typeof fillFromDossier>[1];
}

async function lookupChecks() {
  console.log("lookup");
  const asked: PersonSubject[] = [];
  const researcher: PersonResearcher = async (_u, subject) => {
    asked.push(subject);
    const answer = subject.fullName === "Unsure Person" ? { match: "unsure" } : CONFIDENT;
    return { json: JSON.stringify(answer), sources: [{ url: "https://www.linkedin.com/in/priyaraman", title: "Priya Raman" }] };
  };

  const priya = card("Priya Raman", { role: "PM", location: "Austin" });
  const unsure = card("Unsure Person", { company: "Acme" });
  const known = card("Sarah Chen", {}, [{ id: "x", fullName: "Sarah Chen", company: null, title: null, reason: "Same name", confidence: 0.6 }]);
  const firstOnly = card("Bo");
  check("a card with a candidate would not create", !wouldCreate(known) && wouldCreate(priya));

  await lookUpNewPeople(USER, [priya, unsure, known, firstOnly], { researcher });
  check("only new, anchorable people were searched", asked.length === 2 && !asked.some((s) => s.fullName === "Sarah Chen" || s.fullName === "Bo"), JSON.stringify(asked.map((s) => s.fullName)));
  check("  never an email or domain", asked.every((s) => !s.domain));
  check("empty fields filled", priya.parsed.company === "Ramp" && priya.parsed.linkedin_url === "https://www.linkedin.com/in/priyaraman", JSON.stringify(priya.parsed));
  check("the note's own words win (role, location kept)", priya.parsed.role === "PM" && priya.parsed.location === "Austin");
  check("card says what came from the web", JSON.stringify(priya.web?.filled) === JSON.stringify(["company", "LinkedIn"]) && Boolean(priya.web?.key), JSON.stringify(priya.web));
  check("an unsure answer changes nothing", unsure.parsed.company === "Acme" && !unsure.web && unsure.parsed.linkedin_url === null);

  // Cached: the same card again is not a second search.
  const again = card("Priya Raman", { role: "PM", location: "Austin" });
  await lookUpNewPeople(USER, [again], { researcher });
  check("a cached brief costs no second search", asked.length === 2 && again.parsed.company === "Ramp");

  // Out of budget: the refusal stops the rest, and the cards stay as they were.
  let calls = 0;
  const refusing: PersonResearcher = async () => {
    calls += 1;
    throw new RateLimitedError("web-search", 3600);
  };
  const refused = [card("Ana Lima", { company: "Nubank" }), card("Ben Ode", { company: "Wise" }), card("Cy Park", { company: "Toss" }), card("Di Wong", { company: "Grab" })];
  await lookUpNewPeople(USER, refused, { researcher: refusing });
  check("a budget refusal leaves cards unchanged", refused.every((c) => !c.web && c.parsed.role === null));
  check("  and stops searching (at most one per worker)", calls <= 3, String(calls));

  const short = card("Priya", { company: "Ramp" });
  fillFromDossier(short, dossierFor("Priya"));
  const other = card("Bob", { company: "Ramp" });
  fillFromDossier(other, dossierFor("Bob"));
  check("a first name upgrades only to the same first name", short.parsed.name === "Priya Raman" && other.parsed.name === "Bob");
}

// ── save ──────────────────────────────────────────────────────────────────────────────

async function saveChecks() {
  console.log("save");
  const db = await getDb();
  const existing = await createContactForUser(USER, { fullName: "Sarah Chen", email: "sarah@stripe.com", company: "Stripe" }, OPTS);

  const NOTE = "Coffee with Sarah (sarah@stripe.com). Also met Dev Patel.";
  const input: SaveNoteBatchInput = {
    sourceText: NOTE,
    sourceHash: hashSourceNote(NOTE),
    anchorIso: "2026-09-01",
    anchorBasis: "note",
    entryPoint: "capture",
    participants: [
      // Headed for "new", but the email is Sarah Chen's.
      { notes: NOTE, parsed: { ...parsed("Sarah"), email: "sarah@stripe.com" }, createReminder: false, relationshipScore: 3, tagNames: [] },
      { notes: NOTE, parsed: parsed("Dev Patel"), createReminder: false, relationshipScore: 2, tagNames: [] },
    ],
    commitments: [],
    mentions: [],
    skipped: { relative: 0, unverifiable: 0, past: 0 },
  };
  const out = await saveNoteBatch(USER, input);
  check("an email that is already a contact's updates them", out.updated === 1 && out.created === 1 && out.contactIds[0] === existing.id, JSON.stringify({ u: out.updated, c: out.created }));
  const [sarah] = await db.select().from(contacts).where(eq(contacts.id, existing.id));
  check("  and her name is not shrunk to 'Sarah'", sarah?.fullName === "Sarah Chen", sarah?.fullName);
  const [dev] = await db.select().from(contacts).where(eq(contacts.id, out.contactIds[1]!));
  check("a new contact gets first/last name", dev?.firstName === "Dev" && dev.lastName === "Patel", JSON.stringify([dev?.firstName, dev?.lastName]));
  check("  and the date met", Boolean(dev?.dateMet) && new Date(dev!.dateMet!).getUTCFullYear() === 2026);
}

async function reset() {
  const db = await getDb();
  await db.delete(noteBatches).where(eq(noteBatches.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(aiResultCache).where(eq(aiResultCache.userId, USER));
  await db.delete(rateLimitBuckets).where(like(rateLimitBuckets.bucket, `%${USER}%`));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await ensureUserSettings(USER);
}

async function main() {
  selfChecks();
  orgChecks();
  collapseChecks();
  looseMatchChecks();
  subjectChecks();
  await reset();
  await lookupChecks();
  await saveChecks();
  await reset();
  console.log("\nsmoke-capture-review-quality: all checks passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
