/**
 * Serve the prerendered constellation bench page from a production build, and nothing else.
 *
 * `next start` cannot serve it locally: with no Clerk keys, `src/proxy.ts` answers every
 * production request with 503 by design, and weakening that guard for a benchmark would be
 * the wrong trade. The bench route is fully static (`○` in the build output), so its HTML plus
 * `/_next/static` is the whole page — the only server call it can make, the focus refetch,
 * 404s here and the chart keeps its synthetic payload.
 *
 *   ORBIT_BENCH=1 npx next build --profile && node scripts/bench/serve-static-bench.mjs [port]
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

// BENCH_NEXT_DIR serves another build (e.g. a baseline worktree's) from this same server code.
const root = process.env.BENCH_NEXT_DIR ?? join(import.meta.dirname, "../../.next");
const port = Number(process.argv[2] ?? process.env.PORT ?? 3417);
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
};

function send(res, file) {
  res.writeHead(200, {
    "content-type": TYPES[extname(file)] ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  createReadStream(file).pipe(res);
}

createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  // Any prerendered bench page: /bench/constellation, /bench/preview, /bench/preview-old.
  const bench = url.pathname.match(/^\/bench\/([a-z0-9-]+)$/);
  if (bench) {
    const page = join(root, "server/app/bench", `${bench[1]}.html`);
    if (existsSync(page)) return send(res, page);
  }
  // Network fixtures for `?data=fetch` (scripts/bench/constellation-fixtures.ts).
  const fixture = url.pathname.match(/^\/bench-data\/([a-z0-9-]+\.json)$/);
  if (fixture) {
    const file = join(import.meta.dirname, "../../.bench-data", fixture[1]);
    if (existsSync(file)) return send(res, file);
  }
  if (url.pathname.startsWith("/_next/static/")) {
    const rel = normalize(decodeURIComponent(url.pathname.slice("/_next/static/".length)));
    const file = join(root, "static", rel);
    if (!rel.startsWith("..") && existsSync(file) && statSync(file).isFile()) {
      return send(res, file);
    }
  }
  if (url.pathname.startsWith("/") && !url.pathname.includes("..")) {
    const pub = join(import.meta.dirname, "../../public", url.pathname);
    if (existsSync(pub) && statSync(pub).isFile()) return send(res, pub);
  }
  res.writeHead(404).end();
}).listen(port, () => console.log(`bench static server on http://localhost:${port}/bench/constellation`));
