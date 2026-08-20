/**
 * Deterministic graph fixture for the constellation map.
 *
 * Seeds 114 contacts for "demo-user": 10 branded companies with fixed sizes,
 * 2 school clusters (MIT / Stanford), and a Deep Space fringe of singletons.
 * A seeded PRNG (mulberry32) makes every run produce the same data — dates
 * are relative to `new Date()` but always use the same offsets.
 *
 * Demo/PGlite mode only. Never imported by app code.
 * Run: npm run db:seed:graph
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { getDb } from "../src/db";
import { contacts, contactTags, tags } from "../src/db/schema";
import type { NewContact } from "../src/db/schema";
import { eq } from "drizzle-orm";

// Guard: this fixture wipes and reseeds demo-user data. Local PGlite only.
if (process.env.DATABASE_URL?.trim()) {
  console.error(
    "seed-graph-fixture is for demo/PGlite mode only, but DATABASE_URL is set."
  );
  console.error(
    "Unset DATABASE_URL (check .env.local) so writes go to the local PGlite store."
  );
  process.exit(1);
}

const DEMO_USER = "demo-user";

/** mulberry32 — tiny seeded PRNG so every run generates identical data. */
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

const rand = mulberry32(0x0417b17); // fixed seed — do not change casually
const randInt = (min: number, max: number) =>
  min + Math.floor(rand() * (max - min + 1));
const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)];

const now = new Date();
const DAY_MS = 86_400_000;
const daysAgoDate = (days: number) => new Date(now.getTime() - days * DAY_MS);
const daysAheadDate = (days: number) => new Date(now.getTime() + days * DAY_MS);

/** Companies chosen from the curated brand map in src/lib/school-color.ts.
 *  Vercel (#FFFFFF) is included deliberately as a near-white brand for
 *  tint-readability testing (Notion is a second near-white). */
const COMPANIES: ReadonlyArray<{ name: string; size: number }> = [
  { name: "AWS", size: 24 },
  { name: "Google", size: 18 },
  { name: "Stripe", size: 14 },
  { name: "OpenAI", size: 12 },
  { name: "Meta", size: 9 },
  { name: "Vercel", size: 7 },
  { name: "Anthropic", size: 5 },
  { name: "Figma", size: 4 },
  { name: "Notion", size: 3 },
  { name: "Apple", size: 2 },
];

/** Both exist in the school brand map (mit / stanford). */
const SCHOOLS = ["MIT", "Stanford"] as const;

/** One-off employers that fall through to Deep Space (size-1 clusters). */
const FRINGE_COMPANIES = [
  "Halcyon Robotics",
  "Bluenote Labs",
  "Kepler Dynamics",
  "Fernwood Studio",
  "Quietloop",
  "Marigold Health",
  "Tidepool Analytics",
] as const;

const FIRST_NAMES = [
  "Amara", "Jonas", "Priya", "Mateo", "Yuki", "Fatima", "Declan", "Ingrid",
  "Kwame", "Elena", "Ravi", "Sofia", "Tomas", "Nadia", "Hiro", "Zainab",
  "Marcus", "Leilani", "Oskar", "Camille", "Dmitri", "Aisha", "Felix", "Mei",
  "Santiago", "Astrid", "Tariq", "Bianca", "Kenji", "Seun", "Greta", "Rohan",
  "Isabela", "Anders", "Thandi", "Luca", "Noor", "Gabriel", "Sanaa", "Viktor",
  "Paloma", "Emeka", "Freya", "Diego", "Anika", "Callum", "Rosa", "Idris",
] as const;

const LAST_NAMES = [
  "Okafor", "Lindqvist", "Sharma", "Reyes", "Tanaka", "Haddad", "O'Brien",
  "Johansson", "Mensah", "Petrova", "Iyer", "Moreau", "Silva", "Rahimi",
  "Nakamura", "Whitfield", "Kealoha", "Novak", "Dubois", "Volkov", "Diallo",
  "Bergstrom", "Chen", "Alvarez", "Eriksen", "Hassan", "Romano", "Watanabe",
  "Adeyemi", "Keller", "Nair", "Costa", "Sorensen", "Ndlovu", "Ferrari",
  "Amini", "Fontaine", "Abebe", "Petrov", "Delgado", "Eze", "Larsen",
  "Mendoza", "Kapoor", "MacLeod", "Herrera", "Osei", "Beaumont",
] as const;

const TITLES = [
  "Software Engineer",
  "Senior Software Engineer",
  "Staff Engineer",
  "Engineering Manager",
  "Product Manager",
  "Product Designer",
  "Data Scientist",
  "Solutions Architect",
  "Developer Advocate",
  "Research Scientist",
  "Technical Program Manager",
  "Growth Lead",
  "VP Engineering",
  "Founder",
] as const;

const TAG_NAMES = ["AI", "Founders", "Hiring", "NYC"] as const;

/** Weighted toward the 2–3 middle of the relationship scale. */
function weightedRelationshipScore(): number {
  const x = rand();
  if (x < 0.1) return 1;
  if (x < 0.42) return 2;
  if (x < 0.78) return 3;
  if (x < 0.93) return 4;
  return 5;
}

const usedNames = new Set<string>();

function uniqueName(): { first: string; last: string; full: string } {
  for (;;) {
    const first = pick(FIRST_NAMES);
    const last = pick(LAST_NAMES);
    const full = `${first} ${last}`;
    if (usedNames.has(full)) continue;
    usedNames.add(full);
    return { first, last, full };
  }
}

