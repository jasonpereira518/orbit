/**
 * Radar's Opportunities (Radar revision PR 8): events near you, people to meet, programs.
 *
 * One budgeted web pass per account, about once a week. Nothing it finds becomes a contact;
 * it lands in `radar_opportunities`. Kept only when:
 *   - the link is one the search provider actually cited (never a URL the model wrote);
 *   - an event or deadline is in the future (where the site allows, the page itself is read
 *     and its own date wins; Luma pages are never fetched and stand on the citation);
 *   - a new person has someone the account knows who can introduce them.
 * Each kind spends the plan's own monthly allowance, and background work never takes more
 * than its share of the account's monthly searches.
 *
 * Writes to local PGlite. Run: npx tsx scripts/smoke-radar-opportunities.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { and, eq, like } from "drizzle-orm";
import { getDb } from "../src/db";
import { contactExperiences, radarOpportunities, rateLimitBuckets, userGoals, userSettings } from "../src/db/schema";
import type { WebSource } from "../src/lib/ai";
import { EventPageError } from "../src/lib/events/fetch-page";
import type { EventPageDetails } from "../src/lib/events/parse-page";
import { getRecommendedUpcomingEvents } from "../src/lib/events/recommendations";
import { runRadarWebForUser, type RadarWebSearch } from "../src/lib/radar/opportunities";
import { consumeBucket, RATE_LIMITS } from "../src/lib/rate-limit";
import { orgKeysFor } from "../src/lib/warm-paths";
import { WEB_SEARCH_BACKGROUND_SHARE, WEB_SEARCH_SCOPE, webSearchMonthKey } from "../src/lib/web-search-budget";
import { ensureUserSettings } from "../src/lib/user-settings";
import { clearCareerProfile, setCity } from "../src/lib/career-profile-server";
import { checker } from "./smoke/check";
import { fakeUserId, insertContact, purgeUsers } from "./smoke/factories";

const t = checker();
const DAY = 86_400_000;
const NOW = new Date();
const inDays = (d: number) => new Date(NOW.getTime() + d * DAY).toISOString();

const cited = (...urls: string[]): WebSource[] => urls.map((url) => ({ url, title: null }));

/** One fake provider: answers by what the prompt asks for, and records every call. */
function fakeSearch() {
  const asked: string[] = [];
  const search: RadarWebSearch = async (_userId, req) => {
    asked.push(req.kind);
    if (req.kind === "event") {
      return {
        json: JSON.stringify({
          events: [
            { title: "Austin Fintech Meetup", url: "https://www.meetup.com/austin-fintech/events/1", startsAt: inDays(6), venue: "Capital Factory", why: "Fintech founders, your goal" },
            { title: "Builders Night", url: "https://lu.ma/builders-night", startsAt: inDays(9), venue: null, why: "Early-stage builders" },
            { title: "Last month's mixer", url: "https://example.com/past", startsAt: inDays(-20), venue: null, why: "Old" },
            { title: "Invented summit", url: "https://made-up.example.com/summit", startsAt: inDays(4), venue: null, why: "Never cited" },
            { title: "Page says it already happened", url: "https://example.com/moved", startsAt: inDays(3), venue: null, why: "Stale listing" },
          ],
        }),
        sources: cited("https://www.meetup.com/austin-fintech/events/1", "https://lu.ma/builders-night", "https://example.com/past", "https://example.com/moved"),
      };
    }
    if (req.kind === "person") {
      return {
        json: JSON.stringify({
          candidates: [
            { fullName: "Ana Ortiz", title: "Head of Payments", company: "Ramp", whyMatches: "Leads payments at Ramp", url: "https://ramp.com/team/ana" },
            { fullName: "Bo Lind", title: "CTO", company: "Nowhere Labs", whyMatches: "CTO at a fintech", url: "https://nowhere.example.com/bo" },
            { fullName: "Cy Park", title: "PM", company: "Ramp", whyMatches: "PM at Ramp", url: "https://made-up.example.com/cy" },
          ],
        }),
        sources: cited("https://ramp.com/team/ana", "https://nowhere.example.com/bo"),
      };
    }
    return {
      json: JSON.stringify({
        programs: [
          { title: "Fintech Fellowship 2027", url: "https://example.org/fellowship", deadline: inDays(20), why: "Matches your fintech goal" },
          { title: "Closed call", url: "https://example.org/closed", deadline: inDays(-2), why: "Already closed" },
        ],
      }),
      sources: cited("https://example.org/fellowship", "https://example.org/closed"),
    };
  };
  return { search, asked };
}

