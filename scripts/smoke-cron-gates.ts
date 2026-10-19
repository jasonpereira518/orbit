/**
 * Every API route Clerk does not guard must guard itself — statically, for all of them, and
 * dynamically for the cron routes smoke-internal-auth does not already call.
 *
 * WHY STATIC. `src/lib/public-routes.ts` exempts a route from `auth.protect()` by path
 * pattern. Some entries are genuinely public (the CSP report sink, the traffic beacon); most
 * are "public" only because their caller cannot carry a Clerk session — Vercel Cron, a
 * webhook sender, a calendar client, an API key. For those the handler's own check is the
 * ONLY thing between the internet and the route, and the patterns are broad
 * (`/api/webhooks(.*)`, `/api/v1(.*)`, `/api/extension(.*)`). A new `route.ts` dropped under
 * one of them is public the moment it exists. So this walks every `src/app/api/** /route.ts`,
 * asks Clerk's own matcher (fed `PUBLIC_ROUTES`) whether it is public, and for each exported
 * HTTP handler of each public route requires one of:
 *
 *   - a recognised gate call in the handler (or in a same-file helper it calls) — the cron
 *     secret, a webhook signature verifier, a token lookup, or a wrapper that authenticates
 *     (`apiHandler`, `extensionRoute`, `handleMcpRequest`);
 *   - an entry in INTENTIONALLY_OPEN below, with the reason it needs nothing.
 *
 * Parsed with the TypeScript compiler, not grepped, so a commented-out gate does not count.
 * A route that calls `isInternalRequest` must do so as its FIRST statement and return on
 * failure — a gate after the work has started is not a gate.
 *
 * WHY DYNAMIC TOO. The static check proves the call is there; it cannot prove the call's
 * answer is respected. So each cron route not already exercised by smoke-internal-auth is
 * invoked in a production-shaped environment (`NODE_ENV=production`, `VERCEL=1`, a fake
 * `CRON_SECRET`) with no Authorization, a wrong bearer, and a lowercase-scheme bearer, and
 * must answer 401 having written nothing (every table's row count is unchanged) and fetched
 * nothing. A positive control with the right bearer proves the 401s came from the gate.
 *
 * Run: npx tsx scripts/smoke-cron-gates.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { sql } from "drizzle-orm";
import { createRouteMatcher } from "@clerk/nextjs/server";
import { getDb, rowsOf } from "../src/db";
import { PUBLIC_ROUTES } from "../src/lib/public-routes";
import { checker } from "./smoke/check";

import { POST as opsSweep } from "../src/app/api/ops/sweep/route";
import { POST as billingReconcile } from "../src/app/api/ops/billing-reconcile/route";
import { POST as weeklyDigest } from "../src/app/api/ops/weekly-digest/route";
import { POST as jobsFeedSweep } from "../src/app/api/jobs/feed/sweep/route";
import { POST as relationshipsRun } from "../src/app/api/relationships/run/route";
import { POST as emailDrain } from "../src/app/api/email/drain/route";
import { POST as connectorsOutboxDrain } from "../src/app/api/connectors/outbox/drain/route";
import { POST as webhooksOutboundDrain } from "../src/app/api/webhooks/outbound/drain/route";
import { POST as creditsNotices } from "../src/app/api/credits/notices/route";
import { POST as cloudNotesRun } from "../src/app/api/cloud-notes/run/route";
import { POST as syncRun } from "../src/app/api/sync/run/route";
import { POST as speechUsage } from "../src/app/api/ops/speech-usage/route";
import { POST as avatarsEncode } from "../src/app/api/avatars/encode/route";

const API_DIR = "src/app/api";
const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

/** Calls that authenticate the caller (or the delivery) before anything else happens. */
const GATES: Record<string, string> = {
  isInternalRequest: "CRON_SECRET bearer (src/lib/internal-auth.ts)",
  healthTokenState: "HEALTH_TOKEN for the deep view (src/lib/internal-auth.ts)",
  verifyResendSignature: "Standard Webhooks HMAC (src/lib/resend-webhook.ts)",
  verifyWebhook: "Clerk's Svix verifier",
  constructEvent: "Stripe's signature verifier",
  apiHandler: "per-user API key (src/lib/api/http.ts → requireApiCaller)",
  extensionRoute: "Clerk session or local dev secret (src/lib/extension/route.ts → requireExtensionUser)",
  handleMcpRequest: "API key / OAuth token (src/lib/mcp/handle.ts)",
  findUserByFeedToken: "opaque calendar-feed token (src/lib/calendar-feed.ts)",
  findScanHandoff: "opaque single-use scan token (src/lib/scan-handoff.ts)",
  unsubscribeCreditEmail: "signed unsubscribe token (src/lib/credits/notices.ts)",
  unsubscribeRadarDigest: "signed unsubscribe token (src/lib/radar/digest.ts)",
  getProgressByShareToken: "share token (src/lib/interest-list-ticket.ts)",
};