function makeContact(overrides: Partial<NewContact> = {}): NewContact {
  const { first, last, full } = uniqueName();
  // Baseline recency: mostly 0–200 days ago, a few never-contacted (null).
  const lastInteractionAt = rand() < 0.06 ? null : daysAgoDate(randInt(0, 200));
  // Baseline follow-up: mostly none, some scheduled in the future.
  const nextFollowUpAt = rand() < 0.25 ? daysAheadDate(randInt(3, 60)) : null;
  return {
    userId: DEMO_USER,
    fullName: full,
    firstName: first,
    lastName: last,
    title: pick(TITLES),
    relationshipScore: weightedRelationshipScore(),
    source: "seed",
    lastInteractionAt,
    nextFollowUpAt,
    ...overrides,
  };
}

async function main() {
  const db = await getDb();

  // Idempotent-ish reset: deleting contacts cascades contact_tags (and
  // interactions/reminders/embeddings); deleting tags cascades leftover joins.
  await db.delete(contacts).where(eq(contacts.userId, DEMO_USER));
  await db.delete(tags).where(eq(tags.userId, DEMO_USER));

  const rows: NewContact[] = [];
  const clusterIndexes = new Map<string, number[]>();
  const addRow = (cluster: string, row: NewContact) => {
    rows.push(row);
    const list = clusterIndexes.get(cluster) ?? [];
    list.push(rows.length - 1);
    clusterIndexes.set(cluster, list);
  };

  // 1) Company clusters (98 contacts, exact sizes).
  for (const { name, size } of COMPANIES) {
    for (let i = 0; i < size; i++) {
      addRow(name, makeContact({ company: name }));
    }
  }

  // Company + school overlap (school clusters mixing into company clusters).
  rows[clusterIndexes.get("AWS")![0]].school = "MIT";
  rows[clusterIndexes.get("Google")![0]].school = "Stanford";
  rows[clusterIndexes.get("Stripe")![0]].school = "MIT";

  // 2) School-only members (no company) — 2 per school.
  for (const school of SCHOOLS) {
    for (let i = 0; i < 2; i++) {
      addRow(`school:${school}`, makeContact({ school }));
    }
  }

  // 3) Deep Space: 12 singletons — 7 with one-off employers, 5 unaffiliated.
  for (const name of FRINGE_COMPANIES) {
    addRow("deep-space", makeContact({ company: name }));
  }
  for (let i = 0; i < 5; i++) {
    addRow("deep-space", makeContact());
  }

  // 4) Dormant comets: 10 contacts last touched 400–600 days ago,
  //    spread across clusters (threshold in src/lib/comet.ts is 365 days).
  const dormantPicks: Array<[string, number]> = [
    ["AWS", 3],
    ["AWS", 7],
    ["Google", 2],
    ["Google", 9],
    ["Stripe", 4],
    ["OpenAI", 5],
    ["Meta", 1],
    ["Vercel", 2],
    ["school:MIT", 1],
    ["deep-space", 3],
  ];
  for (const [cluster, member] of dormantPicks) {
    const row = rows[clusterIndexes.get(cluster)![member]];
    row.lastInteractionAt = daysAgoDate(randInt(400, 600));
  }

  // 5) Overdue follow-ups: 8 contacts with nextFollowUpAt in the past,
  //    including 2 in the biggest company. Disjoint from the dormant picks.
  const overduePicks: Array<[string, number]> = [
    ["AWS", 1],
    ["AWS", 5],
    ["Google", 4],
    ["Stripe", 2],
    ["OpenAI", 0],
    ["Anthropic", 1],
    ["school:MIT", 0],
    ["deep-space", 6],
  ];
  for (const [cluster, member] of overduePicks) {
    const row = rows[clusterIndexes.get(cluster)![member]];
    row.nextFollowUpAt = daysAgoDate(randInt(3, 45));
  }

  // Bare .returning() — the Db union (neon | pglite) rejects selection args.
  const insertedContacts = await db.insert(contacts).values(rows).returning();
  const idByName = new Map(insertedContacts.map((c) => [c.fullName, c.id]));

  // 6) Tags: 4 per-user tags, ~20 contacts tagged via the contact_tags join.
  const insertedTags = await db
    .insert(tags)
    .values(TAG_NAMES.map((name) => ({ userId: DEMO_USER, name })))
    .returning();

  const taggedIndexes = new Set<number>();
  while (taggedIndexes.size < 20) {
    taggedIndexes.add(randInt(0, rows.length - 1));
  }
  const tagLinks: Array<{ contactId: string; tagId: string }> = [];
  for (const index of taggedIndexes) {
    const contactId = idByName.get(rows[index].fullName)!;
    const first = randInt(0, insertedTags.length - 1);
    tagLinks.push({ contactId, tagId: insertedTags[first].id });
    if (rand() < 0.35) {
      const second = (first + 1 + randInt(0, insertedTags.length - 2)) %
        insertedTags.length;
      tagLinks.push({ contactId, tagId: insertedTags[second].id });
    }
  }
  await db.insert(contactTags).values(tagLinks);

  // Summary
  console.log(`Seeded ${rows.length} contacts for ${DEMO_USER}`);
  for (const { name, size } of COMPANIES) {
    console.log(`  ${name.padEnd(12)} ${size}`);
  }
  for (const school of SCHOOLS) {
    const total = rows.filter((r) => r.school === school).length;
    console.log(`  ${`${school} (school)`.padEnd(12)} ${total}`);
  }
  console.log(`  ${"Deep Space".padEnd(12)} ${clusterIndexes.get("deep-space")!.length}`);
  console.log(
    `  dormant ${dormantPicks.length} · overdue ${overduePicks.length} · ` +
      `tagged ${taggedIndexes.size} (${tagLinks.length} links)`
  );

  // PGlite keeps the event loop alive — exit explicitly so the script
  // doesn't hang after the final insert.
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
