/**
 * What Vercel builds cost: queue wait, build time, failures, and where one build's seconds go.
 *
 *   node scripts/dev/vercel-build-report.mjs --project prj_… --team team_… [--limit 100] [--logs 20]
 *
 * `--project` / `--team` fall back to VERCEL_PROJECT_ID / VERCEL_ORG_ID. Reads the REST API
 * through the logged-in CLI (`vercel api`, a GET each); nothing is written.
 *
 * Three views, so a change to the build can be judged by numbers rather than by feel:
 *   1. per target and state: queue wait (created -> building) and build time (building -> ready)
 *   2. why the ERROR builds died, bucketed from their logs
 *   3. phase times from the logs of the newest `--logs` READY builds
 *
 * Hobby runs one build at a time, so queue wait is the price of everyone else's builds, and
 * build time is what you charge everyone else. Run it before a build change and again after ~10 deploys.
 */
import { execFileSync } from "node:child_process";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
};
const project = arg("--project", process.env.VERCEL_PROJECT_ID);
const team = arg("--team", process.env.VERCEL_ORG_ID);
const limit = Number(arg("--limit", 100));
const logCount = Number(arg("--logs", 20));
if (!project || !team) {
  console.error("usage: vercel-build-report.mjs --project prj_… --team team_… [--limit 100] [--logs 20]");
  process.exit(2);
}

const api = (path) =>
  JSON.parse(execFileSync("vercel", ["api", "-X", "GET", path, "--raw"], { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 }));
const events = (id) =>
  api(`/v3/deployments/${id}/events?teamId=${team}&limit=-1&builds=1`).sort(
    (a, b) => a.created - b.created || String(a.serial).localeCompare(String(b.serial))
  );

const sorted = (xs) => xs.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b);
const pct = (xs, p) => xs[Math.min(xs.length - 1, Math.floor(p * xs.length))];
const fmt = (xs) => {
  const s = sorted(xs);
  return s.length
    ? `n=${String(s.length).padStart(3)}  p50=${pct(s, 0.5).toFixed(0).padStart(5)}s  p90=${pct(s, 0.9).toFixed(0).padStart(5)}s  max=${s[s.length - 1].toFixed(0).padStart(5)}s`
    : "n=  0";
};
const seconds = (m) => (m ? Number(m[1]) * { ms: 0.001, s: 1, min: 60 }[m[2] ?? "s"] : null);

const deployments = api(`/v6/deployments?projectId=${project}&teamId=${team}&limit=${limit}`).deployments;
const iso = (ms) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
console.log(`${deployments.length} deployments, ${iso(deployments.at(-1).created)} -> ${iso(deployments[0].created)} UTC\n`);

console.log("QUEUE WAIT and BUILD TIME by target and state");
for (const target of ["production", "preview"]) {
  for (const state of ["READY", "ERROR", "CANCELED"]) {
    const rows = deployments.filter((d) => (d.target ?? "preview") === target && d.state === state);
    if (!rows.length) continue;
    const built = rows.filter((d) => d.buildingAt && d.ready);
    console.log(`  ${target.padEnd(10)} ${state.padEnd(8)} ${String(rows.length).padStart(3)} deploys`);
    console.log(`      queue ${fmt(built.map((d) => (d.buildingAt - d.created) / 1000))}`);
    console.log(`      build ${fmt(built.map((d) => (d.ready - d.buildingAt) / 1000))}`);
  }
}

console.log("\nWHY BUILDS FAILED");
const causes = new Map();
for (const d of deployments.filter((x) => x.state === "ERROR")) {
  const text = events(d.uid)
    .map((e) => e.text ?? "")
    .join("\n");
  const cause = /declares things the DDL never creates/.test(text)
    ? "db:migrate coverage (schema.ts vs DDL)"
    : /check-env: \d+ error/.test(text)
      ? "check:env"
      : /Turbopack build failed|TurbopackInternalError/.test(text)
        ? "Turbopack compile"
        : /error TS\d+|Type error/.test(text)
          ? "type error"
          : "other";
  causes.set(cause, (causes.get(cause) ?? 0) + 1);
}
for (const [cause, n] of [...causes].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${cause}`);
if (!causes.size) console.log("  none");

console.log(`\nPHASES, newest ${logCount} READY builds (seconds)`);
const empty = () => ({ "npm ci": [], "turbopack compile": [], "sentry upload": [], typescript: [], "start -> deployed": [] });
const byTarget = { production: empty(), preview: empty() };
for (const d of deployments.filter((x) => x.state === "READY").slice(0, logCount)) {
  const ev = events(d.uid);
  const text = ev.map((e) => e.text ?? "").join("\n");
  const bucket = byTarget[d.target ?? "preview"] ?? byTarget.preview;
  const done = ev.find((e) => /Deployment completed/.test(e.text ?? ""));
  bucket["npm ci"].push(seconds(text.match(/added \d+ packages in (\d+(?:\.\d+)?)(s|ms|min)/)));
  bucket["turbopack compile"].push(seconds(text.match(/Compiled successfully in (\d+(?:\.\d+)?)(s|ms|min)/)));
  bucket["sentry upload"].push(seconds(text.match(/Completed runAfterProductionCompile in (\d+(?:\.\d+)?)(s|ms|min)/)));
  bucket.typescript.push(seconds(text.match(/Finished TypeScript in (\d+(?:\.\d+)?)(s|ms|min)/)));
  bucket["start -> deployed"].push(done ? (done.created - ev[0].created) / 1000 : null);
}
for (const [target, rows] of Object.entries(byTarget)) {
  console.log(`  ${target}`);
  for (const [phase, xs] of Object.entries(rows)) console.log(`      ${phase.padEnd(18)} ${fmt(xs)}`);
}
