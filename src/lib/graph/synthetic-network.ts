/**
 * A deterministic, realistically-shaped network of any size, for measuring the constellation.
 *
 * The real payload is whatever account happens to be signed in, which makes "is 5,000 contacts
 * smooth?" unanswerable twice in a row. This returns the exact shape `getGraphData` does —
 * clusters built by the same `buildConstellationClusters` the server uses — from nothing but a
 * count and a seed, so a benchmark at a given scale is repeatable across runs and branches.
 *
 * The shape matters more than the count. Layout cost is driven by cluster structure, not
 * headcount: `scripts/lib/scale-fixture.ts` spreads everyone over 16 companies, which at 10,000
 * is sixteen 600-person clusters and nothing like a real export. Real networks are Zipf — a
 * few employers hold many people and a long tail holds one or two each — so companies here are
 * drawn from a power law over a pool that grows with the network.
 *
 * Pure and dependency-light on purpose: it runs in the browser (the bench page), in a worker,
 * and under tsx (the layout benchmark).
 */
import {
  buildConstellationClusters,
  toNamedGraphClusters,
} from "@/lib/constellation-clusters";
import type { GraphPayload } from "@/components/graph/graph-chart-types";

/** mulberry32 — tiny seeded PRNG, so every run generates identical data. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ["Ada", "Grace", "Alan", "Katherine", "Edsger", "Barbara", "Donald", "Margaret", "Linus", "Radia", "Ken", "Frances", "Tim", "Shafi", "Vint", "Adele", "Bjarne", "Anita", "Guido", "Carol", "Yukihiro", "Sophie", "Rasmus", "Jean", "Dennis", "Hedy", "Niklaus", "Evelyn", "Brian", "Mary", "Priya", "Wei", "Amara", "Diego", "Noor", "Kenji"];
const LAST = ["Lovelace", "Hopper", "Turing", "Johnson", "Dijkstra", "Liskov", "Knuth", "Hamilton", "Torvalds", "Perlman", "Thompson", "Allen", "Cerf", "Goldberg", "Stroustrup", "Borg", "Shaw", "Wilson", "Bartik", "Ritchie", "Lamarr", "Wirth", "Boyd", "Kernighan", "Keller", "Okafor", "Nakamura", "Silva", "Haddad", "Chen"];
/** Real names first, so the head of the distribution picks up real brand colours. */
const BRANDS = ["Google", "Amazon", "Microsoft", "Meta", "Apple", "Stripe", "Shopify", "Netflix", "Airbnb", "Uber", "Salesforce", "Adobe", "Nvidia", "Intel", "IBM", "Oracle", "Spotify", "Slack", "Figma", "Notion", "Datadog", "Snowflake", "Cloudflare", "Atlassian", "Twilio", "GitHub", "OpenAI", "Anthropic", "Coinbase", "Square", "Dropbox", "Pinterest", "LinkedIn", "Tesla", "SpaceX", "Palantir", "Databricks", "Vercel", "Wealthsimple", "RBC"];
const SCHOOLS = ["MIT", "Stanford", "Waterloo", "UofT", "Harvard", "Berkeley", "CMU", "Cambridge", "Oxford", "ETH Zurich", "McGill", "UBC", "Princeton", "Caltech", "Cornell", "Columbia", "Yale", "Imperial", "TU Delft", "NUS", "Tsinghua", "IIT Bombay", "Georgia Tech", "UCLA", "Michigan", "Queens", "Western", "Duke", "Brown", "Penn"];
const TITLES = ["Engineer", "Staff Engineer", "Design Lead", "Product Manager", "Founder", "CTO", "Recruiter", "Data Scientist", "Researcher", "VP Engineering", "Designer", "Partner", null];
const TAGS = ["mentor", "investor", "alum", "conference", "warm intro", "hiring", "advisor", "friend", "climbing", "ai"];

const DAY = 86_400_000;

/** A fixed "now", so dormancy and overdue flags do not drift with the wall clock. */
const EPOCH = Date.UTC(2026, 8, 1);

