/**
 * What a cold start costs each route of a finished `next build`, before any I/O.
 *
 *   npx next build && node scripts/dev/cold-start-report.mjs [--runs 5] [--filter dashboard] [--json out.json]
 *
 * For every app page and route handler it spawns a FRESH Node process, requires the route's
 * compiled entry (which loads its eager server chunks and instantiates the route module),
 * then calls every loader in the page's segment tree — the layouts, pages, loading/error
 * boundaries a first render pulls in — and finally evaluates the client components the
 * page's SSR pass loads (`ssr`). That is the module-evaluation cost a new serverless
 * instance pays before its first query, and the part of a cold start the code controls.
 * Reported as the median over `--runs` processes, beside the bytes of eager chunks.
 *
 * The number is local-machine CPU time; a Vercel instance is slower, so read it as
 * relative. Nothing here opens the database or makes a request.
 *
 * To see WHY one route is slow, trace a single process (self time per module, via the
 * chunks' source maps):
 *
 *   node scripts/dev/cold-start-report.mjs --child .next/server/app/<route>/page.js --trace
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

const ROOT = process.cwd();
const NEXT = path.join(ROOT, ".next");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}

/**
 * `--trace`: patch the Turbopack runtime as it loads so every module factory is timed, then
 * resolve each factory's position in its chunk through the chunk's source map. Self time,
 * so a module that requires another is charged only for its own top-level work.
 */
function installTrace() {
  const Module = require("node:module");
  const compile = Module.prototype._compile;
  const chunkOf = new Map();
  const self = new Map();
  const stack = [];
  const factoryOf = new Map();
  globalThis.__coldChunk = (modules, file) => {
    let ids = [];
    for (const item of modules) {
      if (typeof item !== "function") {
        ids.push(item);
        continue;
      }
      for (const id of ids) {
        if (!chunkOf.has(id)) {
          chunkOf.set(id, file);
          factoryOf.set(id, item);
        }
      }
      ids = [];
    }
  };
  globalThis.__coldFactory = (id, run) => {
    const t = performance.now();
    stack.push(0);
    try {
      return run();
    } finally {
      const inner = stack.pop();
      const elapsed = performance.now() - t;
      if (stack.length) stack[stack.length - 1] += elapsed;
      self.set(id, (self.get(id) ?? 0) + elapsed - inner);
    }
  };
  Module.prototype._compile = function (content, filename) {
    if (filename.endsWith("[turbopack]_runtime.js")) {
      content = content
        .replace(/const chunkModules = require\(resolved\);/g, "$& globalThis.__coldChunk(chunkModules, resolved);")
        .replace("moduleFactory(context, module1, exports);", "globalThis.__coldFactory(id, () => moduleFactory(context, module1, exports));");
    }
    return compile.call(this, content, filename);
  };
  return () => {
    const { SourceMapConsumer } = require(require.resolve("source-map-js", { paths: [ROOT] }));
    const consumers = new Map();
    const sourceOf = (id) => {
      const file = chunkOf.get(id);
      if (!file) return `#${id}`;
      if (!consumers.has(file)) {
        const text = fs.readFileSync(file, "utf8");
        let map = null;
        try {
          map = new SourceMapConsumer(JSON.parse(fs.readFileSync(file + ".map", "utf8")));
        } catch {}
        consumers.set(file, { text, map });
      }
      const { text, map } = consumers.get(file);
      // A factory's own source text is a verbatim slice of its chunk; map where it starts.
      const at = text.indexOf(String(factoryOf.get(id)));
      if (!map || at < 0) return path.basename(file);
      const before = text.slice(0, at);
      const line = before.split("\n").length;
      const column = at - before.lastIndexOf("\n") - 1;
      const pos = map.originalPositionFor({ line, column, bias: SourceMapConsumer.LEAST_UPPER_BOUND });
      return pos.source
        ? decodeURIComponent(pos.source).replace(/^.*?\[project\]\//, "").replace(/^turbopack:\/\/\//, "")
        : path.basename(file);
    };
    const bySource = new Map();
    for (const [id, ms] of self) {
      // Externals (serverExternalPackages, node built-ins) are one-line factories that
      // `require()` the package from node_modules; name them by what they load.
      const external = String(factoryOf.get(id) ?? "").match(/\.[xy]\("([^"]+)"/);
      const src = external ? `external:${external[1]}` : sourceOf(id);
      bySource.set(src, (bySource.get(src) ?? 0) + ms);
    }
    const byPackage = new Map();
    for (const [src, ms] of bySource) {
      const m = src.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/);
      const key = m ? m[1] : src.startsWith("src/") ? src.split("/").slice(0, 3).join("/") : src;
      byPackage.set(key, (byPackage.get(key) ?? 0) + ms);
    }
    const fmt = (m, n) =>
      [...m]
        .sort((a, b) => b[1] - a[1])
        .slice(0, n)
        .map(([k, v]) => `${v.toFixed(1).padStart(7)} ms  ${k}`)
        .join("\n");
    if (process.env.COLD_DEBUG) {
      for (const [id, ms] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 3))
        process.stderr.write(`#${id} ${ms.toFixed(1)}ms ${String(factoryOf.get(id)).slice(0, 300)}\n`);
    }
    const total = [...self.values()].reduce((a, b) => a + b, 0);
    process.stderr.write(`module factories: ${self.size}, ${total.toFixed(0)} ms self\n\nby package / directory:\n${fmt(byPackage, 25)}\n\nby file:\n${fmt(bySource, 40)}\n`);
  };
}

