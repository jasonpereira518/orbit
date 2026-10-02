/**
 * Web-search work history: what a LinkedIn pull stores, and what it refuses to.
 *
 * Runs `researchContactWorkHistory` against PGlite with a fake researcher — no AI key, no
 * network — so it pins the rules that keep a stranger's career off a contact: only a
 * "confident" answer is saved, an extension capture is never overwritten, a recent web
 * history is not searched again, and a model's malformed entries are cleaned first.
 *
 * Run: npx tsx scripts/smoke-work-history-research.ts
 */
import "./smoke/_env";

import { eq, like } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, rateLimitBuckets } from "../src/db/schema";
import { anthropicWebSearchToolType } from "../src/lib/ai";
import { aiOperationThinking, aiOperationTier } from "../src/lib/ai-operations";
import { getContactProfile, saveContactProfile, type IncomingExperience } from "../src/lib/contact-profile";
import {
  contactsNeedingWorkHistory,
  linkedInCaptureContactIds,
  researchContactWorkHistory,
  researchWorkHistories,
  WORK_HISTORY_REFRESH_DAYS,
  type WorkHistoryAnswer,
  type WorkHistoryResearcher,
  type WorkHistorySubject,
} from "../src/lib/work-history-research";

const USER = "smoke-work-history-user";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function reset() {
  const db = await getDb();
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(rateLimitBuckets).where(like(rateLimitBuckets.bucket, `%${USER}%`));
}

async function makeContact(fullName: string, linkedinUrl: string | null) {
  const db = await getDb();
  const [row] = await db
    .insert(contacts)
    .values({ userId: USER, fullName, linkedinUrl, company: "Stripe", title: "PM" })
    .returning();
  return row.id;
}

function role(organization: string, extra: Partial<IncomingExperience> = {}): IncomingExperience {
  return {
    kind: "role",
    organization,
    title: "PM",
    fieldOfStudy: null,
    location: null,
    description: null,
    startYear: 2020,
    startMonth: 1,
    endYear: null,
    endMonth: null,
    isCurrent: false,
    ...extra,
  };
}

/** A researcher that answers `answer` and records who it was asked about. */
function fake(answer: Partial<WorkHistoryAnswer>) {
  const asked: WorkHistorySubject[] = [];
  const researcher: WorkHistoryResearcher = async (_userId, subject) => {
    asked.push(subject);
    return { experiences: [], headline: null, confident: true, sources: [], ...answer };
  };
  return { researcher, asked };
}

