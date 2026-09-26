/**
 * An exported function in a `"use server"` file is a POST endpoint, not just a function.
 *
 * Next.js mints a callable action id for every export of a `"use server"` module and serves
 * it to anyone who can reach the app — the UI is one caller, `curl` is another. See
 * `node_modules/next/dist/docs/01-app/02-guides/data-security.md` ("Server Actions ... must
 * be treated like public HTTP endpoints"). So an exported action that takes a user id from
 * its CALLER, rather than deriving one from the session, is a cross-account endpoint: a
 * signed-in user posts somebody else's id and gets — or changes — their data.
 *
 * This walks every `"use server"` module under `src/actions/` with the TypeScript parser and
 * flags any exported async function that accepts a user-id-shaped parameter without deriving
 * the user from the session in its own body.
 *
 * Parsed, not grepped: this repo has a documented case of a regex guard staying green
 * because the thing it was looking at had been commented out. The parser only ever sees real
 * declarations, so commented-out code cannot satisfy — or trip — this check.
 *
 * Flagged as user-id-shaped: a parameter named `userId`/`uid`/`accountId`/`ownerId`/
 * `clerkId` (and `targetUserId`, `subjectUserId`, … — anything ending in those), whether it
 * is a plain parameter, a destructured property, or a property of an inline object type.
 *
 * Counted as deriving the user from the session: `requireUserId` and the gates built on it
 * (`requireAdminUserId`, `requireUserForSurface`, `requireSyncUser`, `requireOutreachUser`,
 * `requireRecruitersUser`, `requireMeetingsUser`) — each takes no user id of its own and
 * reads the caller's identity from the Clerk session. `requireEntitlement` is NOT one: it
 * takes a userId, so it checks a plan, it does not establish who is asking.
 *
 * An action that legitimately needs an explicit user — an admin acting on someone else —
 * clears the check by gating on `requireAdminUserId` first. An action that needs to be
 * callable with an arbitrary user id and no session at all (a route handler, a cron job)
 * does not belong in `src/actions/` at all: move it to a plain module under `src/lib/` and
 * have the action import it, so no action id is minted for it. That is the shape
 * `src/actions/apple.ts` over `src/lib/apple.ts` already uses.
 *
 * `--report` prints the full export inventory instead of only the offenders.
 * Run: npx tsx scripts/smoke-action-user-scope.ts [--report]
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const ROOT = "src/actions";

/** Ends-with match, so `targetUserId` and `subjectUserId` are caught alongside `userId`. */
const USER_ID_NAME = /(^|[a-z])(userId|uid|accountId|ownerId|clerkId|clerkUserId)$/i;

/**
 * Helpers that establish WHO IS ASKING from the session. Each takes no user id of its own.
 * `requireEntitlement(userId, …)` is deliberately absent — it is handed a user, so it can
 * never tell you the caller is that user.
 */
const SESSION_DERIVING = new Set([
  "requireUserId",
  "requireAdminUserId",
  "requireUserForSurface",
  "requireSyncUser",
  "requireOutreachUser",
  "requireRecruitersUser",
  "requireMeetingsUser",
]);

/**
 * Exports that take a user id on purpose. One line per entry saying why it is safe.
 * Keyed `<file basename>#<export name>`.
 */
const ALLOWLIST: Record<string, string> = {
  // (empty — every export currently either derives its user from the session or has been
  // moved to a plain module under src/lib/. Add an entry here only with a reason that says
  // why a caller-supplied user id cannot be somebody else's.)
};

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return p.endsWith(".ts") || p.endsWith(".tsx") ? [p] : [];
  });
}

/** A `"use server"` directive at the top of the module (the file-level form). */
function isUseServerModule(sf: ts.SourceFile): boolean {
  for (const stmt of sf.statements) {
    // The prologue ends at the first statement that is not a bare string expression.
    if (!ts.isExpressionStatement(stmt) || !ts.isStringLiteral(stmt.expression)) break;
    if (stmt.expression.text === "use server") return true;
  }
  return false;
}

