/**
 * People on an outreach campaign: what gets added, deduped, skipped, removed and readied.
 * Run: npx tsx scripts/smoke-outreach-people.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../src/db";
import * as schema from "../src/db/schema";
import {
  addProspectsForUser,
  attachBriefForUser,
  campaignKnownNamesForUser,
  ensureProspectContactForUser,
  listCampaignChoicesForUser,
  normalizeNewProspect,
  prospectExternalId,
  prospectNameKey,
  removeProspectForUser,
  setProspectEmailForUser,
  setProspectLinkedinUrlForUser,
  skipCandidateForUser,
} from "../src/lib/outreach-people";
import { MAX_CAMPAIGN_CHOICES, MAX_CAMPAIGN_PEOPLE } from "../src/lib/outreach-types";
import { purgeUserData } from "../src/lib/user-data";
import { researchPerson, type PersonResearcher } from "../src/lib/web-research";

const USER = "smoke-outreach-people-user";
const OTHER = "smoke-outreach-people-other";
const CHOICES = "smoke-outreach-people-choices";
const OPTS = { skipRevalidate: true, skipEmbedding: true, skipSummary: true, skipCloseness: true } as const;

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function rejects(fn: () => Promise<unknown>, substring?: string) {
  try {
    await fn();
    return false;
  } catch (err) {
    return !substring || (err instanceof Error && err.message.includes(substring));
  }
}

async function countRows(campaignId: string, status?: string) {
  const db = await getDb();
  const rows = await db
    .select({ id: schema.outreachProspects.id })
    .from(schema.outreachProspects)
    .where(
      and(
        eq(schema.outreachProspects.campaignId, campaignId),
        status ? eq(schema.outreachProspects.status, status) : undefined
      )
    );
  return rows.length;
}

async function prospectNamed(campaignId: string, fullName: string) {
  const db = await getDb();
  return db.query.outreachProspects.findFirst({
    where: and(eq(schema.outreachProspects.campaignId, campaignId), eq(schema.outreachProspects.fullName, fullName)),
  });
}

async function contactById(id: string | null | undefined) {
  const db = await getDb();
  return id ? db.query.contacts.findFirst({ where: eq(schema.contacts.id, id) }) : undefined;
}

async function addMessage(prospectId: string, status: string, channel = "email") {
  const db = await getDb();
  // `status` is a free text column; "queued" is not in the TS union yet.
  await db.execute(
    sql`INSERT INTO outreach_messages (prospect_id, channel, status) VALUES (${prospectId}::uuid, ${channel}, ${status})`
  );
}

async function reset() {
  for (const id of [USER, OTHER, CHOICES]) await purgeUserData(id, { keepSettings: false }).catch(() => {});
}

const CONFIDENT = {
  match: "confident",
  headline: "Director at IQVIA",
  current: { organization: "IQVIA Holdings", title: "Director, RWE" },
  location: "Durham",
  summary: "Leads real-world evidence.",
  talkingPoints: [],
  experiences: [{ kind: "role", organization: "IQVIA Holdings", title: "Director, RWE", startYear: 2021, isCurrent: true }],
};

function briefer(answer: Record<string, unknown>): PersonResearcher {
  return async () => ({ json: JSON.stringify(answer), sources: [{ url: "https://iqvia.com/team", title: "Team" }] });
}

async function normalizeSection() {
  console.log("normalize");
  check("name alone is refused", normalizeNewProspect({ fullName: "Ana Ruiz" }) === null);
  check("a 1-char or 101-char name is refused", normalizeNewProspect({ fullName: "A", company: "ZS" }) === null && normalizeNewProspect({ fullName: "A".repeat(101), company: "ZS" }) === null);
  check("not an object is refused", normalizeNewProspect("Ana Ruiz") === null && normalizeNewProspect(null) === null);
  check("placeholder email dropped", normalizeNewProspect({ fullName: "Ana Ruiz", company: "ZS", email: "a@example.com" })?.email === null);
  check("email is lowercased", normalizeNewProspect({ fullName: "Ana Ruiz", company: "ZS", email: "Ana@ZS.com" })?.email === "ana@zs.com");
  check("a malformed email becomes null", normalizeNewProspect({ fullName: "Ana Ruiz", company: "ZS", email: "Ana <a@zs.com>" })?.email === null);
  check("origin defaults to manual", normalizeNewProspect({ fullName: "Ana Ruiz", company: "ZS", origin: "weird" })?.origin === "manual");
  check("legacy is not an origin you can claim", normalizeNewProspect({ fullName: "Ana Ruiz", company: "ZS", origin: "legacy" })?.origin === "manual");
  const li = normalizeNewProspect({ fullName: "Ana Ruiz", linkedinUrl: "https://www.linkedin.com/in/ana-ruiz/" });
  check("a LinkedIn URL alone is enough", li?.linkedinUrl === "https://www.linkedin.com/in/ana-ruiz/" && li.company === null);
  check("a non-LinkedIn 'LinkedIn' link is dropped", normalizeNewProspect({ fullName: "Ana Ruiz", company: "ZS", linkedinUrl: "https://evil.example/in/ana" })?.linkedinUrl === null);
  check("only http(s) pages are kept", normalizeNewProspect({ fullName: "Ana Ruiz", company: "ZS", url: "javascript:alert(1)" })?.url === null && normalizeNewProspect({ fullName: "Ana Ruiz", company: "ZS", url: "https://zs.com/team" })?.url === "https://zs.com/team");
  const long = normalizeNewProspect({ fullName: "Ana Ruiz", company: "c".repeat(300), title: "t".repeat(300), whyMatches: "w".repeat(500) });
  check("title, company and why are bounded", long?.company?.length === 100 && long.title?.length === 120 && long.whyMatches?.length === 240);
  check("a research key must look like one", normalizeNewProspect({ fullName: "Ana Ruiz", company: "ZS", researchKey: "nope" })?.researchKey === null && normalizeNewProspect({ fullName: "Ana Ruiz", company: "ZS", researchKey: "a".repeat(64) })?.researchKey === "a".repeat(64));

  check("LinkedIn external id is the lowercased slug", prospectExternalId({ fullName: "Ana", company: null, linkedinUrl: "https://www.linkedin.com/in/AnaRuiz/" }) === "li:anaruiz");
  check("no LinkedIn falls back to the name key", prospectExternalId({ fullName: "Ana Ruiz", company: "ZS", linkedinUrl: null }) === "name:ana ruiz|zs");
  check("name key folds punctuation", prospectNameKey({ fullName: "Ana Ruiz", company: "Z.S., Inc." }) === "name:ana ruiz|z s inc" && prospectNameKey({ fullName: "Ana Ruiz", company: null }) === "name:ana ruiz|");
  check("name key keeps non-Latin names apart", prospectNameKey({ fullName: "李明", company: "ZS" }) !== prospectNameKey({ fullName: "王芳", company: "ZS" }) && prospectNameKey({ fullName: "Мария Иванова", company: "ZS" }) === "name:мария иванова|zs");
  check("name key folds accents, not letters", prospectNameKey({ fullName: "José García", company: "ZS" }) === "name:jose garcia|zs" && prospectNameKey({ fullName: "Jose Garcia", company: "ZS" }) === prospectNameKey({ fullName: "José García", company: "ZS" }));
}

/** The campaigns Find people offers: this user's, live ones only, newest activity first, 20 at most. */
async function choicesSection() {
  console.log("campaign choices");
  const db = await getDb();
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);
  await db.insert(schema.outreachCampaigns).values([
    { userId: CHOICES, name: "Newest", updatedAt: ago(1) },
    { userId: CHOICES, name: "On LinkedIn", defaultChannel: "linkedin", updatedAt: ago(2) },
    { userId: CHOICES, name: "Odd channel", defaultChannel: "sms", updatedAt: ago(3) },
    // The most recently touched of all, and still left out.
    { userId: CHOICES, name: "Shelved", status: "archived", updatedAt: ago(0) },
    { userId: OTHER, name: "Theirs too", updatedAt: ago(0) },
  ]);
  const got = await listCampaignChoicesForUser(CHOICES);
  check(
    "choices exclude other tenants and archived",
    got.map((c) => c.name).join("|") === "Newest|On LinkedIn|Odd channel",
    got.map((c) => c.name).join("|")
  );
  check("a choice is just an id, a name and a channel", got.every((c) => Object.keys(c).sort().join() === "channel,id,name" && c.id.length === 36));
  check("a LinkedIn campaign says so", got.find((c) => c.name === "On LinkedIn")?.channel === "linkedin");
  check("any other channel reads as email", got.find((c) => c.name === "Odd channel")?.channel === "email" && got.find((c) => c.name === "Newest")?.channel === "email");
  check("someone with no campaigns gets none", (await listCampaignChoicesForUser("smoke-outreach-people-nobody")).length === 0);

  await db.insert(schema.outreachCampaigns).values(
    Array.from({ length: 25 }, (_, i) => ({ userId: CHOICES, name: `Bulk ${i}`, updatedAt: ago(10 + i) }))
  );
  const capped = await listCampaignChoicesForUser(CHOICES);
  const names = capped.map((c) => c.name);
  check("20 at most", MAX_CAMPAIGN_CHOICES === 20 && capped.length === 20, `${capped.length}`);
  check("…the most recently updated ones", names[0] === "Newest" && names.includes("Bulk 16") && !names.includes("Bulk 17"), names.join("|"));
}

