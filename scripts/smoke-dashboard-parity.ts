/**
 * The dashboard's whole-network questions, asked of Postgres (`src/lib/dashboard-network.ts`),
 * must get the answers the in-memory version computed from every contact, score and tally:
 *
 *   - who the constellation may draw — `constellationEligibility` over the cohort's signals;
 *   - the cluster counts — `clusterCountsOf` over every contact;
 *   - which contacts the preview draws, in what order;
 *   - the metrics sample — `selectMetricsSample`;
 *   - the orbit-score histogram and the absolute-tier counts.
 *
 * Each is checked against that JavaScript, run over a full load of the same account, on a
 * network built to exercise the predicate and the tie-breaks: pins both ways, notes, every
 * kind of touch (AI-derived ones that must not count), user and import-source tags, stated
 * closeness, priority, company spellings that collapse to one cluster, industries that
 * differ only in case and spacing, unscored contacts, and more contacts than the sample cap.
 * Then again with other thresholds and with the filter off.
 *
 * Runs against a throwaway PGlite. Run: npx tsx scripts/smoke-dashboard-parity.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { eq, sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import { contacts, contactTags, interactions, tags } from "../src/db/schema";
import { getClosenessCohortSlim, recalibrateCloseness } from "../src/lib/closeness-cohort";
import { closenessTier } from "../src/lib/closeness";
import { clusterCountsFromTallies, clusterCountsOf, clusterRefFor } from "../src/lib/constellation-clusters";
import { constellationEligibility, DEFAULT_CONSTELLATION_THRESHOLDS, IMPORT_SOURCE_TAGS, type ConstellationThresholds } from "../src/lib/constellation-eligibility";
import { loadChartContacts, loadChartGroups, loadClusterTallies, loadMetricsSample, loadScoreDistribution } from "../src/lib/dashboard-network";
import { selectMetricsSample } from "../src/lib/network-metrics";
import { ensureUserSettings } from "../src/lib/user-settings";
import { scaleContactRows } from "./lib/scale-fixture";

const USER = "smoke-dashboard-parity-user";
const N = 900;
const PREVIEW_CAP = 150;

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

async function seed() {
  const db = await getDb();
  await db.delete(tags).where(eq(tags.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await ensureUserSettings(USER);
  const rows = scaleContactRows(USER, N, {});
  for (let start = 0; start < rows.length; start += 300) await db.insert(contacts).values(rows.slice(start, start + 300));

  await db.execute(sql`
    WITH numbered AS (SELECT id, row_number() OVER (ORDER BY full_name, id) AS n FROM contacts WHERE user_id = ${USER})
    UPDATE contacts c SET
      company = CASE n % 23 WHEN 0 THEN 'ACME, Inc.' WHEN 1 THEN '  acme  ' WHEN 2 THEN 'Amazon Web Services' WHEN 3 THEN 'AWS' WHEN 4 THEN 'Solo Co ' || n ELSE c.company END,
      industry = CASE n % 7 WHEN 0 THEN 'Public Health' WHEN 1 THEN 'public  health' WHEN 2 THEN ' Fintech' WHEN 3 THEN 'FINTECH' ELSE NULL END,
      school = CASE WHEN n % 19 = 0 THEN ' MIT ' ELSE c.school END,
      constellation_pin = CASE WHEN n % 31 = 0 THEN 'in' WHEN n % 37 = 0 THEN 'out' ELSE NULL END,
      notes = CASE WHEN n % 29 = 0 THEN 'met at the summit' WHEN n % 41 = 0 THEN '   ' ELSE c.notes END,
      stated_closeness = CASE WHEN n % 43 = 0 THEN 4 ELSE NULL END,
      priority_level = CASE WHEN n % 47 = 0 THEN 2 ELSE 0 END,
      next_follow_up_at = CASE WHEN n % 53 = 0 THEN now() + interval '3 days' ELSE NULL END,
      updated_at = CASE WHEN n % 5 = 0 THEN timestamptz '2026-06-01T00:00:00Z' ELSE c.updated_at END
    FROM numbered WHERE c.id = numbered.id
  `);

  // Touches of every kind the predicate reads, and AI-derived ones that must not count.
  await db.execute(sql`
    WITH numbered AS (SELECT id, row_number() OVER (ORDER BY full_name, id) AS n FROM contacts WHERE user_id = ${USER}),
    plan AS (
      SELECT id, n, k FROM numbered, generate_series(1, 6) AS k WHERE n % 3 = 0 AND k <= 1 + n % 6
    )
    INSERT INTO ${interactions} (user_id, contact_id, interaction_type, interaction_date, direction, source)
    SELECT ${USER}, id,
      CASE (n + k) % 6 WHEN 0 THEN 'note' WHEN 1 THEN 'meeting' WHEN 2 THEN 'email' WHEN 3 THEN 'linkedin_message' WHEN 4 THEN 'message' ELSE 'call' END,
      now() - (k || ' days')::interval,
      CASE (n + k) % 3 WHEN 0 THEN 'in' WHEN 1 THEN 'out' ELSE NULL END,
      CASE WHEN n % 9 = 0 THEN 'ai_derived' ELSE NULL END
    FROM plan
  `);

  const [userTag] = await db.insert(tags).values({ userId: USER, name: "investor" }).returning();
  const [sourceTag] = await db.insert(tags).values({ userId: USER, name: ` ${IMPORT_SOURCE_TAGS[0].toUpperCase()} ` }).returning();
  const ids = rowsOf<{ id: string; n: number }>(await db.execute(sql`SELECT id, row_number() OVER (ORDER BY full_name, id)::int AS n FROM contacts WHERE user_id = ${USER}`));
  const links = ids.flatMap(({ id, n }) => [
    ...(n % 11 === 0 ? [{ contactId: id, tagId: userTag.id }] : []),
    ...(n % 4 === 0 ? [{ contactId: id, tagId: sourceTag.id }] : []),
  ]);
  for (let start = 0; start < links.length; start += 300) await db.insert(contactTags).values(links.slice(start, start + 300));

  await recalibrateCloseness(USER);
  // A few contacts the cohort holds no score for.
  await db.execute(sql`UPDATE contacts SET closeness_breakdown = NULL WHERE id IN (SELECT id FROM contacts WHERE user_id = ${USER} ORDER BY id LIMIT 7)`);
}

/** The in-memory version: every contact, every score, every tally. */
async function reference(thresholds: ConstellationThresholds, filterActive: boolean) {
  const db = await getDb();
  const all = rowsOf<{
    id: string; company: string | null; school: string | null; industry: string | null; constellation_pin: "in" | "out" | null;
    has_notes: boolean; stated_closeness: number | null; priority_level: number; next_follow_up_at: Date | null;
  }>(await db.execute(sql`
    SELECT id, company, school, industry, constellation_pin, (notes IS NOT NULL AND btrim(notes) <> '') AS has_notes,
           stated_closeness, priority_level, next_follow_up_at
      FROM contacts WHERE user_id = ${USER} ORDER BY updated_at DESC, id DESC`));
  const tagCounts = new Map(rowsOf<{ contact_id: string; n: number }>(await db.execute(sql`
    SELECT ct.contact_id, count(*)::int AS n FROM contact_tags ct JOIN contacts c ON c.id = ct.contact_id JOIN tags t ON t.id = ct.tag_id
     WHERE c.user_id = ${USER} AND lower(trim(t.name)) NOT IN (${sql.join(IMPORT_SOURCE_TAGS.map((t) => sql`${t}`), sql`, `)})
     GROUP BY ct.contact_id`)).map((r) => [r.contact_id, Number(r.n)]));
  const cohort = await getClosenessCohortSlim(USER);
  const eligible = all.filter((c) => constellationEligibility(cohort.constellationSignals.get(c.id), {
    pin: c.constellation_pin, hasNotesText: Boolean(c.has_notes), statedCloseness: c.stated_closeness,
    priorityLevel: c.priority_level ?? 0, nextFollowUpAt: c.next_follow_up_at, userTagCount: tagCounts.get(c.id) ?? 0,
  }, thresholds).eligible);
  const counts = clusterCountsOf(all);
  const shown = filterActive ? eligible : all;
  const refs = new Map(shown.map((c) => [c.id, clusterRefFor(c, counts)]));
  const perCluster = new Map<string, number>();
  for (const c of shown) { const r = refs.get(c.id)!; if (r.kind !== "other") perCluster.set(r.id, (perCluster.get(r.id) ?? 0) + 1); }
  const visible = shown.filter((c) => (perCluster.get(refs.get(c.id)!.id) ?? 0) >= 2);
  const orbit = (id: string) => cohort.byId.get(id)?.orbitScore ?? 2;
  const preview = (visible.length > PREVIEW_CAP ? [...visible].sort((a, b) => orbit(b.id) - orbit(a.id)).slice(0, PREVIEW_CAP) : visible).map((c) => c.id);
  const scoreCounts: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const c of all) { const s = Math.min(5, Math.max(1, orbit(c.id) || 2)); scoreCounts[s] = (scoreCounts[s] || 0) + 1; }
  const tierCounts = { inner: 0, mid: 0, outer: 0 };
  for (const b of cohort.byId.values()) tierCounts[closenessTier(b.raw)] += 1;
  return {
    eligibleCount: eligible.length, counts, preview, visibleCount: visible.length,
    sample: selectMetricsSample(all, cohort.byId).map((c) => c.id), scoreCounts, tierCounts,
  };
}

