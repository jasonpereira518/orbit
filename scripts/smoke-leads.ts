/**
 * The leads pipeline against a real database: saving deduplicates by every identifier,
 * statuses are the owner's alone, "Add to contacts" matches before it creates, and the
 * pipeline ranks by who on the team knows each lead.
 *
 * Rows live under `smoke-leads-*` ids and the `smoke-leads.test` team, all removed in
 * `finally`. Do NOT run while `next dev` holds `.data/pglite` — PGlite is single-writer.
 *
 * Run: npx tsx scripts/smoke-leads.ts
 */
import "./smoke/_env";

import { eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { companies, contacts, leads, teamMembers, teams, userSettings } from "../src/db/schema";
import { claimIdentities } from "../src/lib/contact-identity";
import { identityKeysFor } from "../src/lib/duplicates";
import { isUserFacingError } from "../src/lib/errors";
import { loadPipeline } from "../src/lib/leads/pipeline";
import {
  convertLeadToContact,
  getLead,
  listLeads,
  saveLead,
  setLeadStatus,
} from "../src/lib/leads/store";
import { joinTeamWithDomain } from "../src/lib/teams";
import { ensureUserSettings } from "../src/lib/user-settings";

const V = "smoke-leads-viewer";
const MATE = "smoke-leads-mate";
const OTHER = "smoke-leads-other";
const USERS = [V, MATE, OTHER];
const DOMAIN = "smoke-leads.test";
/** Outside a request there is nothing to revalidate and no provider to call. */
const WRITE = { skipRevalidate: true, skipEmbedding: true, skipSummary: true, skipCloseness: true };

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function cleanup() {
  const db = await getDb();
  await db.delete(leads).where(inArray(leads.userId, USERS));
  await db.delete(contacts).where(inArray(contacts.userId, USERS));
  await db.delete(companies).where(inArray(companies.userId, USERS));
  await db.delete(teamMembers).where(inArray(teamMembers.userId, USERS));
  await db.delete(teams).where(eq(teams.domain, DOMAIN));
  await db.delete(userSettings).where(inArray(userSettings.userId, USERS));
}

async function main() {
  const db = await getDb();
  await cleanup();
  try {
    for (const u of USERS) await ensureUserSettings(u);

    console.log("\nsaving deduplicates by every identifier");
    const first = await saveLead(V, {
      source: "manual",
      displayName: "Jane Doe",
      email: "Jane@Target.test",
      companyName: "Northwind",
    });
    check("a new lead is created, open", first.created && first.lead.status === "open");
    check(
      "its email is stored the way contact_identities stores it",
      first.lead.emailNormalized === identityKeysFor({ email: "Jane@Target.test" })[0]?.value
    );
    const again = await saveLead(V, { source: "manual", displayName: "J. Doe", email: "jane@target.test", title: "VP Sales" });
    check("the same email is the same lead", !again.created && again.lead.id === first.lead.id);
    check("a second save only fills blanks", again.lead.displayName === "Jane Doe" && again.lead.title === "VP Sales");
    const ada = await saveLead(V, { source: "manual", displayName: "Ada", linkedinUrl: "https://www.linkedin.com/in/ada-l" });
    const adaAgain = await saveLead(V, { source: "manual", displayName: "Ada L", linkedinUrl: "https://linkedin.com/in/ADA-L/" });
    check("the same LinkedIn profile is the same lead", ada.created && !adaAgain.created && adaAgain.lead.id === ada.lead.id);
    const sam = await saveLead(V, { source: "apollo", apolloId: "ap-1", displayName: "Sam Patel", companyName: "Brightpath" });
    const samAgain = await saveLead(V, { source: "apollo", apolloId: "ap-1", displayName: "Sam Patel" });
    check("the same Apollo person is the same lead", sam.created && !samAgain.created && samAgain.lead.id === sam.lead.id);
    let nameless: unknown = null;
    try {
      await saveLead(V, { source: "manual", displayName: "   " });
    } catch (err) {
      nameless = err;
    }
    check("a lead needs a name, said in words", isUserFacingError(nameless));
    const theirs = await saveLead(OTHER, { source: "manual", displayName: "Jane Doe", email: "jane@target.test" });
    check("another user's identical lead is their own row", theirs.created && theirs.lead.id !== first.lead.id);

    console.log("\nstatuses are the owner's alone");
    check("another user cannot dismiss my lead", (await setLeadStatus(OTHER, first.lead.id, "dismissed")) === false);
    check("I can", (await setLeadStatus(V, first.lead.id, "dismissed")) === true);
    const open = await listLeads(V, { statuses: ["open", "intro_requested"] });
    check("a dismissed lead leaves the open list", !open.some((l) => l.id === first.lead.id));
    const reopened = await saveLead(V, { source: "manual", displayName: "Jane Doe", email: "jane@target.test" });
    check("saving it again reopens it", reopened.lead.id === first.lead.id && reopened.lead.status === "open");

    console.log("\nthe pipeline ranks by who knows each lead");
    const before = await loadPipeline(V);
    check(
      "with no team, every lead is listed without a path",
      before.team === "no_team" && before.rows.length === 3 && before.rows.every((r) => r.path === null),
      `${before.team} ${before.rows.length}`
    );
    await joinTeamWithDomain(V, DOMAIN, { shareNetwork: true });
    await joinTeamWithDomain(MATE, DOMAIN, { shareNetwork: true });
    const [known] = await db
      .insert(contacts)
      .values({ userId: MATE, fullName: "Jane Doe", email: "jane@target.test", closenessTier: "inner", closeness: 80 })
      .returning();
    await claimIdentities(MATE, known.id, identityKeysFor({ email: "jane@target.test" }), "smoke");
    const ranked = await loadPipeline(V);
    const order = ranked.rows.map((r) => `${r.lead.displayName}:${r.path?.warmth}`).join(", ");
    check("with a sharing teammate, the pipeline is ranked", ranked.team === "ok");
    check("Jane comes first, hot", ranked.rows[0]?.lead.id === first.lead.id && ranked.rows[0]?.path?.warmth === "hot", order);
    check("everyone else is still listed, cold", ranked.rows.length === 3 && ranked.rows.slice(1).every((r) => r.path?.warmth === "cold"), order);
    check("a status filter narrows the list", (await loadPipeline(V, { statuses: ["converted"] })).rows.length === 0);

    console.log("\nadd to contacts matches before it creates");
    const [mine] = await db
      .insert(contacts)
      .values({ userId: V, fullName: "Sam Patel", email: "sam@brightpath.test" })
      .returning();
    await claimIdentities(V, mine.id, identityKeysFor({ email: "sam@brightpath.test" }), "smoke");
    const samLead = await saveLead(V, { source: "manual", displayName: "Sam P", email: "sam@brightpath.test" });
    const matched = await convertLeadToContact(V, samLead.lead.id, WRITE);
    check("a lead already in the network is matched, not duplicated", matched.contactId === mine.id, JSON.stringify(matched));
    const converted = await convertLeadToContact(V, first.lead.id, WRITE);
    const [created] = await db.select().from(contacts).where(eq(contacts.id, converted.contactId));
    check("a new person becomes a contact", converted.outcome === "created" && created?.userId === V && created.fullName === "Jane Doe");
    const after = await getLead(V, first.lead.id);
    check("the lead stays, linked and marked", after?.contactId === converted.contactId && after.status === "converted");
    const twice = await convertLeadToContact(V, first.lead.id, WRITE);
    check("converting twice returns the same contact", twice.contactId === converted.contactId && twice.outcome === "linked");
    let foreign: unknown = null;
    try {
      await convertLeadToContact(OTHER, first.lead.id, WRITE);
    } catch (err) {
      foreign = err;
    }
    check("another user cannot convert my lead", isUserFacingError(foreign));
  } finally {
    await cleanup();
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll leads store checks passed.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
