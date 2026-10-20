/**
 * Security lint over the source (FIX_PLAN Phase 4.2), written as a smoke so it needs no new
 * dependency: the rules the audit used as one-off scripts, kept on every run.
 *
 *   1. Server-side `fetch(` passes a `signal` (a stalled upstream must not hold a request;
 *      audit M-14). Browser modules and same-origin relative URLs are exempt.
 *   2. No `new Date(` built straight from a server action's parameters (audit M-04): an
 *      action's input goes through `parseClientDate` / the `clientDateField` schemas.
 *   3. `Papa.unparse(` only in `src/lib/csv-export.ts`, which escapes formulas (INJ-CSV).
 *   4. `sql.raw(` with anything but a literal only at reviewed sites, each with its reason.
 *      A new one fails until someone checks it and adds it below.
 *
 * Origin checks on cookie-authenticated routes have their own smoke (smoke-origin-checks).
 * Pure: reads files only. Run: npx tsx scripts/smoke-security-lint.ts
 */
import ts from "typescript";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const SRC = join(ROOT, "src");

/** Reviewed `sql.raw` sites with a non-literal argument, keyed `file :: argument`. */
const SQL_RAW_ALLOWLIST: Record<string, string> = {
  "src/lib/closeness-cohort.ts :: sqlList(EXCHANGE_TOUCH_TYPES)":
    "quoted lists built from the constant NOTE/MEETING/EXCHANGE_TOUCH_TYPES arrays.",
  "src/lib/closeness-cohort.ts :: sqlList(MEETING_TOUCH_TYPES)":
    "quoted lists built from the constant NOTE/MEETING/EXCHANGE_TOUCH_TYPES arrays.",
  "src/lib/closeness-cohort.ts :: sqlList(NOTE_TOUCH_TYPES)":
    "quoted lists built from the constant NOTE/MEETING/EXCHANGE_TOUCH_TYPES arrays.",
  "src/lib/dashboard-network.ts :: `${opts.byOrbitScore ? \"contacts.sort_key desc, \" : \"\"}contacts.updated_at desc, contacts.id desc`":
    "`key` is the closed \"raw\" | \"closeness\" | \"orbitScore\" union, `column` names come from code (touch-count columns), and the order fragments switch on a boolean.",
  "src/lib/dashboard-network.ts :: `${opts.byOrbitScore ? \"sort_key desc, \" : \"\"}updated_at desc, id desc`":
    "`key` is the closed \"raw\" | \"closeness\" | \"orbitScore\" union, `column` names come from code (touch-count columns), and the order fragments switch on a boolean.",
  "src/lib/dashboard-network.ts :: `(case when jsonb_typeof(contacts.closeness_breakdown->'${key}') = 'number' then (contacts.closeness_breakdown->>'${key}')::float8 end)`":
    "`key` is the closed \"raw\" | \"closeness\" | \"orbitScore\" union, `column` names come from code (touch-count columns), and the order fragments switch on a boolean.",
  "src/lib/dashboard-network.ts :: `coalesce(touch.${column}, 0)`":
    "`key` is the closed \"raw\" | \"closeness\" | \"orbitScore\" union, `column` names come from code (touch-count columns), and the order fragments switch on a boolean.",
  "src/lib/admin-interest-list.ts :: unit":
    "`unit` is one of two literals picked from the closed `grain` union.",
  "src/lib/admin-roster.ts :: HAS_PROVIDER_KEY_SQL":
    "constant SQL fragments, and `ORDER_BY[sort]` / `direction` are looked up from closed maps after `isRosterSort` and an asc/desc check.",
  "src/lib/admin-roster.ts :: ORDER_BY[sort]":
    "constant SQL fragments, and `ORDER_BY[sort]` / `direction` are looked up from closed maps after `isRosterSort` and an asc/desc check.",
  "src/lib/admin-roster.ts :: PLAN_SQL":
    "constant SQL fragments, and `ORDER_BY[sort]` / `direction` are looked up from closed maps after `isRosterSort` and an asc/desc check.",
  "src/lib/admin-roster.ts :: direction":
    "constant SQL fragments, and `ORDER_BY[sort]` / `direction` are looked up from closed maps after `isRosterSort` and an asc/desc check.",
  "src/lib/admin-trends.ts :: `interval '${Math.max(1, Math.min(days, USAGE_EVENT_RETENTION_DAYS))} days'`":
    "intervals built from `grainInterval` (three literals) or clamped integers; `columns` is built from the constant FEATURES table list.",
  "src/lib/admin-trends.ts :: `interval '${Math.max(1, Math.round(spanDays))} days'`":
    "intervals built from `grainInterval` (three literals) or clamped integers; `columns` is built from the constant FEATURES table list.",
  "src/lib/admin-trends.ts :: `interval '${step}'`":
    "intervals built from `grainInterval` (three literals) or clamped integers; `columns` is built from the constant FEATURES table list.",
  "src/lib/activity.ts :: `interval '${ACTIVATION_WINDOW_DAYS} days'`":
    "`ACTIVATION_WINDOW_DAYS` is a numeric module constant.",
  "src/lib/admin-trends.ts :: `\"${f.key}\"`":
    "`f.key` comes from the constant FEATURES list.",
  "src/lib/admin-trends.ts :: f.table":
    "`f.table` comes from the constant FEATURES list.",
  "src/lib/admin-trends.ts :: f.where":
    "`f.where` comes from the constant FEATURES list.",
  "src/lib/admin-trends.ts :: `interval '${ACTIVATION_WINDOW_DAYS} days'`":
    "`ACTIVATION_WINDOW_DAYS` is a numeric module constant.",
  "src/lib/admin-trends.ts :: column":
    "`bucketOf`'s string form; no caller passes anything but SQL or a literal column name.",
  "src/lib/analytics-retention.ts :: table":
    "`table` is typed `PrunableTable`, a key of the constant TABLES map.",
  "src/lib/analytics-retention.ts :: column":
    "`column` is TABLES[table], a literal from the constant map.",
  "src/lib/attribution.ts :: alias":
    "`alias` is checked against /^[a-z_][a-z0-9_]*$/i before use.",
  "src/lib/money-costs.ts :: deepgramMicrosPerSecond(kind, source).toFixed(6)":
    "a number from the constant rate table, formatted by toFixed.",
  "src/lib/money-metrics.ts :: `interval '${step}'`":
    "`step` is one of three literals chosen from the closed Grain union.",
  "src/lib/product-metrics.ts :: col":
    "every `real(...)` call passes a literal column name.",
  "src/lib/product-ops.ts :: col":
    "every `nonInternal(...)` call passes a literal column name.",
  "src/lib/signup-session.ts :: SIGNUP_SESSION_WINDOW":
    "a string module constant (\"2 days\").",
  "src/lib/work-history-sweep.ts :: `(work_history_misses < ${WORK_HISTORY_MAX_MISSES} OR work_history_miss_slug IS DISTINCT FROM linkedin_slug)`":
    "a literal predicate; `WORK_HISTORY_MAX_MISSES` is a numeric module constant.",
  "src/lib/ai-access.ts :: String(UNPRICED_CALL_MICROS.embedding)":
    "numeric constants.",
  "src/lib/ai-access.ts :: String(UNPRICED_CALL_MICROS.other)":
    "numeric constants.",
  "src/lib/ai-access.ts :: String(UNPRICED_CALL_MICROS.transcription)":
    "numeric constants.",
  "src/lib/avatar-backfill.ts :: `interval '${AVATAR_RECHECK_DAYS} days'`":
    "a numeric constant.",
  "src/lib/contact-merge.ts :: `\"${name}\"`":
    "table and column names from the constant reference list, and restore columns from the database's own information_schema catalogue.",
  "src/lib/contact-merge.ts :: column":
    "table and column names from the constant reference list, and restore columns from the database's own information_schema catalogue.",
  "src/lib/contact-merge.ts :: table":
    "table and column names from the constant reference list, and restore columns from the database's own information_schema catalogue.",
  "src/lib/contacts-page-query.ts :: `interval '${quiet} days'`":
    "`quiet` comes from `parseQuietDays`, which only returns one of the QUIET_OPTIONS integers.",
  "src/lib/extension/http.ts :: String(WINDOW_SECONDS)":
    "a numeric constant.",
  "src/lib/import-engine.ts :: `payload #>> '{${path.join(\",\")}}' AS k${i}`":
    "every path segment is checked against PATH_SEGMENT_RE first and the call throws otherwise.",
  "src/lib/memory-chunks.ts :: alias":
    "`alias` is a caller-supplied table alias from code, never request input.",
  "src/lib/provider-connections.ts :: PROVIDER_TABLES[provider]":
    "`PROVIDER_TABLES` is a constant map keyed by the closed provider union.",
  "src/lib/rate-limit.ts :: String(policy.windowSec)":
    "`policy.windowSec` is a number from the RATE_LIMITS constants.",
  "src/lib/retention.ts :: timeExpr":
    "`timeExpr` is a literal column expression passed by the sweep's own call sites.",
  "src/lib/search.ts :: table === \"memory_chunks\" ? \"memory_chunks\" : \"contact_embeddings\"":
    "a ternary between two table-name literals.",
  "src/lib/user-data.ts :: BILLING_DETAIL_PERSONAL_KEYS.map((k) => `'${k}'`).join(\" - \")":
    "quoted from the constant BILLING_DETAIL_PERSONAL_KEYS list.",
};