/**
 * Public handlers that need no gate, keyed `<route dir>#<METHOD>`. `mustContain`, when set,
 * pins the property the reason relies on, so the exemption cannot outlive it.
 */
const INTENTIONALLY_OPEN: Record<string, { reason: string; mustContain?: RegExp }> = {
  "csp-report#POST": { reason: "browsers POST CSP violation reports with no session; stores a directive and a URI, throttled" },
  "p/v#POST": { reason: "the anonymous traffic beacon (renamed from /api/track, which stays as an alias); stores no IP and sets no cookie" },
  "track#POST": { reason: "the anonymous traffic beacon; stores no IP and sets no cookie" },
  "extension/uninstalled#GET": { reason: "the browser opens it as the extension is removed, when its session is already gone; it accepts a bare version number, records no user, IP or user agent, is rate limited, and always answers 204" },
  "waitlist-poll/results#GET": { reason: "aggregate poll tallies, nothing about any one voter" },
  "v1/openapi.json#GET": { reason: "the static OpenAPI document" },
  "credits/email/unsubscribe#GET": {
    reason: "renders a confirmation button only; the POST does the work, behind the token",
    mustContain: /unsubscribeCreditEmail\(token\)/,
  },
  "radar/digest/unsubscribe#GET": {
    reason: "renders a confirmation button only; the POST does the work, behind the token",
    mustContain: /unsubscribeRadarDigest\(token\)/,
  },
  "interest-list/unsubscribe#GET": { reason: "renders a confirmation button only; the POST does the work, behind the token" },
  "interest-list/unsubscribe#POST": {
    // `unsubscribeTokenMatches` compares the token's hash (audit L-05), still the whole WHERE.
    reason: "the token IS the WHERE clause of the only write: an unknown token matches no row",
    mustContain: /\.where\(unsubscribeTokenMatches\(token\)\)/,
  },
};
/** CORS preflight for the extension: answers headers, touches nothing. */
const PREFLIGHT_IDENTIFIERS = new Set(["preflight"]);

/** Cron routes smoke-internal-auth.ts already calls with a missing and a wrong bearer. */
const COVERED_BY_INTERNAL_AUTH = new Set([
  "imports/process-stalled",
  "imports/[id]/continue",
  "embeddings/backfill",
  "work-history/research",
  "work-history/sweep",
  "linkedin/timeline-events/backfill",
  "capture/jobs/[id]/run",
  "radar/run",
  "radar/feeds/sweep",
  "radar/digest",
]);

type Handler = (req: Request) => Promise<Response>;
/** Cron routes this script calls. Keys are route dirs under src/app/api. */
const DYNAMIC: Record<string, Handler> = {
  "ops/sweep": opsSweep,
  "jobs/feed/sweep": jobsFeedSweep,
  "relationships/run": relationshipsRun,
  "email/drain": emailDrain,
  "connectors/outbox/drain": connectorsOutboxDrain,
  "webhooks/outbound/drain": webhooksOutboundDrain,
  "credits/notices": creditsNotices,
  "cloud-notes/run": cloudNotesRun,
  "sync/run": syncRun,
  "ops/speech-usage": speechUsage,
  "ops/billing-reconcile": billingReconcile,
  "ops/weekly-digest": weeklyDigest,
  "avatars/encode": avatarsEncode,
};

// --- Static analysis ---------------------------------------------------------------------------

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return entry === "route.ts" ? [full] : [];
  });
}