const hasExportModifier = (node: ts.Node): boolean =>
  ts.canHaveModifiers(node) &&
  (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

const isAsync = (node: ts.Node): boolean =>
  ts.canHaveModifiers(node) &&
  (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);

/** Every user-id-shaped name reachable from one parameter: plain, destructured, or in an
 *  inline object type. Returns the names so the report can say WHICH field tripped it. */
function userIdFieldsOf(param: ts.ParameterDeclaration): string[] {
  const found: string[] = [];

  // A plain parameter: `userId: string`
  if (ts.isIdentifier(param.name) && USER_ID_NAME.test(param.name.text)) found.push(param.name.text);

  // A destructured parameter: `{ userId, limit }` / `{ userId: who }`
  if (ts.isObjectBindingPattern(param.name)) {
    for (const el of param.name.elements) {
      const key = el.propertyName ?? el.name;
      if (ts.isIdentifier(key) && USER_ID_NAME.test(key.text)) found.push(key.text);
    }
  }

  // An inline object type: `input: { userId: string; note: string }`
  if (param.type) {
    const visit = (node: ts.Node) => {
      if (ts.isTypeLiteralNode(node)) {
        for (const member of node.members) {
          const name = member.name;
          if (name && ts.isIdentifier(name) && USER_ID_NAME.test(name.text)) found.push(name.text);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(param.type);
  }

  return found;
}

/** Whether this function's OWN body calls a session-deriving helper. Nested function
 *  bodies count: an action that derives the user inside a `try`, a callback, or an
 *  `await Promise.all([...])` has still established who is asking. */
function derivesUserFromSession(body: ts.Node | undefined): string[] {
  if (!body) return [];
  const calls: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : null;
      if (name && SESSION_DERIVING.has(name)) calls.push(name);
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return calls;
}

type ExportedFn = {
  file: string;
  name: string;
  line: number;
  userIdFields: string[];
  sessionCalls: string[];
};

function exportedAsyncFunctions(file: string, sf: ts.SourceFile): ExportedFn[] {
  const out: ExportedFn[] = [];

  const record = (
    name: string,
    node: ts.Node,
    params: readonly ts.ParameterDeclaration[],
    body: ts.Node | undefined
  ) => {
    out.push({
      file,
      name,
      line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
      userIdFields: params.flatMap(userIdFieldsOf),
      sessionCalls: derivesUserFromSession(body),
    });
  };

  for (const stmt of sf.statements) {
    // export async function foo(…) {}
    if (ts.isFunctionDeclaration(stmt) && hasExportModifier(stmt) && isAsync(stmt) && stmt.name) {
      record(stmt.name.text, stmt, stmt.parameters, stmt.body);
      continue;
    }

    // export const foo = async (…) => {}  /  = async function (…) {}
    if (ts.isVariableStatement(stmt) && hasExportModifier(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
        let init: ts.Expression = decl.initializer;
        // Unwrap a single wrapping call, e.g. `cache(async () => …)`.
        if (ts.isCallExpression(init) && init.arguments.length > 0) init = init.arguments[0]!;
        if ((ts.isArrowFunction(init) || ts.isFunctionExpression(init)) && isAsync(init)) {
          record(decl.name.text, decl, init.parameters, init.body);
        }
      }
    }
  }

  return out;
}

const reportOnly = process.argv.includes("--report");

const files = walk(ROOT).sort();
const useServerFiles: string[] = [];
const plainFiles: string[] = [];
const allExports: ExportedFn[] = [];

for (const file of files) {
  const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (!isUseServerModule(sf)) {
    plainFiles.push(file);
    continue;
  }
  useServerFiles.push(file);
  allExports.push(...exportedAsyncFunctions(file, sf));
}

console.log(
  `Scanned ${files.length} file(s) under ${ROOT}: ${useServerFiles.length} "use server", ` +
    `${plainFiles.length} plain module(s).`
);
if (plainFiles.length) {
  console.log(`  plain (no action ids minted, not checked): ${plainFiles.join(", ")}`);
}
console.log(`Found ${allExports.length} exported async function(s).\n`);

if (reportOnly) {
  let current = "";
  for (const fn of allExports) {
    if (fn.file !== current) {
      current = fn.file;
      console.log(`\n${fn.file}`);
    }
    const scope = fn.sessionCalls.length
      ? `session via ${[...new Set(fn.sessionCalls)].join(", ")}`
      : "NO session call";
    const taint = fn.userIdFields.length ? `  <-- takes ${[...new Set(fn.userIdFields)].join(", ")}` : "";
    console.log(`  :${String(fn.line).padEnd(5)} ${fn.name.padEnd(42)} ${scope}${taint}`);
  }
  console.log("");
}

// --- The check ---------------------------------------------------------------------------
console.log("exported actions derive their user from the session");

const offenders = allExports.filter((fn) => fn.userIdFields.length > 0 && fn.sessionCalls.length === 0);

for (const fn of offenders) {
  const key = `${fn.file.split("/").pop()}#${fn.name}`;
  const reason = ALLOWLIST[key];
  if (reason) {
    console.log(`  ok    ${key} takes a user id, allowlisted — ${reason}`);
    continue;
  }
  check(
    `${fn.file}:${fn.line} ${fn.name}() takes ${[...new Set(fn.userIdFields)].join(", ")} ` +
      `from its caller and never derives the user from the session`,
    false,
    "an exported Server Action is reachable by direct POST — derive the user with requireUserId(), " +
      "or move this to a plain module under src/lib/ so no action id is minted"
  );
}

if (!offenders.some((fn) => !ALLOWLIST[`${fn.file.split("/").pop()}#${fn.name}`])) {
  check(
    `no exported action takes a caller-supplied user id (${allExports.length} exports checked)`,
    true
  );
}

// A stale allowlist entry is a guard that has quietly stopped guarding.
for (const key of Object.keys(ALLOWLIST)) {
  const [base, name] = key.split("#");
  const stillOffends = offenders.some((fn) => fn.file.endsWith(`/${base}`) && fn.name === name);
  check(`allowlist entry ${key} still describes a real export`, stillOffends, stillOffends ? "" : "remove it");
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll action user-scoping checks passed.");
process.exit(0);
