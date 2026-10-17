// Simulated app traffic against a LOCAL scratch database while something else (a migration,
// a restore) runs. Issues the app's shapes of contact search (search_tsv and trigram) and
// contact writes in a loop and records per-second worst latency and errors.
//
//   PGPASSWORD=... node reliability/lib/traffic-probe.mjs orbit_rel results/probe.json
// Stops on SIGTERM/SIGINT and writes the summary.
import fs from "node:fs";
import pg from "pg";

const database = process.argv[2] ?? "orbit_rel";
const out = process.argv[3] ?? "reliability/results/traffic-probe.json";
const pool = new pg.Pool({ host: "127.0.0.1", user: "orbit", password: process.env.PGPASSWORD, database, max: 6 });

const SHAPES = {
  // hybrid-search keyword arm: search_tsv
  search: (u) => [
    `SELECT id FROM contacts WHERE user_id = $1 AND search_tsv @@ plainto_tsquery('simple', $2) LIMIT 20`,
    [`rel-${u}`, "acme engineer"],
  ],
  // fuzzy name arm: lower(full_name) trigram
  fuzzy: (u) => [
    `SELECT id FROM contacts WHERE user_id = $1 AND lower(full_name) % $2 LIMIT 20`,
    [`rel-${u}`, "person 12-34"],
  ],
  // contact edit
  write: (u) => [
    `UPDATE contacts SET updated_at = now() WHERE id = (SELECT id FROM contacts WHERE user_id = $1 LIMIT 1)`,
    [`rel-${u}`],
  ],
};

const t0 = Date.now();
const seconds = new Map(); // second -> {n, maxMs, errors:{}}
let running = true;

async function worker(kind) {
  while (running) {
    const u = 1 + Math.floor(Math.random() * 300);
    const [text, values] = SHAPES[kind](u);
    const start = Date.now();
    let err = null;
    try {
      await pool.query({ text, values });
    } catch (e) {
      err = `${kind}: ${e.code ?? ""} ${String(e.message).slice(0, 80)}`;
    }
    const sec = Math.floor((start - t0) / 1000);
    const s = seconds.get(sec) ?? { n: 0, maxMs: 0, maxKind: "", errors: {} };
    s.n++;
    const ms = Date.now() - start;
    if (ms > s.maxMs) { s.maxMs = ms; s.maxKind = kind; }
    if (err) s.errors[err] = (s.errors[err] ?? 0) + 1;
    seconds.set(sec, s);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const workers = [worker("search"), worker("search"), worker("fuzzy"), worker("write"), worker("write")];

function finish() {
  running = false;
  Promise.allSettled(workers).then(async () => {
    await pool.end();
    const rows = [...seconds.entries()].sort((a, b) => a[0] - b[0]);
    const errors = {};
    let worst = { ms: 0, kind: "", at: 0 };
    let slowSeconds = 0;
    for (const [sec, s] of rows) {
      for (const [k, v] of Object.entries(s.errors)) errors[k] = (errors[k] ?? 0) + v;
      if (s.maxMs > worst.ms) worst = { ms: s.maxMs, kind: s.maxKind, at: sec };
      if (s.maxMs > 1000) slowSeconds++;
    }
    const summary = {
      database,
      durationSec: rows.length,
      requests: rows.reduce((n, [, s]) => n + s.n, 0),
      worstLatencyMs: worst.ms,
      worstKind: worst.kind,
      worstAtSec: worst.at,
      secondsWithARequestOver1s: slowSeconds,
      errors,
      timeline: rows.map(([sec, s]) => ({ sec, n: s.n, maxMs: s.maxMs, errors: Object.keys(s.errors).length })),
    };
    fs.writeFileSync(out, JSON.stringify(summary, null, 2));
    const { timeline, ...head } = summary;
    console.log(JSON.stringify(head, null, 2));
    process.exit(0);
  });
}
process.on("SIGTERM", finish);
process.on("SIGINT", finish);