/** `src/app/api/a/[id]/route.ts` → `a/[id]` and a concrete sample path for the matcher. */
function describe(file: string) {
  const dir = file.slice(API_DIR.length + 1).replace(/\/route\.ts$/, "");
  const sample =
    "/api/" +
    dir
      .split("/")
      .filter((s) => !(s.startsWith("(") && s.endsWith(")")))
      .map((s) => (/^\[\.\.\..+\]$/.test(s) ? "a/b" : /^\[.+\]$/.test(s) ? "sample-1234" : s))
      .join("/");
  return { dir, sample };
}

function calleeName(call: ts.CallExpression): string | null {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return null;
}

type Analysis = {
  /** METHOD → gates found (transitively through same-file helpers), or "preflight". */
  handlers: Map<string, { gates: Set<string>; preflight: boolean; node: ts.Node | null }>;
  /** Handlers that call isInternalRequest but not as a leading `if (!…) return`. */
  lateCronGate: string[];
};

function analyse(file: string, text = readFileSync(file, "utf8")): Analysis {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  // Same-file named functions (declarations and `const f = (…) => …`), so a handler that
  // delegates to a local helper is credited with the helper's gate.
  const locals = new Map<string, ts.Node>();
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name) locals.set(st.name.text, st);
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer) locals.set(d.name.text, d.initializer);
      }
    }
  }

  const gatesIn = (node: ts.Node, seen = new Set<ts.Node>()): Set<string> => {
    const out = new Set<string>();
    if (seen.has(node)) return out;
    seen.add(node);
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n)) {
        const name = calleeName(n);
        if (name && GATES[name]) out.add(name);
        if (name && ts.isIdentifier(n.expression) && locals.has(name)) {
          for (const g of gatesIn(locals.get(name)!, seen)) out.add(g);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
    return out;
  };

  const handlers: Analysis["handlers"] = new Map();
  const lateCronGate: string[] = [];
  const exported = (n: ts.Node) =>
    ts.canHaveModifiers(n) && (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

  const record = (method: string, node: ts.Node | null, preflight = false) => {
    handlers.set(method, { gates: node ? gatesIn(node) : new Set(), preflight, node });
  };

  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name && exported(st) && HTTP_METHODS.has(st.name.text)) {
      record(st.name.text, st);
    } else if (ts.isVariableStatement(st) && exported(st)) {
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !HTTP_METHODS.has(d.name.text) || !d.initializer) continue;
        const init = d.initializer;
        if (ts.isIdentifier(init)) {
          if (PREFLIGHT_IDENTIFIERS.has(init.text)) record(d.name.text, null, true);
          else record(d.name.text, locals.get(init.text) ?? init);
        } else {
          record(d.name.text, init);
        }
      }
    } else if (ts.isExportDeclaration(st) && st.exportClause && ts.isNamedExports(st.exportClause)) {
      for (const el of st.exportClause.elements) {
        if (!HTTP_METHODS.has(el.name.text)) continue;
        const local = (el.propertyName ?? el.name).text;
        // Re-exported from another module: nothing local to inspect, so it must be allowlisted.
        record(el.name.text, st.moduleSpecifier ? null : locals.get(local) ?? null);
      }
    }
  }

  // The cron gate must be the handler's first statement, returning on failure.
  for (const [method, h] of handlers) {
    if (!h.gates.has("isInternalRequest") || !h.node) continue;
    const fn = h.node;
    const body =
      (ts.isFunctionDeclaration(fn) || ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && fn.body && ts.isBlock(fn.body)
        ? fn.body
        : null;
    const first = body?.statements[0];
    const ok =
      !!first &&
      ts.isIfStatement(first) &&
      ts.isPrefixUnaryExpression(first.expression) &&
      first.expression.operator === ts.SyntaxKind.ExclamationToken &&
      ts.isCallExpression(first.expression.operand) &&
      calleeName(first.expression.operand) === "isInternalRequest" &&
      (ts.isReturnStatement(first.thenStatement) ||
        (ts.isBlock(first.thenStatement) && first.thenStatement.statements.some(ts.isReturnStatement)));
    if (!ok) lateCronGate.push(method);
  }

  return { handlers, lateCronGate };
}

// --- Dynamic -----------------------------------------------------------------------------------

const FAKE_SECRET = "smoke-cron-secret-not-real";

function cronRequest(authorization?: string, body: BodyInit = JSON.stringify({ userId: "smoke-cron-victim" })) {
  return new Request("http://localhost/api/internal", {
    method: "POST",
    headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
    body,
  });
}

