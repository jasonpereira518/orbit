/**
 * Merge a partial pages rerun (`pages.mjs --only=...`) into a full pages-<tier>.json: every
 * page the rerun measured replaces that page's entry, and a rerun that ran the nav tour
 * replaces nav/history, per profile. Page loads the rerun did not cover are kept.
 *
 *   node latency/lib/merge-pages.mjs latency/results/x/pages-5000.json latency/results/x/pages-rerun-5000.json
 */
import { readFileSync, writeFileSync } from "node:fs";
const [target, source] = process.argv.slice(2);
const t = JSON.parse(readFileSync(target, "utf8"));
const s = JSON.parse(readFileSync(source, "utf8"));
for (const [profile, from] of Object.entries(s.results ?? {})) {
  if (from.error && !Object.keys(from.pages ?? {}).length && !from.nav?.length) continue;
  const into = (t.results[profile] ??= { profile, pages: {}, nav: [], history: {} });
  for (const [page, v] of Object.entries(from.pages ?? {})) into.pages[page] = { ...v, rerun_at: s.at };
  if (from.nav?.length) { into.nav = from.nav; into.history = from.history; into.nav_rerun_at = s.at; }
  console.log(`${profile}: merged ${Object.keys(from.pages ?? {}).length} page(s)${from.nav?.length ? " + nav" : ""} into ${target}`);
}
if (s.contactPath && !t.contactPath) t.contactPath = s.contactPath;
writeFileSync(target, JSON.stringify(t, null, 2));
