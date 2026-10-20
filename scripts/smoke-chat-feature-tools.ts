/**
 * The read tools added with the chat answer loop (`src/lib/tools/definitions-features.ts`),
 * each run the way chat runs it — through `runTool` on the chat surface — over a seeded
 * network: exact totals, breakdowns, the new filters, and another user's rows never counted.
 *
 * PGlite, no AI key. Run: npx tsx scripts/smoke-chat-feature-tools.ts
 */
import "./smoke/_env";

import { eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import {
  contactOpportunities,
  contacts,
  contactTags,
  emailSends,
  eventAttendees,
  events,
  imports,
  interactions,
  tags,
} from "../src/db/schema";
import { ORBIT_TOOLS } from "../src/lib/tools/definitions";
import { FEATURE_TOOLS } from "../src/lib/tools/definitions-features";
import { isToolError, runTool } from "../src/lib/tools/registry";

const USER = "smoke-chat-feature-tools-user";
const OTHER = "smoke-chat-feature-tools-other";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

async function runToolAs(name: string, args: unknown, userId: string): Promise<unknown> {
  const tool = ORBIT_TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return runTool(tool, userId, args, { surface: "chat", scopes: ["read"] });
}

async function run<T>(name: string, args: unknown, userId = USER): Promise<T> {
  const tool = ORBIT_TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  const out = await runTool(tool, userId, args, { surface: "chat", scopes: ["read"] });
  if (isToolError(out)) throw new Error(`${name}: ${out.error}`);
  return out as T;
}

type ContactsResult = {
  total: number;
  groups?: Array<{ key: string; count: number }>;
  rows: Array<{ id: string; name: string; company: string | null; added: string | null; lastInteraction: string | null }>;
};
type InteractionsResult = {
  total: number;
  groups?: Array<{ key: string; count: number; contactId?: string }>;
  rows: Array<{ id: string; date: string; type: string; contactName: string | null; summary: string | null }>;
};

async function clear() {
  const db = await getDb();
  for (const u of [USER, OTHER]) {
    await db.delete(interactions).where(eq(interactions.userId, u));
    await db.delete(eventAttendees).where(eq(eventAttendees.userId, u));
    await db.delete(events).where(eq(events.userId, u));
    await db.delete(contactOpportunities).where(eq(contactOpportunities.userId, u));
    await db.delete(emailSends).where(eq(emailSends.userId, u));
    await db.delete(imports).where(eq(imports.userId, u));
    const ids = (await db.query.contacts.findMany({ where: eq(contacts.userId, u), columns: { id: true } })).map((c) => c.id);
    if (ids.length) await db.delete(contactTags).where(inArray(contactTags.contactId, ids));
    await db.delete(contacts).where(eq(contacts.userId, u));
    await db.delete(tags).where(eq(tags.userId, u));
  }
}

async function main() {
  await clear();
  const db = await getDb();
  const day = (iso: string) => new Date(`${iso}T12:00:00Z`);

  // 10 at Stripe (3 inner), 6 at Ramp, 4 with no company; 2 added in October, the rest in June.
  const seed = [
    ...Array.from({ length: 10 }, (_, i) => ({ fullName: `Stripe ${i}`, company: "Stripe", industry: "Fintech", email: i < 7 ? `s${i}@stripe.example` : null, closenessTier: (i < 3 ? "inner" : "outer") as "inner" | "outer" })),
    ...Array.from({ length: 6 }, (_, i) => ({ fullName: `Ramp ${i}`, company: "Ramp", industry: "Fintech", email: `r${i}@ramp.example`, closenessTier: "mid" as const })),
    ...Array.from({ length: 4 }, (_, i) => ({ fullName: `Loose ${i}`, company: null, industry: null, email: null, closenessTier: null as "inner" | null })),
  ];
  const rows = await db
    .insert(contacts)
    .values(seed.map((c, i) => ({ userId: USER, ...c, createdAt: i < 2 ? day("2026-10-05") : day("2026-06-01") })))
    .returning();
  await db.insert(contacts).values({ userId: OTHER, fullName: "Their Stripe Friend", company: "Stripe" });

  const [investor] = await db.insert(tags).values({ userId: USER, name: "investor" }).returning();
  await db.insert(contactTags).values(rows.slice(0, 3).map((c) => ({ contactId: c.id, tagId: investor.id })));

  // Interactions: Stripe 0 has three coffees in March and an email in April; Ramp 0 a call in March.
  const stripe0 = rows[0];
  const ramp0 = rows[10];
  await db.insert(interactions).values([
    { userId: USER, contactId: stripe0.id, interactionType: "coffee", interactionDate: day("2026-03-03"), aiSummary: "Coffee about payments" },
    { userId: USER, contactId: stripe0.id, interactionType: "coffee", interactionDate: day("2026-03-17"), aiSummary: "Second coffee" },
    { userId: USER, contactId: stripe0.id, interactionType: "coffee", interactionDate: day("2026-03-28"), aiSummary: "Third coffee", rawNotes: "SECRET RAW NOTE" },
    { userId: USER, contactId: stripe0.id, interactionType: "email", interactionDate: day("2026-04-02"), aiSummary: "Sent the deck" },
    { userId: USER, contactId: ramp0.id, interactionType: "call", interactionDate: day("2026-03-20"), aiSummary: "Call about growth" },
  ]);

  console.log("query_contacts");
  {
    const all = await run<ContactsResult>("query_contacts", { limit: 0 });
    check("with no filters it counts the whole network, and only this user's", all.total === 20 && all.rows.length === 0, JSON.stringify(all));
    const stripe = await run<ContactsResult>("query_contacts", { companies: ["Stripe"], limit: 50 });
    check("a company filter is exact past the default slice", stripe.total === 10 && stripe.rows.length === 10);
    check("…closest first", stripe.rows.slice(0, 3).every((r) => r.name.startsWith("Stripe ") && Number(r.name.split(" ")[1]) < 3), JSON.stringify(stripe.rows.slice(0, 3).map((r) => r.name)));
    const byCompany = await run<ContactsResult>("query_contacts", { group_by: "company", limit: 0 });
    check(
      "group_by company: counts largest first, the blank company named as such",
      JSON.stringify(byCompany.groups) ===
        JSON.stringify([{ key: "Stripe", count: 10 }, { key: "Ramp", count: 6 }, { key: "(not recorded)", count: 4 }]),
      JSON.stringify(byCompany.groups)
    );
    const byTag = await run<ContactsResult>("query_contacts", { group_by: "tag", limit: 0 });
    check("group_by tag", JSON.stringify(byTag.groups) === JSON.stringify([{ key: "investor", count: 3 }]), JSON.stringify(byTag.groups));
    const added = await run<ContactsResult>("query_contacts", { added_after: "2026-10-01" });
    check("added_after: who was added recently", added.total === 2 && added.rows.every((r) => r.added === "2026-10-05"), JSON.stringify(added));
    const never = await run<ContactsResult>("query_contacts", { never_interacted: true, limit: 0 });
    check("never_interacted: everyone with no logged interaction", never.total === 18, String(never.total));
    const noEmail = await run<ContactsResult>("query_contacts", { companies: ["Stripe"], missing: ["email"], limit: 0 });
    check("missing email, within a filter", noEmail.total === 3, String(noEmail.total));
    const inMarch = await run<ContactsResult>("query_contacts", { interacted_after: "2026-03-01", interacted_before: "2026-03-31" });
    check(
      "interacted in a window, with each person's last touch",
      inMarch.total === 2 && inMarch.rows.find((r) => r.id === stripe0.id)?.lastInteraction === "2026-04-02",
      JSON.stringify(inMarch.rows)
    );
    const inner = await run<ContactsResult>("query_contacts", { tiers: ["inner"], limit: 0 });
    check("a closeness tier", inner.total === 3);
    const theirs = await run<ContactsResult>("query_contacts", { limit: 0 }, OTHER);
    check("another user counts only their own", theirs.total === 1);
  }

  console.log("\nquery_interactions");
  {
    const march = await run<InteractionsResult>("query_interactions", { after: "2026-03-01", before: "2026-03-31", limit: 0 });
    check("a month's total", march.total === 4 && march.rows.length === 0, JSON.stringify(march));
    const coffees = await run<InteractionsResult>("query_interactions", { types: ["Coffee"], after: "2026-03-01", before: "2026-03-31" });
    check("by type, case-insensitive", coffees.total === 3 && coffees.rows.every((r) => r.type === "coffee"));
    check("rows carry the summary, never the raw note", !JSON.stringify(coffees).includes("SECRET RAW NOTE") && coffees.rows[0]?.summary === "Third coffee");
    check("newest first, with who it was with", coffees.rows[0]?.date === "2026-03-28" && coffees.rows[0]?.contactName === "Stripe 0");
    const byMonth = await run<InteractionsResult>("query_interactions", { group_by: "month", limit: 0 });
    check(
      "group_by month, newest month first",
      JSON.stringify(byMonth.groups) === JSON.stringify([{ key: "2026-04", count: 1 }, { key: "2026-03", count: 4 }]),
      JSON.stringify(byMonth.groups)
    );
    const byContact = await run<InteractionsResult>("query_interactions", { group_by: "contact", limit: 0 });
    check(
      "group_by contact names the person and carries their id",
      byContact.groups?.[0]?.key === "Stripe 0" && byContact.groups[0].count === 4 && byContact.groups[0].contactId === stripe0.id,
      JSON.stringify(byContact.groups)
    );
    const one = await run<InteractionsResult>("query_interactions", { contactId: ramp0.id });
    check("one person's history", one.total === 1 && one.rows[0]?.type === "call");
    const theirs = await run<InteractionsResult>("query_interactions", { limit: 0 }, OTHER);
    check("another user sees none of these", theirs.total === 0);
  }

  console.log("\nEvents");
  {
    const soon = new Date(Date.now() + 5 * 86_400_000);
    const past = new Date(Date.now() - 20 * 86_400_000);
    const [summit] = await db.insert(events).values({ userId: USER, title: "AWS Summit", startsAt: soon, endsAt: soon, city: "San Francisco" }).returning();
    const [mixer] = await db.insert(events).values({ userId: USER, title: "Founders mixer", startsAt: past, endsAt: past }).returning();
    await db.insert(events).values({ userId: OTHER, title: "Their private event", startsAt: soon, endsAt: soon });
    await db.insert(eventAttendees).values([
      { eventId: summit.id, userId: USER, fullName: "Stripe 0", company: "Stripe", contactId: stripe0.id, identityKey: "a1" },
      { eventId: summit.id, userId: USER, fullName: "New Person", company: "Acme", identityKey: "a2" },
      { eventId: mixer.id, userId: USER, fullName: "Stripe 0", company: "Stripe", contactId: stripe0.id, spokeTo: 1, identityKey: "a3" },
      { eventId: mixer.id, userId: USER, fullName: "Stranger", identityKey: "a4" },
    ]);
    type Ev = Array<{ id: string; title: string; rosterSize: number; inYourContacts: number }>;
    const upcoming = await run<Ev>("list_events", { when: "upcoming" });
    check(
      "list_events: upcoming only, with roster size and how many are contacts",
      upcoming.length === 1 && upcoming[0].title === "AWS Summit" && upcoming[0].rosterSize === 2 && upcoming[0].inYourContacts === 1,
      JSON.stringify(upcoming)
    );
    const all = await run<Ev>("list_events", { when: "all" });
    check("…both ways, never another user's", all.length === 2 && !JSON.stringify(all).includes("Their private event"));
    type Roster = { total: number; people: Array<{ name: string; spokeTo: boolean; contactId: string | null }> };
    const spoke = await run<Roster>("get_event_roster", { eventId: mixer.id, spoke_to: true });
    check("get_event_roster: who the user spoke to", spoke.total === 1 && spoke.people[0]?.name === "Stripe 0", JSON.stringify(spoke));
    const fresh = await run<Roster>("get_event_roster", { eventId: summit.id, in_contacts: false });
    check("…who is not a contact yet", fresh.total === 1 && fresh.people[0]?.name === "New Person");
    check("…and never another user's event", isToolError(await runToolAs("get_event_roster", { eventId: summit.id }, OTHER)));
    const together = await run<Array<{ title: string; spokeTo: boolean }>>("events_with_contact", { contactId: stripe0.id });
    check(
      "events_with_contact: both events, and where they spoke",
      together.length === 2 && together.some((e) => e.title === "Founders mixer" && e.spokeTo),
      JSON.stringify(together)
    );
  }

  console.log("\nOpportunities, sent email, imports, the dossier");
  {
    await db.insert(contactOpportunities).values([
      { userId: USER, contactId: stripe0.id, kind: "referral", label: "Referral to the payments team", dueDate: new Date("2026-11-01T00:00:00Z") },
      { userId: USER, contactId: ramp0.id, kind: "intro", label: "Intro to their CFO", status: "done" },
    ] as never);
    type Opp = Array<{ contactName: string; label: string; status: string; dueDate: string | null }>;
    const open = await run<Opp>("list_opportunities", {});
    check("list_opportunities: open ones across the network, with who and when", open.length === 1 && open[0].contactName === "Stripe 0" && open[0].dueDate === "2026-11-01", JSON.stringify(open));
    const everything = await run<Opp>("list_opportunities", { status: "all" });
    check("…and closed ones when asked", everything.length === 2);

    await db.insert(emailSends).values({
      userId: USER,
      provider: "gmail",
      fromEmail: "me@example.com",
      to: ["s0@stripe.example"],
      subject: "Following up on payments",
      bodyText: "SECRET EMAIL BODY",
      contactIds: [stripe0.id],
      origin: "compose",
      sendAt: new Date("2026-09-01T10:00:00Z"),
      sentAt: new Date("2026-09-01T10:00:05Z"),
      status: "sent",
      rfcMessageId: "<smoke@orbit>",
    } as never);
    type Sent = Array<{ subject: string; status: string; date: string }>;
    const sent = await run<Sent>("list_sent_emails", { contactId: stripe0.id });
    check("list_sent_emails: subject, status and date for one contact", sent.length === 1 && sent[0].subject === "Following up on payments" && sent[0].date === "2026-09-01", JSON.stringify(sent));
    check("…never the body", !JSON.stringify(sent).includes("SECRET EMAIL BODY"));
    check("…nothing for someone never emailed", (await run<Sent>("list_sent_emails", { contactId: ramp0.id })).length === 0);

    await db.insert(imports).values({ userId: USER, importType: "linkedin_csv", fileName: "Connections.csv", status: "completed", contactsCreated: 20 } as never);
    const recent = await run<Array<{ type: string; contactsCreated: number }>>("recent_imports", {});
    check("recent_imports", recent.length === 1 && recent[0].type === "linkedin_csv" && recent[0].contactsCreated === 20, JSON.stringify(recent));

    const dossier = await run<{ contact?: { fullName: string } }>("get_dossier", { contactId: stripe0.id });
    check("get_dossier: one relationship's brief", dossier.contact?.fullName === "Stripe 0", JSON.stringify(dossier).slice(0, 200));
    check("…not someone else's contact", isToolError(await runToolAs("get_dossier", { contactId: stripe0.id }, OTHER)));
  }

  console.log("\nRead-only, and shaped for MCP by its own allowlist");
  {
    const tool = ORBIT_TOOLS.find((t) => t.name === "query_contacts")!;
    const overMcp = await runTool(tool, USER, {}, { surface: "mcp", scopes: ["read"] });
    check("offered over MCP on a read scope", !isToolError(overMcp) && typeof (overMcp as { total: number }).total === "number", JSON.stringify(overMcp).slice(0, 160));
    check(
      "every feature read declares an MCP field allowlist",
      FEATURE_TOOLS.every((t) => t.scope === "read" && t.surfaces.includes("mcp") && Array.isArray(t.fields?.mcp)),
      FEATURE_TOOLS.filter((t) => !t.fields?.mcp).map((t) => t.name).join(", ")
    );
    const captures = FEATURE_TOOLS.find((t) => t.name === "recent_captures")!;
    check("a capture's raw text (title, excerpt) never reaches MCP", !captures.fields!.mcp!.some((f) => f === "title" || f === "excerpt"));
    const bad = await runTool(tool, USER, { group_by: "salary" }, { surface: "chat", scopes: ["read"] });
    check("an argument outside the schema is refused with a message", isToolError(bad));
  }

  await clear();
  if (failures) {
    console.error(`\n${failures} feature-tool check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll feature-tool checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
