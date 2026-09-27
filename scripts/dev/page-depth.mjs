/**
 * How long each app page takes to render on the server, and therefore roughly how many
 * database round trips sit on its critical path.
 *
 * Run it against a production build started with simulated database latency, e.g.
 *
 *   ORBIT_SIM_DB_LATENCY_MS=50 next start -p 3057     (demo mode; see src/db/index.ts)
 *   node scripts/dev/page-depth.mjs http://localhost:3057 --latency=50
 *
 * Per route it reports the median of several full-document fetches:
 *   ttfb  — when the shell (layouts + everything outside a Suspense boundary) flushed
 *   total — when the last streamed boundary resolved, i.e. the page was complete
 *   depth — total / latency: sequential round trips, give or take CPU time
 *
 * A soft navigation skips the shared layouts, so it costs a little less than `total`; the
 * ordering between pages, and the before/after of a change, is what this is for.
 */
const args = process.argv.slice(2);
const BASE = args.find((a) => !a.startsWith("--")) ?? "http://localhost:3057";
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split("=")[1]) : fallback;
};
const LATENCY = flag("latency", 50);
const RUNS = flag("runs", 5);

const ONLY = args.find((a) => a.startsWith("--only="))?.split("=")[1]?.split(",");
const ROUTES = [
  "/dashboard",
  "/contacts",
  "/reminders",
  "/capture",
  "/chat",
  "/graph",
  "/imports",
  "/knowledge",
  "/recruiters",
  "/settings",
];

async function timeOnce(url) {
  const started = performance.now();
  const res = await fetch(url, { redirect: "manual" });
  const reader = res.body.getReader();
  let ttfb = null;
  for (;;) {
    const { done } = await reader.read();
    if (ttfb === null) ttfb = performance.now() - started;
    if (done) break;
  }
  return { status: res.status, ttfb, total: performance.now() - started };
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

// A contact detail page, found from the list, so the heaviest dynamic route is included.
const list = await (await fetch(`${BASE}/contacts`)).text();
// The list's rows are rendered client-side, so the ids are in the flight data, not in hrefs.
const contactId = list.match(
  /initialItems\\?":\[\{\\?"id\\?":\\?"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/
)?.[1];
const contactHref = contactId ? `/contacts/${contactId}` : null;
if (contactHref) ROUTES.push(contactHref);
if (ONLY) ROUTES.splice(0, ROUTES.length, ...ROUTES.filter((r) => ONLY.some((o) => r.startsWith(o))));

const rows = [];
for (const route of ROUTES) {
  await timeOnce(`${BASE}${route}`); // warm: the first hit compiles nothing, but fills caches
  const runs = [];
  for (let i = 0; i < RUNS; i++) runs.push(await timeOnce(`${BASE}${route}`));
  const ttfb = median(runs.map((r) => r.ttfb));
  const total = median(runs.map((r) => r.total));
  rows.push({
    route: route.startsWith("/contacts/") ? "/contacts/[id]" : route,
    status: runs[0].status,
    ttfb_ms: Math.round(ttfb),
    total_ms: Math.round(total),
    depth: Math.round((total / LATENCY) * 10) / 10,
  });
}
console.table(rows);
process.exit(0);
