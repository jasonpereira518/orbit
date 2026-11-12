/**
 * Radar's people check (Radar revision PR 7): the work-history re-check, widened.
 *
 * The same one search that confirms where someone works now also reports up to three recent
 * public posts, talks or news about them. Nothing extra is searched. Kept only when:
 *   - the link is one the search provider actually cited (never a URL the model wrote);
 *   - the account has Radar on, the person is someone they have met, and the plan's monthly
 *     people-check allowance is not used up.
 * Kept items become Radar "heads-up" cards proven by the stored row and its cited link.
 *
 * Writes to local PGlite. Run: npx tsx scripts/smoke-radar-people-check.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { and, eq, like } from "drizzle-orm";
import { getDb } from "../src/db";
import { contactSignals, interactions, rateLimitBuckets, recommendations, userSettings } from "../src/db/schema";
import { keepCitedMentions, radarPulseAllowed, storeMentions } from "../src/lib/radar/pulse";
import { claimRadarLease, runRadarForUser } from "../src/lib/radar/run";
import { ensureUserSettings } from "../src/lib/user-settings";
import { researchContactWorkHistory, type CurrentRoleChecker } from "../src/lib/work-history-research";
import { checker } from "./smoke/check";
import { fakeUserId, insertContact, purgeUsers } from "./smoke/factories";

const t = checker();
const DAY = 86_400_000;
const NOW = new Date();
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

function pure() {
  console.log("\nonly what the provider cited");
  const kept = keepCitedMentions(
    [
      { kind: "talk", text: "Spoke at Money20/20 on stablecoin payouts", url: "https://example.com/talks/priya", dateIso: ago(5).toISOString() },
      { kind: "post", text: "A post the model made up", url: "https://made-up.example.com/x", dateIso: ago(3).toISOString() },
      { kind: "news", text: "Old news", url: "https://example.com/old", dateIso: ago(200).toISOString() },
      { kind: "post", text: "", url: "https://example.com/empty", dateIso: null },
      { kind: "post", text: "Script link", url: "javascript:alert(1)", dateIso: null },
    ],
    [{ url: "https://example.com/talks/priya", title: null }, { url: "https://example.com/old", title: null }, { url: "https://example.com/empty", title: null }],
    NOW
  );
  t.check("a mention whose link the provider cited is kept", kept.some((m) => m.url === "https://example.com/talks/priya"));
  t.check("a link the provider never cited is dropped", !kept.some((m) => m.url.includes("made-up")));
  t.check("so is one older than 90 days, an empty one, and an unsafe link", kept.length === 1, JSON.stringify(kept));
}

run(async () => {
  pure();

  console.log("\nwho gets a people check");
  const db = await getDb();
  const USER = fakeUserId("radar-people-check");
  const OFF = fakeUserId("radar-people-check-off");
  await purgeUsers(db, [USER, OFF]);
  await db.delete(rateLimitBuckets).where(like(rateLimitBuckets.bucket, "%radar-people-check%"));
  try {
    await ensureUserSettings(USER);
    await ensureUserSettings(OFF);
    // Free: two people checks a month.
    await db.update(userSettings).set({ radarEnabledAt: ago(30) }).where(eq(userSettings.userId, USER));
    const met = await insertContact(db, USER, 41, { fullName: "Priya Raman", company: "Stripe", title: "PM", linkedinUrl: "https://www.linkedin.com/in/priya-raman-people-check", closenessTier: "inner", closenessEvidence: 0.8, lastInteractionAt: ago(20) });
    await db.insert(interactions).values({ userId: USER, contactId: met.id, interactionType: "meeting", interactionDate: ago(100) });
    const imported = await insertContact(db, USER, 42, { fullName: "Imported Ivy" });
    const offContact = await insertContact(db, OFF, 43, { fullName: "Off Olu" });
    await db.insert(interactions).values({ userId: OFF, contactId: offContact.id, interactionType: "meeting", interactionDate: ago(100) });

    t.check("an account with Radar off gets the plain role check", !(await radarPulseAllowed(OFF, offContact.id, NOW)));
    t.check("so does someone the person has never met", !(await radarPulseAllowed(USER, imported.id, NOW)));
    console.log("\nthe role re-check, widened");
    const talk = { kind: "talk" as const, text: "Spoke at Money20/20 on stablecoin payouts", url: "https://example.com/talks/priya", dateIso: ago(1).toISOString() };
    // Orbit found Priya's history 40 days ago; today's sweep re-checks it.
    await researchContactWorkHistory(USER, met.id, {
      now: ago(40),
      researcher: async () => ({
        confident: true,
        headline: null,
        sources: [],
        experiences: [{ kind: "role", organization: "Stripe", title: "PM", fieldOfStudy: null, location: null, description: null, startYear: 2020, startMonth: null, endYear: null, endMonth: null, isCurrent: true }],
      }),
    });
    const asked: boolean[] = [];
    const checker: CurrentRoleChecker = async (_u, _s, opts) => {
      asked.push(Boolean(opts?.mentions));
      return { confident: true, current: { organization: "Stripe", title: "PM" }, mentions: opts?.mentions ? [talk] : undefined };
    };
    const outcome = await researchContactWorkHistory(USER, met.id, {
      now: NOW,
      checker,
      researcher: async () => {
        throw new Error("an unchanged role never runs the full search");
      },
    });
    t.check("a met contact on a Radar account gets the people check", asked[0] === true && outcome === "unchanged", `${asked} ${outcome}`);
    const [row] = await db.select().from(contactSignals).where(and(eq(contactSignals.userId, USER), eq(contactSignals.kind, "web_mention")));
    t.check("what it found is stored as a web mention with its cited link", row?.payload.url === "https://example.com/talks/priya" && row.payload.mentionKind === "talk");
    t.check("and a second this month", await radarPulseAllowed(USER, met.id, NOW));
    t.check("but Free's two a month are the cap", !(await radarPulseAllowed(USER, met.id, NOW)));
    t.check("a mention is stored once", (await storeMentions(USER, met.id, [talk], NOW)) === 0);

    await claimRadarLease(USER, NOW);
    const stats = await runRadarForUser(USER, { mode: "weekly", trigger: "schedule", now: NOW, ai: false });
    t.check("the run succeeds and drops nothing", stats.ok && stats.unproven === 0, JSON.stringify(stats));
    const [card] = await db
      .select({ kind: recommendations.kind, reasons: recommendations.reasons, evidence: recommendations.evidence })
      .from(recommendations)
      .where(and(eq(recommendations.userId, USER), eq(recommendations.contactId, met.id), eq(recommendations.status, "pending")));
    t.check("the mention is a heads-up on Priya", card?.kind === "heads_up" && card.reasons.some((r) => r.code === "public_mention" && r.label.includes("Money20/20")), JSON.stringify(card));
    const proof = card?.evidence.find((e) => e.code === "public_mention");
    t.check("proven by the stored row, with the cited link", proof?.proof?.type === "quote" && proof.proof.table === "contact_signals" && proof.url === "https://example.com/talks/priya", JSON.stringify(proof));
  } finally {
    await purgeUsers(db, [USER, OFF]);
  }

  t.done("radar people check");
});