async function main() {
  await reset();

  // --- a confident answer is stored as a "web" profile ------------------------------
  const priya = await makeContact("Priya Rao", "https://www.linkedin.com/in/priya-rao");
  const confident = fake({
    headline: "Staff PM at Stripe",
    experiences: [
      role("Google", { startYear: 2016, endYear: 2020, startMonth: 13 }),
      role("Stripe", { startYear: 2020, isCurrent: true }),
      { ...role("MIT"), kind: "education", title: "BS", isCurrent: true },
    ],
  });
  const saved = await researchContactWorkHistory(USER, priya, { researcher: confident.researcher });
  check("a confident answer is saved", saved === "saved", saved);
  const stored = await getContactProfile(USER, priya);
  check("stored as a web profile", stored?.source === "web", String(stored?.source));
  check("every entry is kept", stored?.experiences.length === 3, String(stored?.experiences.length));
  check("the current role is listed first", stored?.experiences[0]?.organization === "Stripe");
  check("the headline is kept", stored?.headline === "Staff PM at Stripe");
  check(
    "the LinkedIn URL is the search's anchor",
    confident.asked[0]?.linkedinUrl === "https://www.linkedin.com/in/priya-rao"
  );
  check("the profile's source URL is the LinkedIn URL", stored?.sourceUrl === "https://www.linkedin.com/in/priya-rao");

  // --- a recent web history is not searched again; a forced search is ----------------
  const again = fake({ experiences: [role("Ramp", { isCurrent: true })] });
  const fresh = await researchContactWorkHistory(USER, priya, { researcher: again.researcher });
  check("a recent web history is not searched again", fresh === "fresh" && again.asked.length === 0, fresh);
  const forced = await researchContactWorkHistory(USER, priya, { researcher: again.researcher, force: true });
  check("a forced search replaces it", forced === "saved" && again.asked.length === 1, forced);
  check(
    "the replacement is the whole history, not a union",
    (await getContactProfile(USER, priya))?.experiences.map((e) => e.organization).join() === "Ramp"
  );
  const later = new Date(Date.now() + (WORK_HISTORY_REFRESH_DAYS + 1) * 86_400_000);
  const stale = fake({ experiences: [role("Ramp", { isCurrent: true })] });
  // Past the freshness window it is due again — via the cheap re-check, which here reports
  // a different employer and so escalates to the full search.
  await researchContactWorkHistory(USER, priya, {
    researcher: stale.researcher,
    checker: async () => ({ confident: true, current: { organization: "Figma", title: "PM" } }),
    now: later,
  });
  check("an old web history is searched again", stale.asked.length === 1);

  // --- anything short of "confident" writes nothing -------------------------------------
  const namesake = await makeContact("John Smith", "https://www.linkedin.com/in/john-smith-42");
  const unsure = await researchContactWorkHistory(USER, namesake, {
    researcher: fake({ confident: false, experiences: [role("Somewhere")] }).researcher,
  });
  check("an unsure answer is not saved", unsure === "unsure", unsure);
  check("an unsure answer leaves no profile", (await getContactProfile(USER, namesake)) === null);
  const none = await researchContactWorkHistory(USER, namesake, {
    researcher: fake({ confident: true, experiences: [] }).researcher,
  });
  check("an empty answer is not_found", none === "not_found", none);

  // --- an empty answer never wipes a stored career --------------------------------------
  const wipe = await researchContactWorkHistory(USER, priya, {
    researcher: fake({ confident: true, experiences: [] }).researcher,
    force: true,
  });
  check("an empty forced search reports not_found", wipe === "not_found", wipe);
  check("…and the stored history survives", ((await getContactProfile(USER, priya))?.experiences.length ?? 0) > 0);

  // --- an extension capture is never overwritten ----------------------------------------
  const captured = await makeContact("Ada Lovelace", "https://www.linkedin.com/in/ada");
  await saveContactProfile(USER, captured, {
    source: "extension",
    sourceUrl: "https://www.linkedin.com/in/ada",
    adapterVersion: "test",
    capturedAt: new Date(),
    warnings: [],
    headline: null,
    about: null,
    skills: [],
    certifications: [],
    volunteering: [],
    publications: [],
    experiences: [role("Analytical Engines Ltd", { isCurrent: true })],
  });
  const ext = fake({ experiences: [role("Wrong Co")] });
  const outranked = await researchContactWorkHistory(USER, captured, { researcher: ext.researcher, force: true });
  check("an extension capture is never searched over", outranked === "outranked" && ext.asked.length === 0, outranked);

  // --- no LinkedIn URL, no search -------------------------------------------------------
  const noUrl = await makeContact("No Url", null);
  const unanchored = fake({ experiences: [role("Anything")] });
  const noAnchor = await researchContactWorkHistory(USER, noUrl, { researcher: unanchored.researcher });
  check("a contact with no LinkedIn URL is not searched", noAnchor === "no_anchor" && unanchored.asked.length === 0);

  // --- a researcher failure is a value, not a throw -------------------------------------
  const brokenContact = await makeContact("Broken Search", "https://www.linkedin.com/in/broken");
  const broken = await researchContactWorkHistory(USER, brokenContact, {
    researcher: async () => {
      throw new Error("provider down");
    },
  });
  check("a failed search returns error instead of throwing", broken === "error", broken);

  // --- which contacts a pull hands to the route ---------------------------------------
  const due = await contactsNeedingWorkHistory(USER, [priya, namesake, captured, noUrl, brokenContact]);
  check(
    "only contacts with a URL and no settled history are due",
    due.sort().join() === [namesake, brokenContact].sort().join(),
    JSON.stringify(due)
  );

  // --- the batch runner -----------------------------------------------------------------
  const batch = fake({ experiences: [role("Figma", { isCurrent: true })] });
  const { saved: batchSaved } = await researchWorkHistories(USER, [namesake, brokenContact, namesake], {
    researcher: batch.researcher,
  });
  check("the batch saves each due contact once", batchSaved.length === 2 && batch.asked.length === 2, JSON.stringify(batchSaved));
  const late = fake({ experiences: [role("Figma")] });
  await researchWorkHistories(USER, [namesake], { researcher: late.researcher, deadline: Date.now() - 1 });
  check("a passed deadline starts nobody", late.asked.length === 0);

  // --- capture: only cards that carried a LinkedIn URL -----------------------------------
  const picked = linkedInCaptureContactIds(
    [
      { parsed: { linkedin_url: "https://www.linkedin.com/in/a" } },
      { parsed: { linkedin_url: null } },
      { parsed: { linkedin_url: "  " } },
      { parsed: { linkedin_url: "https://www.linkedin.com/in/d" } },
    ],
    ["c1", "c2", "c3", "c4"]
  );
  check("capture researches only the LinkedIn-linked cards", picked.join() === "c1,c4", picked.join());

  // --- the cheap re-check: one question before the full history ---------------------------
  await reset();
  const recheckAt = new Date(Date.now() + (WORK_HISTORY_REFRESH_DAYS + 5) * 86_400_000);
  const rechecked = await makeContact("Recheck Rao", "https://www.linkedin.com/in/recheck-rao");
  await researchContactWorkHistory(USER, rechecked, {
    researcher: fake({ experiences: [role("Stripe", { isCurrent: true, title: "PM" })] }).researcher,
  });
  const checkerAsked: string[] = [];
  const checker = (current: { organization: string; title: string | null } | null, confident = true) =>
    async (_u: string, subject: WorkHistorySubject) => {
      checkerAsked.push(subject.fullName);
      return { confident, current };
    };

  const full1 = fake({ experiences: [role("Stripe", { isCurrent: true })] });
  const same = await researchContactWorkHistory(USER, rechecked, {
    researcher: full1.researcher,
    checker: checker({ organization: "Stripe, Inc.", title: "PM" }),
    now: recheckAt,
  });
  check("a re-check that confirms the current role is 'unchanged'", same === "unchanged", same);
  check("…and never runs the full history search", full1.asked.length === 0 && checkerAsked.length === 1);
  check(
    "…but records when it was checked",
    (await getContactProfile(USER, rechecked))?.capturedAt.getTime() === recheckAt.getTime()
  );

  const unclear = fake({ experiences: [role("Anything")] });
  const unsureCheck = await researchContactWorkHistory(USER, rechecked, {
    researcher: unclear.researcher,
    checker: checker({ organization: "Somewhere", title: null }, false),
    now: new Date(recheckAt.getTime() + (WORK_HISTORY_REFRESH_DAYS + 1) * 86_400_000),
  });
  check("an unclear re-check does not escalate to the full search", unsureCheck === "not_found" && unclear.asked.length === 0, unsureCheck);

  const full2 = fake({ experiences: [role("Ramp", { isCurrent: true, title: "Staff PM", startYear: 2030 }), role("Stripe", { isCurrent: false, endYear: 2030 })] });
  const moved = await researchContactWorkHistory(USER, rechecked, {
    researcher: full2.researcher,
    checker: checker({ organization: "Ramp", title: "Staff PM" }),
    now: new Date(recheckAt.getTime() + 2 * (WORK_HISTORY_REFRESH_DAYS + 1) * 86_400_000),
  });
  check("a re-check that finds a different job escalates to the full history", moved === "saved" && full2.asked.length === 1, moved);
  check(
    "…which replaces the stored history",
    (await getContactProfile(USER, rechecked))?.experiences[0]?.organization === "Ramp"
  );

  const before = checkerAsked.length;
  const forcedFull = fake({ experiences: [role("Ramp", { isCurrent: true, title: "Staff PM" })] });
  await researchContactWorkHistory(USER, rechecked, {
    researcher: forcedFull.researcher,
    checker: checker({ organization: "Ramp", title: "Staff PM" }),
    force: true,
  });
  check("the profile's button (force) skips the re-check and searches in full", forcedFull.asked.length === 1 && checkerAsked.length === before);

  // --- cost: background extraction runs on the cheap tier, thinking minimal ----------------
  check("work-history research runs on the fast tier", aiOperationTier("contact.work_history") === "fast");
  check("…with minimal thinking", aiOperationThinking("contact.work_history") === "minimal");

  // --- Anthropic's search tool version follows the model --------------------------------
  check("Opus 5.5 gets the dynamic-filtering search", anthropicWebSearchToolType("claude-opus-5-5") === "web_search_20260209");
  check("Sonnet 4.6 gets the dynamic-filtering search", anthropicWebSearchToolType("claude-sonnet-4-6") === "web_search_20260209");
  check("Haiku 4.5 gets the basic search", anthropicWebSearchToolType("claude-haiku-4-5") === "web_search_20250305");
  check("Sonnet 4.5 gets the basic search", anthropicWebSearchToolType("claude-sonnet-4-5") === "web_search_20250305");

  await reset();
  console.log("\nsmoke-work-history-research: all checks passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
