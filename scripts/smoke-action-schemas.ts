/**
 * The central validation layer (FIX_PLAN 3.1): every Server Action goes through
 * `defineAction`, which resolves the caller, then parses the arguments, then runs the
 * handler — in that order, before any handler code.
 *
 *   1. Coverage. Every export of every `"use server"` module under `src/actions` is either a
 *      type or `export const x = defineAction(...)`. A plain `export async function` is a
 *      public POST endpoint with no schema, and is listed by name.
 *   2. Public actions. `auth: "public"` is the explicit opt-out; it is allowed only for the
 *      actions listed below, each of which is meant for people without an account.
 *   3. The wrapper: gate before parse before handler; a bad argument is a `UserFacingError`
 *      with a plain sentence (or the action's own failure value); valid input reaches the
 *      handler unchanged.
 *   4. The shared schemas in `src/lib/input/schemas.ts`.
 *   5. L-02: an event link that does not canonicalise is refused, not stored as typed.
 *
 * Pure: no database, no network. Run: npx tsx scripts/smoke-action-schemas.ts
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { z } from "zod";
import { defineAction, failResult, invalidInputMessage, isDefinedAction } from "../src/lib/input/action";
import {
  anyNumber,
  cappedText,
  clientDateField,
  httpUrl,
  optionalClientDateField,
  optionalHttpUrl,
  uuid,
} from "../src/lib/input/schemas";
import { canonicalEventUrlOrRefuse } from "../src/lib/events/event-url-input";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

/** Actions that are deliberately reachable without signing in, by `file:export`. */
const PUBLIC_ACTIONS = new Set([
  // The public contact page.
  "contact.ts:isContactFormEnabled",
  "contact.ts:submitContactMessage",
  // The waitlist: joining, naming the pass, opening or sharing a pass, voting on the poll.
  "interest-list.ts:joinInterestList",
  "interest-list.ts:saveInterestListName",
  "interest-list.ts:recordPassCheckAction",
  "interest-list.ts:recordWaitlistShare",
  "waitlist-poll.ts:setPollStars",
  // OAuth callbacks: they run before any session check and trust only the state cookie.
  "events.ts:consumeEventbriteOAuthState",
  "gmail.ts:consumeGmailOAuthState",
  "outlook.ts:consumeOutlookOAuthState",
]);

// ---------------------------------------------------------------------------------------
console.log("Coverage: every export in src/actions is a defineAction...");

const ACTIONS_DIR = join(process.cwd(), "src/actions");
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

const offenders: string[] = [];
const publicSeen: string[] = [];
let actionCount = 0;
let moduleCount = 0;

function isDefineActionCall(node: ts.Expression | undefined): node is ts.CallExpression {
  return Boolean(node && ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "defineAction");
}

function authOf(call: ts.CallExpression): string | null {
  const cfg = call.arguments[0];
  if (!cfg || !ts.isObjectLiteralExpression(cfg)) return null;
  for (const prop of cfg.properties) {
    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === "auth") {
      return ts.isStringLiteral(prop.initializer) ? prop.initializer.text : "gate";
    }
  }
  return null;
}

for (const file of walk(ACTIONS_DIR)) {
  const text = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const first = sf.statements[0];
  const useServer =
    first && ts.isExpressionStatement(first) && ts.isStringLiteral(first.expression) && first.expression.text === "use server";
  if (!useServer) continue;
  moduleCount++;
  const rel = relative(ACTIONS_DIR, file);
  const has = (node: ts.Node, kind: ts.SyntaxKind) =>
    ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === kind);

  for (const stmt of sf.statements) {
    if (ts.isTypeAliasDeclaration(stmt) || ts.isInterfaceDeclaration(stmt)) continue;
    if (ts.isExportDeclaration(stmt)) {
      if (stmt.isTypeOnly) continue;
      const clause = stmt.exportClause;
      if (clause && ts.isNamedExports(clause) && clause.elements.every((e) => e.isTypeOnly)) continue;
      offenders.push(`${rel}: re-export \`${stmt.getText().slice(0, 60)}\``);
      continue;
    }
    if (ts.isExportAssignment(stmt)) {
      offenders.push(`${rel}: export default`);
      continue;
    }
    if (!has(stmt, ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isFunctionDeclaration(stmt)) {
      offenders.push(`${rel}:${stmt.name?.text ?? "?"} is a plain exported function`);
      continue;
    }
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        const name = decl.name.getText();
        if (!isDefineActionCall(decl.initializer)) {
          offenders.push(`${rel}:${name} is exported without defineAction`);
          continue;
        }
        actionCount++;
        const auth = authOf(decl.initializer);
        if (auth === "public") publicSeen.push(`${rel}:${name}`);
        if (decl.initializer.arguments.length !== 2) offenders.push(`${rel}:${name}: defineAction(config, handler) expected`);
      }
      continue;
    }
    if (ts.isClassDeclaration(stmt) || ts.isEnumDeclaration(stmt)) {
      offenders.push(`${rel}: exported ${ts.SyntaxKind[stmt.kind]}`);
    }
  }
}