async function main() {
  const db = await getDb();
  await reset();
  try {
    const [camp] = await db.insert(schema.outreachCampaigns).values({ userId: USER, name: "Pharma consulting" }).returning();
    const [otherCamp] = await db.insert(schema.outreachCampaigns).values({ userId: OTHER, name: "Theirs" }).returning();
    const [fullCamp] = await db.insert(schema.outreachCampaigns).values({ userId: USER, name: "Full" }).returning();
    const [otherProspect] = await db
      .insert(schema.outreachProspects)
      .values({ campaignId: otherCamp!.id, externalId: "x", fullName: "Zed Other", company: "ZS", status: "selected" })
      .returning();
    await db.insert(schema.outreachProspects).values(
      Array.from({ length: MAX_CAMPAIGN_PEOPLE }, (_, i) => ({
        campaignId: fullCamp!.id,
        externalId: `seed-${i}`,
        fullName: `Seed ${i}`,
        company: "ZS",
        status: "selected",
      }))
    );
    const campId = camp!.id;
    const fullId = fullCamp!.id;

    await normalizeSection();
    await choicesSection();

    console.log("add");
    const r1 = await addProspectsForUser(USER, campId, [{ fullName: "Ana Ruiz", company: "ZS", origin: "find", url: "https://zs.com/team", whyMatches: "UNC MPH" }]);
    const r2 = await addProspectsForUser(USER, campId, [{ fullName: "Ana Ruiz", company: "ZS", linkedinUrl: "https://www.linkedin.com/in/anaruiz", origin: "find" }]);
    check("dedupes by name+company across identity kinds", r1.added === 1 && r2.alreadyThere === 1 && (await countRows(campId)) === 1);
    const ana = await prospectNamed(campId, "Ana Ruiz");
    const anaEnrichment = (ana?.enrichment ?? {}) as Record<string, unknown>;
    check("a new person is selected with their origin and page", ana?.status === "selected" && anaEnrichment.origin === "find" && anaEnrichment.url === "https://zs.com/team" && anaEnrichment.whyMatches === "UNC MPH");

    await db.insert(schema.contacts).values({ userId: USER, fullName: "Bo Li", company: "IQVIA", email: "bo@iqvia.com" });
    await addProspectsForUser(USER, campId, [{ fullName: "Bo Li", company: "IQVIA", origin: "manual" }]);
    const bo = await prospectNamed(campId, "Bo Li");
    check("links an existing contact", bo?.email === "bo@iqvia.com" && bo?.contactId != null);
    check("…and says where the address came from", (bo?.enrichment as Record<string, unknown>)?.emailSource === "contact");

    const mixed = await addProspectsForUser(USER, campId, [
      { fullName: "Fay Oh", company: "ZS", origin: "manual" },
      { fullName: "fay  oh", company: "zs ", origin: "manual" },
      { fullName: "Name Only" },
      "junk",
      { fullName: "Gus Ito", linkedinUrl: "https://www.linkedin.com/in/gus-ito" },
    ]);
    check("one call: dupes count once, bad rows are counted", mixed.added === 2 && mixed.alreadyThere === 1 && mixed.invalid === 2, JSON.stringify(mixed));
    const cjk = await addProspectsForUser(USER, campId, [{ fullName: "李明", company: "ZS", origin: "manual" }, { fullName: "王芳", company: "ZS", origin: "manual" }]);
    check("two non-Latin names at one company are both added", cjk.added === 2 && cjk.alreadyThere === 0, JSON.stringify(cjk));
    check("more than 10 people in a call is refused", await rejects(() => addProspectsForUser(USER, campId, Array.from({ length: 11 }, (_, i) => ({ fullName: `Many ${i}`, company: "ZS" }))), "10"));

    console.log("skip, remove, known names");
    await skipCandidateForUser(USER, campId, { fullName: "Cy Ng", company: "ZS", origin: "find" });
    check("a skipped person is stored as excluded", (await prospectNamed(campId, "Cy Ng"))?.status === "excluded");
    check("skipped names feed Find more", (await campaignKnownNamesForUser(USER, campId)).includes("Cy Ng"));
    await skipCandidateForUser(USER, campId, { fullName: "Cy Ng", company: "ZS", origin: "find" });
    check("skipping twice keeps one row", (await countRows(campId, "excluded")) === 1);
    const back = await addProspectsForUser(USER, campId, [{ fullName: "Cy Ng", company: "ZS", origin: "manual" }]);
    check("adding a skipped person flips them back to selected", back.alreadyThere === 1 && back.added === 0 && (await prospectNamed(campId, "Cy Ng"))?.status === "selected");

    await skipCandidateForUser(USER, campId, { fullName: "Dee Pak", company: "ZS", origin: "find" });
    const names = await campaignKnownNamesForUser(USER, campId);
    check("known names are newest first, selected and excluded alike", names[0] === "Dee Pak" && names.includes("Ana Ruiz") && names.indexOf("Dee Pak") < names.indexOf("Ana Ruiz"));
    check("known names stop at 60", (await campaignKnownNamesForUser(USER, fullId)).length === 60);

    const gus = await prospectNamed(campId, "Gus Ito");
    await addMessage(gus!.id, "queued");
    check("a person with a queued message cannot be removed", await rejects(() => removeProspectForUser(USER, gus!.id), "already been contacted"));
    const fay = await prospectNamed(campId, "Fay Oh");
    await addMessage(fay!.id, "generated");
    await removeProspectForUser(USER, fay!.id);
    check("a drafted-only person is removed (excluded)", (await prospectNamed(campId, "Fay Oh"))?.status === "excluded");
    const dee = await prospectNamed(campId, "Dee Pak");
    await addMessage(dee!.id, "copied");
    check("a copied message also keeps them on the list", await rejects(() => removeProspectForUser(USER, dee!.id), "already been contacted"));

    const mia = await prospectNamed(campId, "李明");
    await addMessage(mia!.id, "opened");
    check("a legacy opened message keeps them on the list", await rejects(() => removeProspectForUser(USER, mia!.id), "already been contacted"));
    const fang = await prospectNamed(campId, "王芳");
    await addMessage(fang!.id, "unsure");
    check("a may-have-sent message keeps them on the list", await rejects(() => removeProspectForUser(USER, fang!.id), "already been contacted"));
    check("…and skipping them again does the same", await rejects(() => skipCandidateForUser(USER, campId, { fullName: "李明", company: "ZS" }), "already been contacted"));

    console.log("email");
    check("a bad address is refused", await rejects(() => setProspectEmailForUser(USER, fay!.id, "not an email"), "doesn’t look right") && await rejects(() => setProspectEmailForUser(USER, fay!.id, "a@example.com"), "doesn’t look right"));
    await setProspectEmailForUser(USER, fay!.id, " Fay@ZS.com ");
    const fayNow = await prospectNamed(campId, "Fay Oh");
    check("a typed address is lowercased and marked as the user's", fayNow?.email === "fay@zs.com" && (fayNow?.enrichment as Record<string, unknown>).emailSource === "user");
    check("the rest of the enrichment survives", (fayNow?.enrichment as Record<string, unknown>).origin === "manual");
    await setProspectEmailForUser(USER, fay!.id, null);
    check("null clears the address", (await prospectNamed(campId, "Fay Oh"))?.email === null);
    await addMessage(fay!.id, "sent");
    check("no change after an email went out", await rejects(() => setProspectEmailForUser(USER, fay!.id, "fay2@zs.com")));
    check("…nor after one may have gone out", await rejects(() => setProspectEmailForUser(USER, fang!.id, "fang@zs.com"), "already been emailed"));
    await addMessage(dee!.id, "sent", "linkedin");
    await setProspectEmailForUser(USER, dee!.id, "dee@zs.com");
    check("a LinkedIn send doesn't lock the email", (await prospectNamed(campId, "Dee Pak"))?.email === "dee@zs.com");

    console.log("linkedin link");
    const FAY_LI = "https://www.linkedin.com/in/fay-oh";
    check("a company page is refused", await rejects(() => setProspectLinkedinUrlForUser(USER, fay!.id, "https://www.linkedin.com/company/zs"), "doesn’t look like a LinkedIn profile link"));
    check("another site's /in/ link is refused", await rejects(() => setProspectLinkedinUrlForUser(USER, fay!.id, "https://evil.example/in/fay-oh"), "doesn’t look like a LinkedIn profile link"));
    check("a link with a query is refused (the page tidies it first)", await rejects(() => setProspectLinkedinUrlForUser(USER, fay!.id, `${FAY_LI}?trk=x`), "doesn’t look like"));
    check("nothing was stored by the refusals", (await prospectNamed(campId, "Fay Oh"))?.linkedinUrl === null);
    const campOfFay = await setProspectLinkedinUrlForUser(USER, fay!.id, ` ${FAY_LI} `);
    const fayLi = await prospectNamed(campId, "Fay Oh");
    check("a valid link is stored, trimmed, and the campaign comes back", fayLi?.linkedinUrl === FAY_LI && campOfFay === campId);
    check("the rest of the person is untouched", fayLi?.email === null && (fayLi?.enrichment as Record<string, unknown>).origin === "manual" && fayLi?.externalId === fay!.externalId);
    await setProspectLinkedinUrlForUser(USER, fay!.id, null);
    check("null clears the link", (await prospectNamed(campId, "Fay Oh"))?.linkedinUrl === null);
    await setProspectLinkedinUrlForUser(USER, fay!.id, "  ");
    check("a blank also clears it", (await prospectNamed(campId, "Fay Oh"))?.linkedinUrl === null);
    // fay has a sent EMAIL: only a LinkedIn send keeps the link.
    await setProspectLinkedinUrlForUser(USER, fay!.id, FAY_LI);
    check("an email send doesn't lock the link", (await prospectNamed(campId, "Fay Oh"))?.linkedinUrl === FAY_LI);
    await addMessage(fang!.id, "generated", "linkedin");
    await setProspectLinkedinUrlForUser(USER, fang!.id, "https://www.linkedin.com/in/fang-wang");
    check("a LinkedIn draft doesn't lock it", (await prospectNamed(campId, "王芳"))?.linkedinUrl === "https://www.linkedin.com/in/fang-wang");
    await addMessage(mia!.id, "copied", "linkedin");
    check("a copied LinkedIn note keeps the link", await rejects(() => setProspectLinkedinUrlForUser(USER, mia!.id, "https://www.linkedin.com/in/li-ming"), "already been contacted on LinkedIn"));
    check("…and a sent one", await rejects(() => setProspectLinkedinUrlForUser(USER, dee!.id, "https://www.linkedin.com/in/dee-pak"), "already been contacted on LinkedIn"));
    check("…and the link is unchanged", (await prospectNamed(campId, "李明"))?.linkedinUrl === null);
    const opened = await prospectNamed(campId, "Ana Ruiz");
    await addMessage(opened!.id, "opened", "linkedin");
    check("…and a legacy opened one", await rejects(() => setProspectLinkedinUrlForUser(USER, opened!.id, "https://www.linkedin.com/in/ana-ruiz"), "already been contacted on LinkedIn"));

    console.log("briefs");
    const brief = await researchPerson(USER, { fullName: "Eli Ross", company: "IQVIA", linkedinUrl: "https://www.linkedin.com/in/eli-ross" }, { researcher: briefer(CONFIDENT) });
    if (!brief.ok) throw new Error(`brief failed: ${brief.message}`);
    const unsureBrief = await researchPerson(USER, { fullName: "Sam Lee", company: "Acme" }, { researcher: briefer({ ...CONFIDENT, match: "unsure" }) });
    if (!unsureBrief.ok) throw new Error(`brief failed: ${unsureBrief.message}`);
    await addProspectsForUser(USER, campId, [{ fullName: "Eli Ross", company: "IQVIA", origin: "find" }, { fullName: "Sam Lee", company: "Acme", origin: "find" }]);
    const eli = await prospectNamed(campId, "Eli Ross");
    const sam = await prospectNamed(campId, "Sam Lee");
    check("an expired or unknown brief is refused", await rejects(() => attachBriefForUser(USER, eli!.id, "f".repeat(64)), "expired"));
    await attachBriefForUser(USER, eli!.id, brief.key);
    const eliNow = await prospectNamed(campId, "Eli Ross");
    check("a confident brief is stored and fills only the empty fields", (eliNow?.enrichment as Record<string, unknown>).researchKey === brief.key && eliNow?.title === "Director, RWE" && eliNow?.company === "IQVIA" && eliNow?.linkedinUrl === "https://www.linkedin.com/in/eli-ross", JSON.stringify([eliNow?.title, eliNow?.company, eliNow?.linkedinUrl]));
    check("…and keeps the origin", (eliNow?.enrichment as Record<string, unknown>).origin === "find");
    await attachBriefForUser(USER, sam!.id, unsureBrief.key);
    const samNow = await prospectNamed(campId, "Sam Lee");
    check("an unsure brief is stored but fills nothing", (samNow?.enrichment as Record<string, unknown>).researchKey === unsureBrief.key && samNow?.title === null);

    console.log("contacts");
    const eliContact = await ensureProspectContactForUser(USER, eli!.id, OPTS);
    const eliRow = await contactById(eliContact);
    check("a confident brief saves the contact the web_research way", eliRow?.source === "web_research" && eliRow?.company === "IQVIA Holdings", `${eliRow?.source} / ${eliRow?.company}`);
    check("…and stamps it on the prospect", (await prospectNamed(campId, "Eli Ross"))?.contactId === eliContact);
    check("asking again returns the same contact", (await ensureProspectContactForUser(USER, eli!.id, OPTS)) === eliContact);

    await setProspectEmailForUser(USER, eli!.id, "eli@iqvia.com");
    const reset1 = await db.update(schema.outreachProspects).set({ contactId: null }).where(eq(schema.outreachProspects.id, eli!.id)).returning();
    const again = await ensureProspectContactForUser(USER, reset1[0]!.id, OPTS);
    check("a contact with no email gets the prospect's", again === eliContact && (await contactById(again))?.email === "eli@iqvia.com");

    const samContact = await ensureProspectContactForUser(USER, sam!.id, OPTS);
    const samRow = await contactById(samContact);
    check("an unsure brief makes a plain outreach contact", samRow?.source === "outreach" && samRow?.fullName === "Sam Lee");

    const ana2 = await prospectNamed(campId, "Ana Ruiz");
    await setProspectEmailForUser(USER, ana2!.id, "ana@zs.com");
    await db.update(schema.outreachProspects).set({ enrichment: { ...(ana2!.enrichment as object), researchKey: "e".repeat(64) } }).where(eq(schema.outreachProspects.id, ana2!.id));
    const anaContact = await ensureProspectContactForUser(USER, ana2!.id, OPTS);
    const anaRow = await contactById(anaContact);
    check("an expired brief falls through to a plain contact", anaRow?.source === "outreach" && anaRow?.email === "ana@zs.com" && anaRow?.company === "ZS", `${anaRow?.source}`);

    const boContact = await ensureProspectContactForUser(USER, bo!.id, OPTS);
    check("a linked contact is returned as is", boContact === bo!.contactId);

    // A contact Orbit already knows is used as is: blanks filled, nothing overwritten.
    await addProspectsForUser(USER, campId, [{ fullName: "Jo Kim", company: "Acme", title: "VP", origin: "manual" }]);
    const jo = await prospectNamed(campId, "Jo Kim");
    const [joContact] = await db
      .insert(schema.contacts)
      .values({ userId: USER, fullName: "Jo Kim", company: "Acme", title: "Director", source: "linkedin_import" })
      .returning();
    check("Jo was added before the contact existed", jo?.contactId === null);
    const joId = await ensureProspectContactForUser(USER, jo!.id, OPTS);
    const joNow = await contactById(joId);
    check("a contact found at send time is the one used", joId === joContact!.id && (await prospectNamed(campId, "Jo Kim"))?.contactId === joId);
    check("…and keeps its title and source", joNow?.title === "Director" && joNow?.source === "linkedin_import", `${joNow?.title} / ${joNow?.source}`);

    const [kaiContact] = await db.insert(schema.contacts).values({ userId: USER, fullName: "Kai Moss", company: "Orbitz" }).returning();
    await addProspectsForUser(USER, campId, [{ fullName: "Kai Moss", company: "Orbitz", origin: "manual" }]);
    const kai = await prospectNamed(campId, "Kai Moss");
    check("Kai is linked at add time, with no email to borrow", kai?.contactId === kaiContact!.id && kai?.email === null);
    await setProspectEmailForUser(USER, kai!.id, "kai@orbitz.org");
    check("a linked contact with no email gains the typed one", (await ensureProspectContactForUser(USER, kai!.id, OPTS)) === kaiContact!.id && (await contactById(kaiContact!.id))?.email === "kai@orbitz.org");

    await setProspectEmailForUser(USER, bo!.id, "bo.li@other.org");
    await ensureProspectContactForUser(USER, bo!.id, OPTS);
    check("a linked contact's own email is never overwritten", (await contactById(bo!.contactId))?.email === "bo@iqvia.com");

    console.log("tenancy and the cap");
    check("other tenant's campaign refused", await rejects(() => addProspectsForUser(USER, otherCamp!.id, [{ fullName: "Di Ho", company: "ZS", origin: "manual" }]), "isn’t yours"));
    check("…and for skipping", await rejects(() => skipCandidateForUser(USER, otherCamp!.id, { fullName: "Di Ho", company: "ZS" }), "isn’t yours"));
    check("other tenant's prospect refused", await rejects(() => setProspectEmailForUser(USER, otherProspect!.id, "x@y.org")));
    check("…for a LinkedIn link", await rejects(() => setProspectLinkedinUrlForUser(USER, otherProspect!.id, "https://www.linkedin.com/in/zed-other")));
    check("…and it stored nothing", (await prospectNamed(otherCamp!.id, "Zed Other"))?.linkedinUrl === null);
    check("…for remove", await rejects(() => removeProspectForUser(USER, otherProspect!.id)));
    check("…for a brief", await rejects(() => attachBriefForUser(USER, otherProspect!.id, brief.key)));
    check("…for a contact", await rejects(() => ensureProspectContactForUser(USER, otherProspect!.id, OPTS)));
    check("…and their names stay theirs", (await campaignKnownNamesForUser(USER, otherCamp!.id)).length === 0);
    check("nothing leaked into their campaign", (await countRows(otherCamp!.id)) === 1 && (await prospectNamed(otherCamp!.id, "Zed Other"))?.email === null);

    check("100-person cap", await rejects(() => addProspectsForUser(USER, fullId, [{ fullName: "Ed Fu", company: "ZS", origin: "manual" }]), "up to 100"));
    const there = await addProspectsForUser(USER, fullId, [{ fullName: "Seed 3", company: "ZS", origin: "manual" }]);
    check("someone already on a full campaign isn't a cap error", there.alreadyThere === 1 && there.added === 0);
    await db.update(schema.outreachProspects).set({ status: "excluded" }).where(and(eq(schema.outreachProspects.campaignId, fullId), eq(schema.outreachProspects.fullName, "Seed 0")));
    const room = await addProspectsForUser(USER, fullId, [{ fullName: "Ed Fu", company: "ZS", origin: "manual" }]);
    check("an excluded row frees a slot", room.added === 1 && (await countRows(fullId, "selected")) === MAX_CAMPAIGN_PEOPLE);
  } finally {
    await reset();
  }
  if (failures) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll outreach-people checks passed.");
}

run(main);