/** Fetches that are deliberately unbounded, with why. Empty today. */
const FETCH_ALLOWLIST: Record<string, string> = {};

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? `\n         ${detail}` : ""}`);
  if (!ok) failures++;
}

const files = readdirSync(SRC, { recursive: true })
  .map(String)
  .filter((n) => /\.tsx?$/.test(n) && !n.endsWith(".d.ts"))
  .map((n) => join(SRC, n));

const unsignalled: string[] = [];
const actionDates: string[] = [];
const unparse: string[] = [];
const rawSeen = new Set<string>();
const rawUnreviewed: string[] = [];

function rootIdentifier(e: ts.Expression): string | null {
  let x: ts.Expression = e;
  for (;;) {
    if (ts.isIdentifier(x)) return x.text;
    if (ts.isPropertyAccessExpression(x) || ts.isElementAccessExpression(x) || ts.isNonNullExpression(x) || ts.isParenthesizedExpression(x)) {
      x = x.expression;
      continue;
    }
    return null;
  }
}

/** The parameter names (after `userId`) of the `defineAction` handler enclosing `n`, if any. */
function actionParams(n: ts.Node, sf: ts.SourceFile): Set<string> | null {
  for (let c: ts.Node | undefined = n.parent; c; c = c.parent) {
    if ((ts.isArrowFunction(c) || ts.isFunctionExpression(c)) && ts.isCallExpression(c.parent) && c.parent.expression.getText(sf) === "defineAction") {
      const names = new Set<string>();
      for (const p of c.parameters.slice(1)) {
        if (ts.isIdentifier(p.name)) names.add(p.name.text);
        else p.name.elements.forEach((el) => { if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) names.add(el.name.text); });
      }
      return names;
    }
  }
  return null;
}

function isRelativeUrl(arg: ts.Expression | undefined, sf: ts.SourceFile): boolean {
  if (!arg) return false;
  const t = arg.getText(sf);
  return /^["'`]\//.test(t);
}