check(`${moduleCount} "use server" modules found`, moduleCount >= 60, `found ${moduleCount}`);
check(`${actionCount} actions defined through defineAction`, actionCount >= 450, `found ${actionCount}`);
check("no export bypasses defineAction", offenders.length === 0, offenders.join("\n       "));
const unexpectedPublic = publicSeen.filter((n) => !PUBLIC_ACTIONS.has(n));
check(
  'auth: "public" only on the allow-listed actions',
  unexpectedPublic.length === 0,
  `not allow-listed: ${unexpectedPublic.join(", ")} — add it to PUBLIC_ACTIONS with the reason, or give it a gate`
);
const missingPublic = [...PUBLIC_ACTIONS].filter((n) => !publicSeen.includes(n));
check("every allow-listed public action still exists", missingPublic.length === 0, missingPublic.join(", "));

// ---------------------------------------------------------------------------------------
async function main() {
  console.log("\ndefineAction: gate, then parse, then handler...");

  const order: string[] = [];
  const traced = z.tuple([
    z.string().refine(() => {
      order.push("parse");
      return true;
    }),
  ]);
  const ordered = defineAction(
    {
      auth: async () => {
        order.push("gate");
        return "user-1";
      },
      schema: traced,
    },
    async (who, value: string) => {
      order.push("handler");
      return `${who}:${value}`;
    }
  );
  check("returns the handler's value", (await ordered("x")) === "user-1:x");
  check("runs gate → parse → handler", order.join(",") === "gate,parse,handler", order.join(","));
  check("is marked as a defined action", isDefinedAction(ordered));

  order.length = 0;
  const refused = defineAction(
    {
      auth: async () => {
        order.push("gate");
        throw new Error("not signed in");
      },
      schema: traced,
    },
    async () => {
      order.push("handler");
      return "ran";
    }
  );
  let gateError: unknown = null;
  try {
    await (refused as unknown as (...a: unknown[]) => Promise<unknown>)("x");
  } catch (e) {
    gateError = e;
  }
  check("a refused gate throws its own error", gateError instanceof Error && gateError.message === "not signed in");
  check("…before parsing or running anything", order.join(",") === "gate", order.join(","));

  console.log("\nBad input...");
  let handlerRan = false;
  const strict = defineAction(
    { auth: async () => "u", schema: z.tuple([uuid, z.looseObject({ title: z.string() })]) },
    async (_u, _id: string, _input: { title: string }) => {
      handlerRan = true;
      return "ok";
    }
  );
  const rejection = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      return null;
    } catch (e) {
      return e as Error;
    }
  };
  const bad = await rejection(() =>
    (strict as unknown as (...a: unknown[]) => Promise<unknown>)("not-a-uuid", { title: "t" })
  );
  check("a malformed id is a UserFacingError", bad?.name === "UserFacingError", String(bad));
  check("…with a plain sentence, not a zod dump", Boolean(bad && !/expected|received|\[|\{/.test(bad.message)), bad?.message);
  const badTitle = await rejection(() =>
    (strict as unknown as (...a: unknown[]) => Promise<unknown>)("2f6b7db9-f223-4527-9701-0e3fd155b522", { title: 42 })
  );
  check("a wrong type names the field", Boolean(badTitle?.message.includes("title")), badTitle?.message);
  const nonObject = await rejection(() =>
    (strict as unknown as (...a: unknown[]) => Promise<unknown>)("2f6b7db9-f223-4527-9701-0e3fd155b522", "x")
  );
  check("a non-object body is refused", nonObject?.name === "UserFacingError");
  check("the handler never ran on bad input", !handlerRan);

  const resultShaped = defineAction(
    { auth: async () => "u", schema: z.tuple([z.string()]), invalid: failResult },
    async (_u, _s: string): Promise<{ ok: true } | { ok: false; error: string }> => ({ ok: true })
  );
  const asData = await (resultShaped as unknown as (...a: unknown[]) => Promise<{ ok: boolean; error?: string }>)(7);
  check("a result-shaped action returns its failure instead of throwing", asData.ok === false && typeof asData.error === "string");

  const gateAsData = defineAction(
    {
      auth: async (): Promise<string> => {
        throw new Error("signed out");
      },
      invalid: failResult,
      onGateError: async (err) => ({ ok: false as const, error: `caught: ${(err as Error).message}` }),
    },
    async (): Promise<{ ok: true } | { ok: false; error: string }> => ({ ok: true })
  );
  const gateResult = await gateAsData();
  check("onGateError keeps an old in-try gate's failure-as-data", !gateResult.ok && gateResult.error === "caught: signed out");

  console.log("\nValid input passes through unchanged...");
  let received: unknown[] = [];
  const passthrough = defineAction(
    {
      auth: async () => "u",
      schema: z.tuple([
        z.looseObject({ title: z.string(), when: optionalClientDateField("due date") }),
        anyNumber.optional(),
      ]),
    },
    async (_u, input: { title: string; when?: string | null; extra?: string }, n?: number) => {
      received = [input, n];
      return null;
    }
  );
  const input = { title: "  Call Ada  ", when: "2026-10-17", extra: "kept" };
  await passthrough(input, 3);
  check("strings are not trimmed or rewritten", JSON.stringify(received[0]) === JSON.stringify(input));
  check("unknown keys survive (shape check, not a strip)", (received[0] as { extra?: string }).extra === "kept");
  await passthrough({ title: "t" });
  check("a missing optional trailing argument is fine", received[1] === undefined);
  await (passthrough as unknown as (...a: unknown[]) => Promise<unknown>)({ title: "t" }, 1, "extra", { more: true });
  check("arguments past the tuple are dropped, not refused", received[1] === 1);
  const noArgs = defineAction({ auth: async () => "u" }, async () => "fine");
  check("an action without a schema takes no arguments", (await noArgs()) === "fine");

  console.log("\nShared schemas...");
  check("uuid accepts a uuid", uuid.safeParse("2f6b7db9-f223-4527-9701-0e3fd155b522").success);
  for (const v of ["", "1", "x' or 1=1", 42, null]) check(`uuid refuses ${JSON.stringify(v)}`, !uuid.safeParse(v).success);
  check("clientDateField accepts an ISO string, unchanged", clientDateField().parse("2026-10-17T09:00:00Z") === "2026-10-17T09:00:00Z");
  for (const v of ["garbage", "3000-01-01", "", {}]) check(`clientDateField refuses ${JSON.stringify(v)}`, !clientDateField().safeParse(v).success);
  check(
    "optionalClientDateField accepts absence",
    [undefined, null, ""].every((v) => optionalClientDateField().safeParse(v).success)
  );
  const dateErr = optionalClientDateField("due date").safeParse("nope");
  check(
    "a bad date's message names the field",
    !dateErr.success && invalidInputMessage(dateErr.error) === "That due date doesn’t look right"
  );
  check("httpUrl accepts https", httpUrl.safeParse("https://example.com/x").success);
  for (const v of ["javascript:alert(1)", "data:text/html,x", "vbscript:x"]) check(`httpUrl refuses ${v}`, !httpUrl.safeParse(v).success);
  check("optionalHttpUrl accepts null and blank", optionalHttpUrl.safeParse(null).success && optionalHttpUrl.safeParse("  ").success);
  check("cappedText strips NUL and bidi, and caps", cappedText(5).parse("a\u0000b‮cdefgh") === "abcde");
  check("anyNumber accepts NaN (handlers clamp it themselves)", anyNumber.safeParse(Number.NaN).success);
  check("anyNumber refuses a numeric string", !anyNumber.safeParse("3").success);

  console.log("\nL-02: event links that do not canonicalise are refused...");
  const refusedLink = (raw: string) => {
    try {
      canonicalEventUrlOrRefuse(raw);
      return null;
    } catch (e) {
      return e as Error;
    }
  };
  for (const raw of ["javascript:alert(document.cookie)", "data:text/html,<script>1</script>", "not a link at all"]) {
    const err = refusedLink(raw);
    check(`refuses ${JSON.stringify(raw)}`, err?.name === "UserFacingError", String(err));
  }
  check("a blank link is no link", canonicalEventUrlOrRefuse("   ") === null && canonicalEventUrlOrRefuse(null) === null);
  check("a real link comes back canonical", /^https:\/\/lu\.ma\//.test(canonicalEventUrlOrRefuse("https://lu.ma/abc123?tk=secret") ?? ""));
  const eventsSource = readFileSync(join(ACTIONS_DIR, "events.ts"), "utf8");
  check(
    "createEvent and updateEvent no longer fall back to the raw link",
    !/input\.url \?\? null/.test(eventsSource) && (eventsSource.match(/canonicalEventUrlOrRefuse\(/g) ?? []).length >= 2
  );

  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll action-schema checks passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
