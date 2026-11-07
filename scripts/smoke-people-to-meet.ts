/**
 * The weekly "People to meet" loader: its gates, its one-run-a-week allowance, and the
 * candidates it drops (existing contacts, the person themself).
 *
 * Local PGlite, fake researcher (no key, no network). The release / AI / pause gates are
 * injected, since PGlite cannot stand up a coming-soon flag or a managed pool cleanly.
 * Run: npx tsx scripts/smoke-people-to-meet.ts
 */
import "./smoke/_env";
import { eq, like } from "drizzle-orm";
import { getDb } from "../src/db";
import { aiResultCache, contacts, rateLimitBuckets, userSettings } from "../src/db/schema";
import { loadPeopleToMeet } from "../src/lib/people-to-meet";
import type { DiscoveryResearcher } from "../src/lib/web-research";

const USER = "smoke-people-to-meet-user";
const DAY = 86_400_000;

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const CANDIDATES = [
  { fullName: "grace hopper", title: "Engineer", company: "stripe", whyMatches: "UNC alum at Stripe", url: "https://stripe.com/team/grace" },
  { fullName: "Ada Tester", title: "Student", company: "UNC", whyMatches: "UNC student", url: "https://www.linkedin.com/in/Ada-Tester/" },
  { fullName: "Linus Slug", title: "PM", company: "Figma", whyMatches: "UNC alum at Figma", url: "https://linkedin.com/in/linus-slug" },
  { fullName: "Alan Turing", title: "Staff PM", company: "Stripe", whyMatches: "UNC alum, PM at Stripe", url: "https://stripe.com/team/alan" },
  { fullName: "Barbara Liskov", title: null, company: "Figma", whyMatches: "UNC alum at Figma", url: "https://figma.com/team/barbara" },
  { fullName: "Third Fit", title: "PM", company: "Stripe", whyMatches: "UNC alum", url: "https://stripe.com/team/third" },
];

function fake() {
  const calls: { user: string }[] = [];
  const researcher: DiscoveryResearcher = async (_uid, user) => {
    calls.push({ user });
    return { json: JSON.stringify({ candidates: CANDIDATES }), sources: [] };
  };
  return { researcher, calls };
}

const OPEN = { released: async () => true, canUseAi: async () => true, paused: async () => false };

async function reset(settings: { schools?: string[] } = { schools: ["UNC"] }) {
  const db = await getDb();
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await db.delete(aiResultCache).where(eq(aiResultCache.userId, USER));
  await db.delete(rateLimitBuckets).where(like(rateLimitBuckets.bucket, `%${USER}%`));
  await db.insert(userSettings).values({
    userId: USER,
    firstName: "Ada",
    lastName: "Tester",
    schools: settings.schools ?? [],
    socialLinks: { linkedin: "https://www.linkedin.com/in/ada-tester" },
  });
  await db.insert(contacts).values([
    { userId: USER, fullName: "Grace Hopper", company: "Stripe" },
    { userId: USER, fullName: "L. Slug", company: "Somewhere", linkedinUrl: "https://www.linkedin.com/in/Linus-Slug/" },
  ]);
}

async function emptyWeeklyBucket() {
  const db = await getDb();
  await db.delete(rateLimitBuckets).where(like(rateLimitBuckets.bucket, `people-to-meet:${USER}`));
}

async function main() {
  const t0 = Date.now();
  const at = (days: number) => () => new Date(t0 + days * DAY);

  console.log("\ngates");
  await reset();
  {
    const f = fake();
    const out = await loadPeopleToMeet(USER, { researcher: f.researcher, gates: { ...OPEN, released: async () => false } });
    check("page.find coming-soon: nothing", out.length === 0);
    check("…and the researcher is never called", f.calls.length === 0);
  }
  {
    const f = fake();
    check("no AI: nothing", (await loadPeopleToMeet(USER, { researcher: f.researcher, gates: { ...OPEN, canUseAi: async () => false } })).length === 0 && f.calls.length === 0);
  }
  {
    const f = fake();
    check("web search paused: nothing", (await loadPeopleToMeet(USER, { researcher: f.researcher, gates: { ...OPEN, paused: async () => true } })).length === 0 && f.calls.length === 0);
  }
  await reset({ schools: [] });
  {
    const f = fake();
    check("no searchable query: nothing", (await loadPeopleToMeet(USER, { researcher: f.researcher, gates: OPEN })).length === 0 && f.calls.length === 0);
  }

  console.log("\nweekly run");
  await reset();
  const f = fake();
  const first = await loadPeopleToMeet(USER, { researcher: f.researcher, gates: OPEN, now: at(0) });
  check("released on a Free account: 2 results", first.length === 2, JSON.stringify(first));
  check(
    "…the existing contact (name+company, slug) and the person themself are dropped",
    first.map((p) => p.name).join(",") === "Alan Turing,Barbara Liskov",
    JSON.stringify(first.map((p) => p.name)),
  );
  check("…shaped for the card", first[0]?.headline === "Staff PM at Stripe" && first[0]?.whyMatches === "UNC alum, PM at Stripe" && first[0]?.url === "https://stripe.com/team/alan" && first[1]?.headline === "Figma");
  check("…one search, for the built query", f.calls.length === 1 && f.calls[0].user.includes("UNC alumni"));

  const again = await loadPeopleToMeet(USER, { researcher: f.researcher, gates: OPEN, now: at(3) });
  check("a second call within 7 days is a cache hit", again.length === 2 && f.calls.length === 1);

  await emptyWeeklyBucket();
  const week2 = await loadPeopleToMeet(USER, { researcher: f.researcher, gates: OPEN, now: at(8) });
  check("8 days later with the weekly bucket unused: one fresh search", f.calls.length === 2 && week2.length === 2);

  const exhausted = await loadPeopleToMeet(USER, { researcher: f.researcher, gates: OPEN, now: at(16) });
  check("stale cache + bucket exhausted: the cached results, no search", f.calls.length === 2 && exhausted.length === 2);

  console.log("\nfirst run with no room");
  await reset();
  {
    await loadPeopleToMeet(USER, { researcher: fake().researcher, gates: OPEN, now: at(0) });
    const db = await getDb();
    await db.delete(aiResultCache).where(eq(aiResultCache.userId, USER));
    const g = fake();
    const out = await loadPeopleToMeet(USER, { researcher: g.researcher, gates: OPEN, now: at(1) });
    check("no cache and the bucket exhausted: nothing, no search", out.length === 0 && g.calls.length === 0);
  }

  console.log("\nprovider failure");
  await reset();
  {
    const boom: DiscoveryResearcher = async () => {
      throw new Error("provider exploded");
    };
    const out = await loadPeopleToMeet(USER, { researcher: boom, gates: OPEN, now: at(0) });
    check("a failing provider returns nothing instead of throwing", out.length === 0);
  }

  await reset({ schools: [] });
  const db = await getDb();
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall people-to-meet checks passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
