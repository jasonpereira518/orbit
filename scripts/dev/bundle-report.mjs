/**
 * Per-route weight of a finished `next build`: the client JS a first load of the route
 * fetches (its entry chunks, raw and gzipped), the fonts it preloads, and the server JS the
 * route's function traces (what a cold start has to load and evaluate).
 *
 *   npx next build && node scripts/dev/bundle-report.mjs [--json out.json]
 *
 * Reads Turbopack's per-page manifests under `.next/server/app`. Lazy chunks
 * (`next/dynamic`, `import()`) are deliberately excluded from "first load" — moving code
 * behind one is exactly what should make this number fall.
 */
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join, dirname } from "node:path";

const NEXT = ".next";
const APP = join(NEXT, "server", "app");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith("_client-reference-manifest.js")) out.push(p);
  }
  return out;
}

const sizeCache = new Map();
function sizes(file) {
  if (!sizeCache.has(file)) {
    const buf = readFileSync(file);
    sizeCache.set(file, { raw: buf.length, gz: gzipSync(buf).length });
  }
  return sizeCache.get(file);
}

const rows = [];
for (const manifestPath of walk(APP)) {
  const src = readFileSync(manifestPath, "utf8");
  const sandbox = { globalThis: {} };
  new Function("globalThis", src)(sandbox.globalThis);
  const [[route, manifest]] = Object.entries(sandbox.globalThis.__RSC_MANIFEST);
  if (!route.endsWith("/page")) continue;

  const chunks = new Set();
  for (const list of Object.values(manifest.entryJSFiles ?? {})) for (const c of list) chunks.add(c);
  let raw = 0;
  let gz = 0;
  for (const c of chunks) {
    const f = join(NEXT, c.replace(/^\/_next\//, ""));
    if (!existsSync(f)) continue;
    const s = sizes(f);
    raw += s.raw;
    gz += s.gz;
  }

  const base = manifestPath.replace(/_client-reference-manifest\.js$/, "");
  let fontBytes = 0;
  let fonts = 0;
  const fontManifest = join(base, "next-font-manifest.json");
  if (existsSync(fontManifest)) {
    const fm = JSON.parse(readFileSync(fontManifest, "utf8"));
    for (const list of Object.values(fm.app ?? {})) {
      for (const f of list) {
        fonts++;
        fontBytes += statSync(join(NEXT, f)).size;
      }
    }
  }

  let serverBytes = 0;
  const nft = `${base}.js.nft.json`;
  if (existsSync(nft)) {
    const { files } = JSON.parse(readFileSync(nft, "utf8"));
    for (const f of files) {
      const p = join(dirname(nft), f);
      // Only the app's own compiled server chunks: node_modules traced for the function are
      // a deploy-size concern, not something every cold start evaluates.
      if (p.includes(`${NEXT}/server/`) && p.endsWith(".js") && existsSync(p)) serverBytes += statSync(p).size;
    }
    serverBytes += statSync(`${base}.js`).size;
  }

  rows.push({
    route: route.replace(/\/page$/, "").replace(/\/\([^)]+\)/g, "") || "/",
    js_kb: Math.round(raw / 1024),
    js_gz_kb: Math.round(gz / 1024),
    fonts,
    font_kb: Math.round(fontBytes / 1024),
    server_kb: Math.round(serverBytes / 1024),
  });
}

// API routes have no client side; what matters for them is the server JS a cold start loads.
function walkRoutes(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkRoutes(p, out);
    else if (name === "route.js") out.push(p);
  }
  return out;
}
for (const routeJs of walkRoutes(APP)) {
  const nft = `${routeJs}.nft.json`;
  let serverBytes = statSync(routeJs).size;
  if (existsSync(nft)) {
    const { files } = JSON.parse(readFileSync(nft, "utf8"));
    for (const f of files) {
      const p = join(dirname(nft), f);
      if (p.includes(`${NEXT}/server/`) && p.endsWith(".js") && existsSync(p)) serverBytes += statSync(p).size;
    }
  }
  const route = routeJs.slice(APP.length).replace(/\/route\.js$/, "").replace(/\/\([^)]+\)/g, "");
  if (!route.startsWith("/api/")) continue;
  rows.push({ route, js_kb: 0, js_gz_kb: 0, fonts: 0, font_kb: 0, server_kb: Math.round(serverBytes / 1024) });
}

rows.sort((a, b) => a.route.localeCompare(b.route));
console.table(rows);
const i = process.argv.indexOf("--json");
if (i > 0) writeFileSync(process.argv[i + 1], JSON.stringify(rows, null, 2));
