/**
 * Contacts search, server side, at a given fixture size: the one-shot search the page used to
 * run, next to its two halves.
 *
 *   ORBIT_PGLITE_DIR=<copy of a seed-sizes.ts directory> ORBIT_SIM_DB_LATENCY_MS=20 \
 *     npx tsx scripts/dev/perf/contacts-search-bench.ts [--rounds=7] [--json=out.json]
 *
 *   one-shot     the frozen original (`scripts/lib/legacy-contacts-page.ts`): hybrid ranking
 *                awaited, widened WHERE, exact count — the first AND the last paint of the old page.
 *   first        `listContactsPage(…, { search: "lexical" })`: what the page paints.
 *   complete     the page as it now runs: the lexical page and `enrichContactsSearch` started
 *                together (the ranking beside the page query, as `contacts/page.tsx` does), timed
 *                to the moment BOTH are in — the list is then exactly what one-shot returned.
 *   enrich warm  the enrichment alone when the ranking is already cached (Back, a retype, or
 *                "load more" after it).
 *
 * Rounds are interleaved per query (one-shot, first, enrich, enrich warm) after a warm-up,
 * and the median is reported. Every round also asserts the final order and the exact total
 * equal the one-shot search's. Never against `.data/pglite`: pass a COPY of a seeded directory.
 * PGlite is single-writer and has no pgvector or embedding provider, so the semantic arm is
 * absent: the ranking here is fts + trigram + work history, i.e. a LOWER bound on the hybrid
 * cost the first paint no longer waits for.
 */
import { writeFileSync } from "node:fs";
import { closeDb } from "../../../src/db";
import { rankContacts, resetRankCache } from "../../../src/lib/contact-ranking";
import { enrichContactsSearch, listContactsPage } from "../../../src/lib/contacts-page-query";
import { resetSearchSampling } from "../../../src/lib/search-events";
import { legacyListContactsPage } from "../../lib/legacy-contacts-page";

const USER = "demo-user";
const args = process.argv.slice(2);
const flag = (n: string, d: string) => args.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
const ROUNDS = Number(flag("rounds", "7"));
const JSON_OUT = flag("json", "");
const QUERIES = ["sarah", "ai", "engineer at acme", "marcus", "zzzz-no-match"];

const median = (xs: number[]) => {
  const v = [...xs].sort((a, b) => a - b);
  return v.length % 2 ? v[v.length >> 1] : (v[(v.length >> 1) - 1] + v[v.length >> 1]) / 2;
};
async function time<T>(fn: () => Promise<T>): Promise<[number, T]> {
  const t0 = performance.now();
  const out = await fn();
  return [performance.now() - t0, out];
}

async function main() {
  const rows: Array<Record<string, number | string>> = [];
  // Warm the module graph, the WASM and the plans before measuring.
  await legacyListContactsPage(USER, { q: "warm", sort: "relevance", limit: 50 });
  await listContactsPage(USER, { q: "warm", sort: "relevance", limit: 50 }, { search: "lexical" });

  for (const q of QUERIES) {
    const f = { q, sort: "relevance" as const, limit: 50 };
    const s = { oneShot: [] as number[], first: [] as number[], complete: [] as number[], warm: [] as number[] };
    let total = 0;
    for (let r = 0; r < ROUNDS; r++) {
      resetRankCache();
      resetSearchSampling();
      const [tOne, one] = await time(() => legacyListContactsPage(USER, f, { rank: rankContacts }));
      resetRankCache();
      const t0 = performance.now();
      const pageP = listContactsPage(USER, f, { search: "lexical" });
      const enrP = enrichContactsSearch(USER, f, { have: pageP.then((p) => p.items.map((i) => i.id)) });
      const first = await pageP;
      const tFirst = performance.now() - t0;
      const enr = await enrP;
      const tComplete = performance.now() - t0;
      const [tWarm] = await time(() => enrichContactsSearch(USER, f, { have: first.items.map((i) => i.id) }));
      s.oneShot.push(tOne);
      s.first.push(tFirst);
      s.complete.push(tComplete);
      s.warm.push(tWarm);
      total = one.total ?? 0;
      const legacyIds = one.items.map((i) => i.id);
      const newIds = enr?.order ?? first.items.map((i) => i.id);
      if (enr && enr.total !== one.total) throw new Error(`total drift for "${q}": ${enr.total} vs ${one.total}`);
      if (JSON.stringify(legacyIds) !== JSON.stringify(newIds)) throw new Error(`order drift for "${q}"`);
    }
    rows.push({
      query: q,
      matches: total,
      "one-shot ms": Math.round(median(s.oneShot)),
      "first ms": Math.round(median(s.first)),
      "complete ms": Math.round(median(s.complete)),
      "enrich warm ms": Math.round(median(s.warm)),
    });
  }
  console.table(rows);
  if (JSON_OUT) {
    writeFileSync(JSON_OUT, JSON.stringify({ latencyMs: Number(process.env.ORBIT_SIM_DB_LATENCY_MS || 0), rounds: ROUNDS, rows }, null, 2));
  }
  await closeDb();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