for (const file of files) {
  const rel = file.slice(ROOT.length + 1);
  const text = readFileSync(file, "utf8");
  const browser = /^\s*["']use client["']/.test(text);
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const at = (n: ts.Node) => `${rel}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression.getText(sf);
      if ((callee === "fetch" || callee === "globalThis.fetch") && !browser && !isRelativeUrl(n.arguments[0], sf)) {
        const init = n.arguments[1];
        const signalled =
          !!init &&
          ts.isObjectLiteralExpression(init) &&
          init.properties.some((p) => ts.isSpreadAssignment(p) || p.name?.getText(sf) === "signal");
        if (!signalled && !FETCH_ALLOWLIST[at(n)]) unsignalled.push(at(n));
      }
      if (callee === "Papa.unparse" && rel !== "src/lib/csv-export.ts") unparse.push(at(n));
      if (callee === "sql.raw") {
        const a = n.arguments[0];
        if (a && !ts.isStringLiteral(a) && !ts.isNoSubstitutionTemplateLiteral(a)) {
          const key = `${rel} :: ${a.getText(sf).replace(/\s+/g, " ")}`;
          rawSeen.add(key);
          if (!SQL_RAW_ALLOWLIST[key]) rawUnreviewed.push(`${at(n)}  key: ${JSON.stringify(key)}`);
        }
      }
    }
    if (ts.isNewExpression(n) && n.expression.getText(sf) === "Date" && n.arguments?.length && rel.startsWith("src/actions/")) {
      const params = actionParams(n, sf);
      const r = rootIdentifier(n.arguments[0]!);
      if (params && r && params.has(r)) actionDates.push(`${at(n)}  new Date(${n.arguments[0]!.getText(sf)})`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

console.log(`Security lint over ${files.length} files…`);
check("the scan is not vacuous", files.length > 500, String(files.length));
check("every server-side fetch passes a signal (or is on FETCH_ALLOWLIST)", unsignalled.length === 0, unsignalled.join("\n         "));
check("no action builds a Date straight from its parameters", actionDates.length === 0, actionDates.join("\n         "));
check("Papa.unparse only in src/lib/csv-export.ts", unparse.length === 0, unparse.join("\n         "));
check("every non-literal sql.raw site is reviewed", rawUnreviewed.length === 0, rawUnreviewed.join("\n         "));
const stale = Object.keys(SQL_RAW_ALLOWLIST).filter((k) => !rawSeen.has(k));
check("no sql.raw allowlist entry outlives its site", stale.length === 0, stale.join("\n         "));

// The rules must catch what they are for: run each against a known-bad snippet.
function scan(snippet: string, name = "src/actions/x.ts") {
  const sf = ts.createSourceFile(name, snippet, ts.ScriptTarget.Latest, true);
  let fetchHit = false;
  let dateHit = false;
  const v = (n: ts.Node) => {
    if (ts.isCallExpression(n) && n.expression.getText(sf) === "fetch") {
      const init = n.arguments[1];
      fetchHit ||= !(init && ts.isObjectLiteralExpression(init) && init.properties.some((p) => p.name?.getText(sf) === "signal"));
    }
    if (ts.isNewExpression(n) && n.expression.getText(sf) === "Date" && n.arguments?.length) {
      const params = actionParams(n, sf);
      const r = rootIdentifier(n.arguments[0]!);
      dateHit ||= !!(params && r && params.has(r));
    }
    ts.forEachChild(n, v);
  };
  v(sf);
  return { fetchHit, dateHit };
}
check("the fetch rule catches an unbounded call", scan(`await fetch("https://x.example/a");`).fetchHit);
check("…and passes a bounded one", !scan(`await fetch(u, { signal: AbortSignal.timeout(1) });`).fetchHit);
check("the date rule catches new Date(input.due) in an action", scan(`export const a = defineAction({}, async (userId, input: { due: string }) => new Date(input.due));`).dateHit);
check("…and ignores a date from the clock", !scan(`export const a = defineAction({}, async (userId, input: { n: number }) => new Date(Date.now() - input.n));`).dateHit);

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nSecurity lint clean.");
