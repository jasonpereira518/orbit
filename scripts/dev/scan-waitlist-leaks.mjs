#!/usr/bin/env node
/**
 * Scans what the waitlist's own domain actually serves for anything that names the
 * product, describes it, or leads to the app (see src/lib/waitlist-host.ts).
 *
 * The smokes check the pieces; this checks the assembled result a visitor's browser gets:
 * response headers, the HTML of every waitlist page, and every script and stylesheet
 * those pages load. Run it against a PRODUCTION build (`next build && next start` with
 * WAITLIST_HOST set) — dev bundles carry source paths and comments that production strips.
 *
 *   node scripts/dev/scan-waitlist-leaks.mjs http://waitlist.localhost:3100 --connect 127.0.0.1 [--app-host orbit.example]
 *   node scripts/dev/scan-waitlist-leaks.mjs https://your-waitlist-domain --app-host orbit.jasonpereira.live
 *
 * Findings come in two grades:
 *   LEAK    — visible text, HTML, metadata or response headers. Must be zero.
 *   ASSET   — a hit inside a JS or CSS bundle. Triage each: a CSS class name or a string
 *             no one sees is a residual risk; a user-visible string is a leak.
 * Exits 1 on any LEAK.
 *
 * `--connect <ip>` dials that address and sends the waitlist's name as the Host header —
 * Node does not resolve `*.localhost` the way a browser does.
 */
import http from "node:http";

const args = process.argv.slice(2);
const base = (args.find((a) => !a.startsWith("--")) ?? "").replace(/\/+$/, "");
if (!base) {
  console.error("usage: scan-waitlist-leaks.mjs <waitlist origin> [--app-host host]");
  process.exit(2);
}
const appHostArg = args.indexOf("--app-host");
const appHost = appHostArg >= 0 ? args[appHostArg + 1] : null;
const connectArg = args.indexOf("--connect");
const connect = connectArg >= 0 ? args[connectArg + 1] : null;

// The product's name, its app's domain, auth, and the words that would describe features.
const TERMS = [
  /\borbit\b/i,
  /\bclerk\b/i,
  /jasonpereira/i,
  /\bcrm\b/i,
  /linkedin(?!\.com\/sharing)/i,
  /\bgmail\b/i,
  /\bdeepgram\b/i,
  /\/(dashboard|contacts|capture|outreach|recruiters|reminders|knowledge|graph|sign-in|sign-up|pricing|connect)\b/,
  ...(appHost ? [new RegExp(appHost.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")] : []),
];

const leaks = [];
const assets = [];

// The waitlist's own hostname is not a leak, even when it contains a term (a subdomain of
// jasonpereira.live does). It is blanked out before scanning, so what remains is everything
// ELSE the page says.
const ownHost = new URL(base).hostname;
const ownHostRe = new RegExp(ownHost.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");

function scan(where, text, bucket) {
  text = text.replace(ownHostRe, "<waitlist-host>");
  for (const term of TERMS) {
    const re = new RegExp(term.source, term.flags.includes("g") ? term.flags : `${term.flags}g`);
    for (const m of text.matchAll(re)) {
      const at = m.index ?? 0;
      bucket.push({ where, term: String(term), context: text.slice(Math.max(0, at - 50), at + 60).replace(/\s+/g, " ") });
      if (bucket.length > 400) return;
    }
  }
}

/** A GET that never follows redirects: `{ status, headers, text(), bytes() }`. */
async function get(path) {
  if (!connect) {
    const res = await fetch(`${base}${path}`, { redirect: "manual" });
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, headers: res.headers, text: async () => buf.toString("utf8"), bytes: async () => buf };
  }
  const url = new URL(`${base}${path}`);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: connect, port: url.port || 80, path: url.pathname + url.search, headers: { host: url.host } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          const headers = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
          }
          resolve({ status: res.statusCode ?? 0, headers, text: async () => buf.toString("utf8"), bytes: async () => buf });
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

async function main() {
  // Plant a real token so the pass and invited states render: the smoke seeds none here,
  // so fall back to the plain page when the visitor supplies none.
  const token = process.env.SCAN_TOKEN ?? "";
  const pages = ["/", "/privacy", ...(token ? [`/?me=${token}`, `/?ref=${token}`] : [])];
  const assetUrls = new Set();

  for (const path of pages) {
    const res = await get(path);
    const headers = [...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n");
    scan(`${path} [headers]`, headers, leaks);
    const html = await res.text();
    if (res.status !== 200) leaks.push({ where: path, term: "status", context: `HTTP ${res.status}` });
    scan(`${path} [html]`, html, leaks);
    for (const m of html.matchAll(/(?:src|href)="([^"]+\.(?:js|css)(?:\?[^"]*)?)"/g)) assetUrls.add(m[1]);
    // Every absolute URL in the page must be on this origin or a share target.
    for (const m of html.matchAll(/(?:src|href|content)="(https?:\/\/[^"]+)"/g)) {
      const url = m[1];
      const ok =
        url.startsWith(base) ||
        url.startsWith("https://twitter.com/intent/") ||
        url.startsWith("https://www.linkedin.com/sharing/");
      if (!ok) leaks.push({ where: `${path} [url]`, term: "foreign url", context: url });
    }
  }

  // The routes that must redirect home rather than serve anything.
  for (const path of ["/pricing", "/sign-in", "/dashboard", "/interest", "/api/v1/openapi.json", "/orbit-logo.png", "/guides/linkedin/export-1.png"]) {
    const res = await get(path);
    const to = res.headers.get("location") ?? "";
    if (!(res.status >= 300 && res.status < 400 && (to === "/" || to === `${base}/` || to.endsWith("/")))) {
      leaks.push({ where: path, term: "not closed", context: `HTTP ${res.status} → ${to || "(no redirect)"}` });
    }
  }

  // The icons the root layout links must be the waitlist's, not the product's logo.
  const iconBytes = await (await get("/favicon.ico")).bytes();
  const waitlistIcon = await (await get("/waitlist/icon.png")).bytes();
  if (!iconBytes.equals(waitlistIcon)) leaks.push({ where: "/favicon.ico", term: "icon", context: "is not the waitlist icon" });

  for (const url of assetUrls) {
    const path = url.startsWith("http") ? new URL(url).pathname + new URL(url).search : url;
    scan(url, await (await get(path)).text(), assets);
  }

  console.log(`Scanned ${pages.length} pages and ${assetUrls.size} assets on ${base}.\n`);
  if (leaks.length) {
    console.log(`LEAK (${leaks.length}) — visible text, HTML, headers or routing:`);
    for (const l of leaks) console.log(`  ${l.where}  ${l.term}\n      …${l.context}…`);
  } else {
    console.log("LEAK: none.");
  }
  if (assets.length) {
    console.log(`\nASSET (${assets.length}) — hits inside JS/CSS bundles, to triage:`);
    const byWhere = new Map();
    for (const a of assets) byWhere.set(a.where, [...(byWhere.get(a.where) ?? []), a]);
    for (const [where, hits] of byWhere) {
      console.log(`  ${where}`);
      for (const h of hits.slice(0, 12)) console.log(`      ${h.term}  …${h.context}…`);
      if (hits.length > 12) console.log(`      (+${hits.length - 12} more)`);
    }
  } else {
    console.log("\nASSET: none.");
  }
  process.exit(leaks.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
