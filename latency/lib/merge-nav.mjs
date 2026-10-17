/**
 * Replace one profile's client-side navigation results in a pages-<tier>.json with those of
 * a nav-only rerun (`pages.mjs --only=nav --profile=<p>`), keeping the page loads as measured.
 *
 *   node latency/lib/merge-nav.mjs latency/results/x/pages-5000.json latency/results/x/pages-nav-5000.json mobile4g
 */
import { readFileSync, writeFileSync } from "node:fs";
const [target, source, profile] = process.argv.slice(2);
const t = JSON.parse(readFileSync(target, "utf8"));
const s = JSON.parse(readFileSync(source, "utf8"));
const from = s.results?.[profile];
if (!from) throw new Error(`${source} has no ${profile} results`);
t.results[profile] ??= { profile, pages: {}, nav: [], history: {} };
t.results[profile].nav = from.nav;
t.results[profile].history = from.history;
t.results[profile].nav_rerun_at = s.at;
writeFileSync(target, JSON.stringify(t, null, 2));
console.log(`merged ${profile} nav/history from ${source} into ${target}`);
