import { and, eq, inArray, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts, userSettings } from "@/db/schema";
import { buildDiscoveryQuery } from "@/lib/about-you";
import { userCanUseAi } from "@/lib/ai";
import { webSearchPaused } from "@/lib/ai-access";
import { loadUserAim } from "@/lib/career-profile-server";
import { linkedinSlug } from "@/lib/duplicates";
import { listSchools, listTargetCompanies } from "@/lib/events/target-companies";
import { consumeBucket, isRateLimitedError, RATE_LIMITS } from "@/lib/rate-limit";
import { reportError } from "@/lib/report-error";
import { isSurfaceReleased } from "@/lib/surface-visibility";
import {
  discoverPeople,
  loadCachedDiscovery,
  loadLatestCachedDiscovery,
  type Candidate,
  type DiscoveryResearcher,
} from "@/lib/web-research";

export type PersonToMeet = {
  name: string;
  headline: string | null;
  /** The candidate's organization, for the Brief anchor. */
  company: string | null;
  whyMatches: string;
  url: string;
};

const SHOWN = 2;
const WEEK_MS = 7 * 86_400_000;

type Gates = {
  released: (userId: string) => Promise<boolean>;
  canUseAi: (userId: string) => Promise<boolean>;
  paused: () => Promise<boolean>;
};

const REAL_GATES: Gates = {
  released: (userId) => isSurfaceReleased(userId, "page.find"),
  canUseAi: userCanUseAi,
  paused: () => webSearchPaused(),
};

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

/**
 * The dashboard's weekly "People to meet": at most two people from a Find-people search built
 * from the person's aim, target companies and schools. Every plan, Free included, but dark until
 * `page.find` is released, and one paid search per account per 7 days (`peopleToMeet` bucket;
 * the search also counts against `webResearch`). A run younger than a week is served from
 * `discoverPeople`'s cache; an older one is refreshed only if the week's bucket has room, else
 * the old run is served — or, when the query changed since, the newest run for any query. Every expected outcome — a gate, nothing to search, no room — is `[]`.
 */
export async function loadPeopleToMeet(
  userId: string,
  opts: { now?: () => Date; researcher?: DiscoveryResearcher; gates?: Partial<Gates> } = {},
): Promise<PersonToMeet[]> {
  const gates = { ...REAL_GATES, ...opts.gates };
  const now = opts.now ?? (() => new Date());
  try {
    if (!(await gates.released(userId))) return [];
    if (!(await gates.canUseAi(userId))) return [];
    if (await gates.paused()) return [];

    const [aim, companies, schools] = await Promise.all([
      loadUserAim(userId),
      listTargetCompanies(userId),
      listSchools(userId),
    ]);
    const query = buildDiscoveryQuery({ aim, companies: companies.map((c) => c.name), schools });
    if (!query) return [];

    const cached = await loadCachedDiscovery(userId, query);
    let candidates = cached?.candidates ?? [];
    const stale = !cached || now().getTime() - new Date(cached.researchedAt).getTime() > WEEK_MS;
    if (stale) {
      if (await claimWeeklyRun(userId)) {
        const run = await discoverPeople(userId, query, { fresh: true, now, researcher: opts.researcher });
        if (run.ok) candidates = run.result.candidates;
      } else if (!cached) {
        // The query changed mid-week (an edited aim or target company) after the week's run was
        // spent: keep showing that run rather than an empty card until next week.
        candidates = (await loadLatestCachedDiscovery(userId))?.candidates ?? [];
      }
    }
    return (await dropKnownPeople(userId, candidates)).slice(0, SHOWN).map(toPersonToMeet);
  } catch (err) {
    reportError(err, { where: "people-to-meet.load", level: "warning", userId });
    return [];
  }
}

/** True when this week's one discovery run is ours to spend. */
async function claimWeeklyRun(userId: string): Promise<boolean> {
  try {
    await consumeBucket("people-to-meet", userId, RATE_LIMITS.peopleToMeet);
    return true;
  } catch (err) {
    if (isRateLimitedError(err)) return false;
    throw err;
  }
}

/** Drops anyone already a contact (same name + company, or same LinkedIn profile) and the person themself. */
async function dropKnownPeople(userId: string, candidates: Candidate[]): Promise<Candidate[]> {
  if (!candidates.length) return [];
  const db = await getDb();
  const names = [...new Set(candidates.map((c) => norm(c.fullName)))];
  const slugs = [...new Set(candidates.map((c) => linkedinSlug(c.url)).filter(Boolean))];
  const [known, settings] = await Promise.all([
    db
      .select({ fullName: contacts.fullName, company: contacts.company, linkedinUrl: contacts.linkedinUrl })
      .from(contacts)
      .where(
        and(
          eq(contacts.userId, userId),
          or(
            inArray(sql`lower(trim(${contacts.fullName}))`, names),
            // Narrows only; the exact slug compare is `linkedinSlug` below.
            ...slugs.map((s) => sql`lower(${contacts.linkedinUrl}) like ${`%/in/${s}%`}`),
          ),
        ),
      ),
    db.query.userSettings.findFirst({ where: eq(userSettings.userId, userId), columns: { socialLinks: true } }),
  ]);
  const knownPeople = new Set(known.map((c) => `${norm(c.fullName)}|${norm(c.company)}`));
  const knownSlugs = new Set(known.map((c) => linkedinSlug(c.linkedinUrl)).filter(Boolean));
  const ownSlug = linkedinSlug(settings?.socialLinks?.linkedin);
  if (ownSlug) knownSlugs.add(ownSlug);
  return candidates.filter((c) => {
    const slug = linkedinSlug(c.url);
    return !knownPeople.has(`${norm(c.fullName)}|${norm(c.company)}`) && !(slug && knownSlugs.has(slug));
  });
}

function toPersonToMeet(c: Candidate): PersonToMeet {
  const headline = [c.title, c.company].filter(Boolean).join(" at ") || null;
  return { name: c.fullName, headline, company: c.company, whyMatches: c.whyMatches, url: c.url };
}