/**
 * The SSR half of a first render: every client component the page references, loaded and
 * evaluated the way React's SSR client does when the payload names them. An upper bound —
 * it counts a dialog the first render might not reach — but the same bound before and
 * after a change. Returns false for a route handler (no client references).
 */
function loadSsrModules(entry) {
  const manifestFile = entry.replace(/page\.js$/, "page_client-reference-manifest.js");
  if (manifestFile === entry || !fs.existsSync(manifestFile)) return false;
  const sandbox = {};
  new Function("globalThis", fs.readFileSync(manifestFile, "utf8"))(sandbox);
  const manifest = Object.values(sandbox.__RSC_MANIFEST ?? {})[0];
  const runtime = /require\("([^"]+\[turbopack\]_runtime\.js)"\)/.exec(fs.readFileSync(entry, "utf8"))?.[1];
  if (!manifest || !runtime) return false;
  const R = require(path.resolve(path.dirname(entry), runtime))("cold-start-report");
  for (const byExport of Object.values(manifest.ssrModuleMapping ?? {})) {
    for (const ref of Object.values(byExport)) {
      try {
        for (const chunk of ref.chunks ?? []) R.c(chunk);
        R.m(ref.id);
      } catch {
        // A module that cannot evaluate outside a request still counted its load.
      }
      break; // every export of one module shares its id and chunks
    }
  }
  return true;
}

if (process.argv[2] === "--child") {
  const report = process.argv.includes("--trace") ? installTrace() : null;
  globalThis.AsyncLocalStorage = require("node:async_hooks").AsyncLocalStorage;
  process.env.NEXT_RUNTIME = "nodejs";
  require(require.resolve("next/dist/server/require-hook", { paths: [ROOT] }));
  const entry = path.resolve(process.argv[3]);
  const t0 = performance.now();
  const mod = require(entry);
  const t1 = performance.now();
  const loaders = [];
  const walk = (node) => {
    if (!Array.isArray(node)) return;
    const [, children, modules] = node;
    for (const [key, value] of Object.entries(modules ?? {})) {
      if (key === "metadata") continue;
      if (Array.isArray(value) && typeof value[0] === "function") loaders.push(value[0]);
    }
    for (const child of Object.values(children ?? {})) walk(child);
  };
  walk(mod.routeModule?.userland?.loaderTree ?? mod.tree);
  await Promise.all(loaders.map((load) => load())).catch(() => undefined);
  const t2 = performance.now();
  const ssr = loadSsrModules(entry);
  const t3 = performance.now();
  process.stdout.write(JSON.stringify({ require: t1 - t0, tree: t2 - t1, ssr: ssr ? t3 - t2 : 0, total: t3 - t0 }) + "\n");
  report?.();
  process.exit(0);
}

function entries() {
  const out = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (name === "page.js" || name === "route.js") out.push(p);
    }
  };
  walk(path.join(NEXT, "server", "app"));
  return out;
}

function eagerBytes(entry) {
  const src = fs.readFileSync(entry, "utf8");
  let bytes = 0;
  for (const [, chunk] of src.matchAll(/R\.c\("([^"]+)"\)/g)) {
    const file = path.join(NEXT, chunk);
    if (fs.existsSync(file)) bytes += fs.statSync(file).size;
  }
  return bytes;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

const runs = Number(arg("--runs", "5"));
const self = import.meta.filename;
const filter = arg("--filter", "");
const rows = [];
for (const entry of entries()) {
  const route = path.relative(path.join(NEXT, "server", "app"), entry);
  if (filter && !route.includes(filter)) continue;
  const samples = [];
  let failed = "";
  for (let i = 0; i < runs; i++) {
    const r = spawnSync(process.execPath, [self, "--child", entry], {
      cwd: ROOT,
      env: { ...process.env, NODE_ENV: "production" },
      encoding: "utf8",
    });
    try {
      samples.push(JSON.parse(r.stdout.trim().split("\n").pop()));
    } catch {
      failed = (r.stderr || r.stdout).trim().split("\n")[0];
      break;
    }
  }
  const row = { route, eagerKB: Math.round(eagerBytes(entry) / 1024) };
  if (samples.length) {
    row.requireMs = Math.round(median(samples.map((s) => s.require)));
    row.treeMs = Math.round(median(samples.map((s) => s.tree)));
    row.ssrMs = Math.round(median(samples.map((s) => s.ssr)));
    row.totalMs = Math.round(median(samples.map((s) => s.total)));
  } else row.error = failed;
  rows.push(row);
  process.stderr.write(".");
}
process.stderr.write("\n");
rows.sort((a, b) => (b.totalMs ?? 0) - (a.totalMs ?? 0));
const json = arg("--json");
if (json) fs.writeFileSync(json, JSON.stringify(rows, null, 2));
for (const r of rows) {
  const cols = r.error
    ? `ERROR ${r.error}`
    : `${String(r.totalMs).padStart(5)} ms (require ${String(r.requireMs).padStart(4)}, tree ${String(r.treeMs).padStart(4)}, ssr ${String(r.ssrMs).padStart(4)})`;
  console.log(`${cols}  ${String(r.eagerKB).padStart(6)} KB  ${r.route}`);
}
const ok = rows.filter((r) => !r.error);
if (ok.length) {
  console.log(`\n${ok.length} routes, median total ${median(ok.map((r) => r.totalMs))} ms, median eager ${median(ok.map((r) => r.eagerKB))} KB`);
}