async function compare(label: string, thresholds: ConstellationThresholds, filterActive: boolean) {
  console.log(`\n${label}`);
  const want = await reference(thresholds, filterActive);
  const opts = { thresholds, filterActive };
  const groups = await loadChartGroups(USER, opts);
  const counts = clusterCountsFromTallies(await loadClusterTallies(USER));
  check("eligible count", groups.reduce((s, g) => s + g.eligible, 0) === want.eligibleCount, `${want.eligibleCount} expected`);
  // Same entries; the order a Map was filled in is not part of the answer.
  const sorted = (m: Map<string, unknown>) => [...m].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const keys = ["company", "school", "industry", "industryLabel"] as const;
  const wrong = keys.filter((k) => !same(sorted(counts[k]), sorted(want.counts[k])));
  check("cluster counts and industry labels", wrong.length === 0, wrong.join(", "));
  const refs = groups.map((g) => ({ g, r: clusterRefFor(g, counts) }));
  const per = new Map<string, number>();
  for (const { g, r } of refs) if (r.kind !== "other") per.set(r.id, (per.get(r.id) ?? 0) + g.n);
  const visible = refs.filter(({ r }) => (per.get(r.id) ?? 0) >= 2).map(({ g }) => g);
  const visibleCount = visible.reduce((s, g) => s + g.n, 0);
  check("visible count", visibleCount === want.visibleCount, `${visibleCount} vs ${want.visibleCount}`);
  const preview = await loadChartContacts(USER, { ...opts, groups: visible, limit: PREVIEW_CAP, byOrbitScore: visibleCount > PREVIEW_CAP });
  check("preview: same contacts, same order", same(preview.map((c) => c.id), want.preview), `${preview.length} vs ${want.preview.length}`);
  check("metrics sample: same contacts, same order", same((await loadMetricsSample(USER)).map((c) => c.id), want.sample));
  const dist = await loadScoreDistribution(USER);
  check("orbit-score histogram", same(dist.scoreCounts, want.scoreCounts), JSON.stringify([dist.scoreCounts, want.scoreCounts]));
  check("absolute-tier counts", same(dist.tierCounts, want.tierCounts), JSON.stringify([dist.tierCounts, want.tierCounts]));
  return want;
}

run(async () => {
  await seed();
  const base = await compare("Default thresholds, filter on", DEFAULT_CONSTELLATION_THRESHOLDS, true);
  check("the fixture is past the sample cap and the preview cap", base.sample.length === 750 && base.visibleCount > PREVIEW_CAP,
    `${base.sample.length} sampled, ${base.visibleCount} visible`);
  check("and the filter leaves some out", base.eligibleCount > 0 && base.eligibleCount < N, String(base.eligibleCount));
  await compare("Thresholds 1 and 2", { minInbound: 1, minOutbound: 2 }, true);
  await compare("Filter off", DEFAULT_CONSTELLATION_THRESHOLDS, false);
  if (failures) throw new Error(`${failures} check(s) failed`);
  console.log("\nDashboard parity checks passed.");
});