/** Index from a Zipf(s) distribution over `size` ranks, via a precomputed CDF. */
function zipfSampler(size: number, s: number, rand: () => number) {
  const cdf = new Float64Array(size);
  let total = 0;
  for (let k = 0; k < size; k++) {
    total += 1 / Math.pow(k + 1, s);
    cdf[k] = total;
  }
  return () => {
    const x = rand() * total;
    let lo = 0;
    let hi = size - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cdf[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
}

function companyName(rank: number) {
  if (rank < BRANDS.length) return BRANDS[rank];
  return `Company ${rank - BRANDS.length + 1}`;
}

export type SyntheticNetworkOptions = {
  seed?: number;
  userId?: string;
  userName?: string;
};

/**
 * `count` contacts plus everything the chart reads beside them.
 *
 * Every contact is marked `substantive`, so the payload is what the "show all" scope would
 * ship: the benchmark is about drawing N stars, not about the eligibility filter.
 */
export function buildSyntheticGraphPayload(
  count: number,
  options: SyntheticNetworkOptions = {}
): GraphPayload {
  const rand = mulberry32(options.seed ?? 1);
  const userId = options.userId ?? "bench-user";
  // Roughly one employer per six people, as in a real export's long tail.
  const companyPool = Math.max(12, Math.round(count / 6));
  const pickCompany = zipfSampler(companyPool, 1.07, rand);
  const pickSchool = zipfSampler(SCHOOLS.length, 1.2, rand);

  const contacts: GraphPayload["contacts"] = [];
  for (let i = 0; i < count; i++) {
    const first = FIRST[Math.floor(rand() * FIRST.length)];
    const last = LAST[Math.floor(rand() * LAST.length)];
    const roll = rand();
    // 68% employed somewhere, 14% school-only, the rest deep space.
    const company = roll < 0.68 ? companyName(pickCompany()) : null;
    const school =
      roll >= 0.68 && roll < 0.82
        ? SCHOOLS[pickSchool()]
        : rand() < 0.35
          ? SCHOOLS[pickSchool()]
          : null;
    const scoreRoll = rand();
    const orbitScore =
      scoreRoll < 0.35 ? 1 : scoreRoll < 0.6 ? 2 : scoreRoll < 0.8 ? 3 : scoreRoll < 0.92 ? 4 : 5;
    const dormant = rand() < 0.12;
    const lastInteractionAt = new Date(
      EPOCH - (dormant ? 200 + rand() * 600 : rand() * 150) * DAY
    );
    const tagCount = Math.floor(rand() * 3);
    const tags = Array.from(
      new Set(Array.from({ length: tagCount }, () => TAGS[Math.floor(rand() * TAGS.length)]))
    );
    const title = TITLES[Math.floor(rand() * TITLES.length)];
    contacts.push({
      id: `bench-${i.toString(36).padStart(4, "0")}`,
      fullName: `${first} ${last}`,
      preferredName: null,
      company,
      school,
      title,
      relationshipScore: orbitScore,
      closeness: orbitScore / 5,
      closenessTier: orbitScore >= 4 ? "inner" : orbitScore >= 3 ? "mid" : "outer",
      orbitScore,
      lastInteractionAt,
      hasLoggedInteraction: rand() < 0.5,
      nextFollowUpAt: rand() < 0.05 ? new Date(EPOCH - 5 * DAY) : null,
      tags,
      aiSummary:
        rand() < 0.5 ? `${title ?? "Works"} at ${company ?? "an unlisted company"}.` : null,
      keyFacts: rand() < 0.3 ? ["Runs marathons"] : [],
      howMet: rand() < 0.3 ? "Met at a conference" : null,
      metContext: null,
      dateMet: null,
      notes: null,
      sharedInterests: [],
      email: `${first.toLowerCase()}.${i}@example.com`,
      phone: null,
      linkedinUrl: null,
      website: null,
      profileImageUrl: null,
      dormant,
      substantive: true,
    });
  }

  const { clusters: built } = buildConstellationClusters(contacts);
  const clusters = toNamedGraphClusters(built);
  const companies = [...new Set(contacts.map((c) => c.company).filter(Boolean) as string[])].sort(
    (a, b) => a.localeCompare(b)
  );
  const schools = [...new Set(contacts.map((c) => c.school).filter(Boolean) as string[])].sort(
    (a, b) => a.localeCompare(b)
  );
  const scoreCounts: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const c of contacts) scoreCounts[c.orbitScore] += 1;

  return {
    contacts,
    companies,
    schools,
    tags: [...TAGS],
    clusters,
    userId,
    summary: {
      total: count,
      companyCount: companies.length,
      scoreCounts,
      strongTies: scoreCounts[4] + scoreCounts[5],
      dormantCount: contacts.filter((c) => c.dormant).length,
      overdueCount: contacts.filter((c) => c.nextFollowUpAt).length,
      constellationFilter: {
        active: false,
        enabled: false,
        scope: "all",
        shown: count,
        engaged: count,
        available: count,
      },
      userName: options.userName ?? "You",
      userImageUrl: null,
      userEmail: null,
      socialLinks: {},
      goals: [],
    },
  };
}