async function tableCounts(db: Awaited<ReturnType<typeof getDb>>): Promise<Map<string, number>> {
  const tables = rowsOf<{ table_name: string }>(
    await db.execute(
      sql`SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name`
    )
  ).map((r) => r.table_name);
  const out = new Map<string, number>();
  for (const table of tables) {
    const n = rowsOf<{ n: number }>(await db.execute(sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)}`))[0]?.n;
    out.set(table, Number(n ?? 0));
  }
  return out;
}

function diffCounts(a: Map<string, number>, b: Map<string, number>): string[] {
  const out: string[] = [];
  for (const [k, v] of b) if (a.get(k) !== v) out.push(`${k}: ${a.get(k) ?? "∅"}→${v}`);
  return out;
}

run(async () => {
  const t = checker();
  const isPublic = createRouteMatcher([...PUBLIC_ROUTES]);
  const matches = (path: string) => isPublic({ nextUrl: { pathname: path } } as Parameters<typeof isPublic>[0]);

  console.log("The analyser can fail (synthetic sources)…");
  const probe = (src: string) => analyse("probe/route.ts", src);
  let p = probe(`export async function GET() { return Response.json({ all: "the data" }); }`);
  t.check("an ungated handler has no gates", p.handlers.get("GET")?.gates.size === 0);
  p = probe(`// if (!isInternalRequest(r)) return new Response(null, { status: 401 });\nexport async function POST(r: Request) { return work(r); }`);
  t.check("a commented-out gate does not count", p.handlers.get("POST")?.gates.size === 0);
  p = probe(`export async function POST(r: Request) { await work(); if (!isInternalRequest(r)) return new Response(null, { status: 401 }); return ok(); }`);
  t.check("a cron gate after the work is flagged", p.lateCronGate.includes("POST"));
  p = probe(`export async function POST(r: Request) { if (!isInternalRequest(r)) { log(); } return work(); }`);
  t.check("a cron gate that does not return is flagged", p.lateCronGate.includes("POST"));
  p = probe(`async function h(r: Request) { if (!isInternalRequest(r)) return new Response(null, { status: 401 }); return work(); }\nexport const POST = h;`);
  t.check("a gate in a same-file helper is credited, and its placement checked", p.handlers.get("POST")?.gates.has("isInternalRequest") === true && p.lateCronGate.length === 0);
  p = probe(`export { handler as GET } from "./elsewhere";`);
  t.check("a re-exported handler has nothing to credit", p.handlers.get("GET")?.gates.size === 0);
  p = probe(`export const DELETE = apiHandler({ scope: "write", bucket: "apiWrite" }, async () => ok());`);
  t.check("a wrapper gate is credited", p.handlers.get("DELETE")?.gates.has("apiHandler") === true);

  console.log("\nEvery public API route gates every handler (static)…");
  const files = walk(API_DIR).sort();
  t.check("found the API routes", files.length > 50, String(files.length));

  const cronRoutes: string[] = [];
  const usedOpen = new Set<string>();
  let publicCount = 0;
  for (const file of files) {
    const { dir, sample } = describe(file);
    const a = analyse(file);
    const callsCron = [...a.handlers.values()].some((h) => h.gates.has("isInternalRequest"));
    if (callsCron) cronRoutes.push(dir);
    if (!matches(sample)) {
      // A private route that gates on the cron secret could never be reached by cron.
      if (callsCron) t.check(`${dir}: a cron-gated route is listed in PUBLIC_ROUTES`, false, `${sample} is Clerk-protected`);
      continue;
    }
    publicCount++;
    t.check(`${dir}: exports at least one HTTP handler`, a.handlers.size > 0);
    for (const [method, h] of a.handlers) {
      const key = `${dir}#${method}`;
      const open = INTENTIONALLY_OPEN[key];
      if (open) usedOpen.add(key);
      const gated = h.gates.size > 0;
      const ok = gated || h.preflight || Boolean(open);
      t.check(
        `${key} is ${gated ? `gated (${[...h.gates].join(", ")})` : h.preflight ? "a CORS preflight" : open ? "intentionally open" : "UNGATED"}`,
        ok,
        ok ? "" : `public via PUBLIC_ROUTES (${sample}) with no recognised gate — add one, or an INTENTIONALLY_OPEN entry with a reason`
      );
      if (open?.mustContain) {
        const src = readFileSync(file, "utf8");
        t.check(`${key}: the exemption's premise still holds`, open.mustContain.test(src), String(open.mustContain));
      }
    }
    for (const method of a.lateCronGate) {
      t.check(`${dir}#${method}: isInternalRequest is the first statement and returns`, false);
    }
    if (callsCron && a.lateCronGate.length === 0) {
      t.check(`${dir}: isInternalRequest guards before any work`, true);
    }
  }
  t.check("the walk saw public routes", publicCount > 30, String(publicCount));
  for (const key of Object.keys(INTENTIONALLY_OPEN)) {
    t.check(`INTENTIONALLY_OPEN entry ${key} still names a public handler`, usedOpen.has(key));
  }

  // Every cron route is called dynamically by this script or by smoke-internal-auth.
  for (const dir of cronRoutes) {
    t.check(
      `${dir}: cron route is exercised dynamically`,
      Boolean(DYNAMIC[dir]) || COVERED_BY_INTERNAL_AUTH.has(dir),
      "add it to DYNAMIC here (or to smoke-internal-auth.ts)"
    );
  }
  for (const dir of [...Object.keys(DYNAMIC), ...COVERED_BY_INTERNAL_AUTH]) {
    t.check(`${dir}: listed cron route still calls isInternalRequest`, cronRoutes.includes(dir));
  }

  // --- Dynamic -------------------------------------------------------------------------------
  console.log("\nCron routes refuse unauthenticated calls in production (dynamic)…");
  const env = process.env as Record<string, string | undefined>;
  const saved = { CRON_SECRET: env.CRON_SECRET, VERCEL: env.VERCEL, NODE_ENV: env.NODE_ENV };
  const db = await getDb();
  // Every table, so a write anywhere — a cron_runs row, a job claim, a webhook delivery — shows.
  const before = await tableCounts(db);

  const fetches: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetches.push(String(input instanceof Request ? input.url : input));
    throw new Error("smoke-cron-gates: no network");
  }) as typeof fetch;

  try {
    env.NODE_ENV = "production";
    env.VERCEL = "1";
    env.CRON_SECRET = FAKE_SECRET;
    const attempts: Array<[string, string | undefined]> = [
      ["no Authorization", undefined],
      ["a wrong bearer", "Bearer not-the-secret"],
      ["the secret with a lowercase scheme", `bearer ${FAKE_SECRET}`],
      ["the bare secret, no scheme", FAKE_SECRET],
      ["the secret plus a suffix", `Bearer ${FAKE_SECRET}x`],
    ];
    for (const [dir, handler] of Object.entries(DYNAMIC)) {
      const statuses: string[] = [];
      for (const [, auth] of attempts) {
        const res = await handler(cronRequest(auth)).catch((e: unknown) => ({ status: `threw ${String(e)}` }));
        statuses.push(String(res.status));
      }
      t.check(`${dir} → 401 for ${attempts.map(([l]) => l).join(" / ")}`, statuses.every((s) => s === "401"), statuses.join(","));
    }

    delete env.CRON_SECRET;
    const unset = await Promise.all(
      Object.entries(DYNAMIC).map(async ([dir, handler]) => [dir, (await handler(cronRequest())).status] as const)
    );
    const notClosed = unset.filter(([, s]) => s !== 401);
    t.check("with CRON_SECRET unset in production every one → 401 (fail closed)", notClosed.length === 0, JSON.stringify(notClosed));

    const after = await tableCounts(db);
    const changed = diffCounts(before, after);
    t.check("no refused call wrote a row anywhere", changed.length === 0, changed.join("; "));
    t.check("no refused call reached the network", fetches.length === 0, fetches.join(", "));

    // Positive controls: the right bearer gets past the gate, into a branch that writes nothing.
    env.CRON_SECRET = FAKE_SECRET;
    const rel = await relationshipsRun(cronRequest(`Bearer ${FAKE_SECRET}`, JSON.stringify({})));
    t.check("control: relationships/run with the right bearer passes the gate (400: userId required)", rel.status === 400, String(rel.status));
    const enc = await avatarsEncode(cronRequest(`Bearer ${FAKE_SECRET}`, new Uint8Array(0)));
    t.check("control: avatars/encode with the right bearer passes the gate (422: empty image)", enc.status === 422, String(enc.status));
  } finally {
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
  }

  t.done("cron gates");
});