/** The page reader: real details for the meetup, a past date for the moved one, refusal for Luma. */
function fakeFetch() {
  const fetched: string[] = [];
  const fetchPage = async (url: string): Promise<EventPageDetails> => {
    fetched.push(url);
    if (url.includes("lu.ma")) throw new EventPageError("declined_host", "never");
    const startsAt = url.includes("moved") ? new Date(NOW.getTime() - 2 * DAY) : new Date(inDays(7));
    return { sourceUrl: url, canonicalUrl: null, title: null, description: null, startsAt, endsAt: null, timezone: null, venue: "Capital Factory, 701 Brazos St", city: "Austin", organizerName: null, organizerUrl: null, attendanceMode: "offline", speakers: [], platform: null, providerEventId: null } as unknown as EventPageDetails;
  };
  return { fetchPage, fetched };
}

run(async () => {
  const db = await getDb();
  const PRO = fakeUserId("radar-opps-pro");
  const FREE = fakeUserId("radar-opps-free");
  const OFF = fakeUserId("radar-opps-off");
  const BUSY = fakeUserId("radar-opps-busy");
  const users = [PRO, FREE, OFF, BUSY];
  await purgeUsers(db, users);
  await db.delete(rateLimitBuckets).where(like(rateLimitBuckets.bucket, "%radar-opps%"));
  try {
    for (const u of users) {
      await ensureUserSettings(u);
      await db.insert(userGoals).values({ userId: u, text: "Move into fintech product roles" });
      await db
        .update(userSettings)
        .set({ radarEnabledAt: u === OFF ? null : new Date(NOW.getTime() - 30 * DAY), compedPlan: u === FREE ? null : "orbit" })
        .where(eq(userSettings.userId, u));
    }
    // The city as Settings saves it, next to an imported location it must outrank.
    for (const u of users) {
      await db.update(userSettings).set({ careerProfile: { profile: { location: "Imported Town" } } }).where(eq(userSettings.userId, u));
      await setCity(u, "  Austin, TX ");
    }
    const [settings] = await db.select({ career: userSettings.careerProfile }).from(userSettings).where(eq(userSettings.userId, PRO));
    t.check("the typed city is saved, trimmed, beside the imported location", settings?.career?.city === "Austin, TX" && settings.career.profile?.location === "Imported Town", JSON.stringify(settings?.career));
    await clearCareerProfile(OFF);
    const [afterClear] = await db.select({ career: userSettings.careerProfile }).from(userSettings).where(eq(userSettings.userId, OFF));
    t.check("removing imported details keeps the typed city", afterClear?.career?.city === "Austin, TX" && !afterClear.career.profile, JSON.stringify(afterClear?.career));
    await setCity(OFF, "");
    const [cleared] = await db.select({ career: userSettings.careerProfile }).from(userSettings).where(eq(userSettings.userId, OFF));
    t.check("an empty city clears it", cleared?.career === null, JSON.stringify(cleared?.career));

    const maya = await insertContact(db, PRO, 51, { fullName: "Maya Chen", company: "Ramp" });
    await db.insert(contactExperiences).values({ userId: PRO, contactId: maya.id, kind: "role", organization: "Ramp", organizationNormalized: orgKeysFor(["Ramp"])[0]!, isCurrent: true, source: "web" });

    console.log("\na Pro account's weekly pass");
    const s = fakeSearch();
    const f = fakeFetch();
    const stats = await runRadarWebForUser(PRO, { search: s.search, fetchPage: f.fetchPage, now: NOW });
    t.check("one search per kind", [...s.asked].sort().join() === "event,person,program", s.asked.join());
    const rows = await db.select().from(radarOpportunities).where(eq(radarOpportunities.userId, PRO));
    const byUrl = new Map(rows.map((r) => [r.url, r]));
    t.check("the cited future event is kept", byUrl.has("https://www.meetup.com/austin-fintech/events/1"), JSON.stringify(stats));
    t.check("…with the date read from its own page", byUrl.get("https://www.meetup.com/austin-fintech/events/1")?.startsAt?.toISOString() === inDays(7));
    t.check("a Luma event stands on its citation and is never fetched", byUrl.has("https://lu.ma/builders-night") && !f.fetched.some((u) => u.includes("lu.ma")));
    t.check("a past event is dropped", !byUrl.has("https://example.com/past"));
    t.check("an uncited link is dropped", ![...byUrl.keys()].some((u) => u?.includes("made-up")));
    t.check("an event whose own page says it already happened is dropped", !byUrl.has("https://example.com/moved"));

    const ana = byUrl.get("https://ramp.com/team/ana");
    t.check("a new person with an introducer is kept", ana?.kind === "person" && ana.relatedContactIds.includes(maya.id), JSON.stringify(ana));
    t.check("one with nobody to introduce them is not", !byUrl.has("https://nowhere.example.com/bo"));
    t.check("the introducer is part of the proof", Boolean(ana?.evidence.some((e) => e.proof?.type === "record" && e.proof.table === "contacts" && e.proof.id === maya.id)));

    const fellowship = byUrl.get("https://example.org/fellowship");
    t.check("an open program is kept, expiring at its deadline", fellowship?.kind === "program" && fellowship.expiresAt?.toISOString() === inDays(20));
    t.check("a closed one is not", !byUrl.has("https://example.org/closed"));
    t.check("every row is proven by a cited link", rows.every((r) => r.evidence.some((e) => e.proof?.type === "url" && e.proof.url === r.url)));
    t.check("and nothing else was written", rows.length === 4, String(rows.length));

    console.log("\nthe Events page's Recommended tab");
    const recommended = await getRecommendedUpcomingEvents(PRO, NOW);
    t.check(
      "lists the events Radar found, soonest first",
      recommended.map((r) => r.url).join() === "https://www.meetup.com/austin-fintech/events/1,https://lu.ma/builders-night",
      recommended.map((r) => r.url).join()
    );
    t.check("with the venue its page gave", recommended[0]?.venue === "Capital Factory, 701 Brazos St", String(recommended[0]?.venue));

    console.log("\nthe rhythm and the budgets");
    const again = fakeSearch();
    await runRadarWebForUser(PRO, { search: again.search, fetchPage: f.fetchPage, now: NOW });
    t.check("the next pass waits about a week", again.asked.length === 0);
    const later = fakeSearch();
    await runRadarWebForUser(PRO, { search: later.search, fetchPage: f.fetchPage, now: new Date(NOW.getTime() + 8 * DAY) });
    const kept = await db.select({ id: radarOpportunities.id }).from(radarOpportunities).where(and(eq(radarOpportunities.userId, PRO), eq(radarOpportunities.url, "https://www.meetup.com/austin-fintech/events/1")));
    t.check("a week later it searches again, and writes no duplicates", later.asked.length === 3 && kept.length === 1, later.asked.join());

    const free = fakeSearch();
    await runRadarWebForUser(FREE, { search: free.search, fetchPage: f.fetchPage, now: NOW });
    t.check("Free gets its one event search, and no people or programs", free.asked.join() === "event", free.asked.join());

    const off = fakeSearch();
    const offStats = await runRadarWebForUser(OFF, { search: off.search, fetchPage: f.fetchPage, now: NOW });
    t.check("an account with Radar off searches nothing", off.asked.length === 0 && offStats.skipped === "off");

    const monthly = RATE_LIMITS.webSearchMonthly;
    await consumeBucket(WEB_SEARCH_SCOPE, webSearchMonthKey(BUSY, NOW), monthly, monthly.limit * WEB_SEARCH_BACKGROUND_SHARE);
    const busy = fakeSearch();
    const busyStats = await runRadarWebForUser(BUSY, { search: busy.search, fetchPage: f.fetchPage, now: NOW });
    t.check("background stops at its share of the month's searches", busy.asked.length === 0 && busyStats.skipped === "budget");

  } finally {
    await purgeUsers(db, users);
    await db.delete(rateLimitBuckets).where(like(rateLimitBuckets.bucket, "%radar-opps%"));
  }

  t.done("radar opportunities");
});
