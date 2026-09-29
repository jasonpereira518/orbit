/**
 * `consumeBucket(scope, key, policy)` takes the bucket NAME first and the per-caller key
 * second. Both are `string`, so TypeScript cannot catch a swap — and a swap is not silent
 * to users: `RateLimitedError` builds its message from `BUCKET_LABELS[scope] ?? scope`, so
 * a call written `consumeBucket(userId, "eventEnrich", …)` tells the person "You've hit the
 * user_2abc… limit" (their own internal id) instead of "the link lookup limit". It also
 * keys the bucket per user in the scope column, splitting any per-scope accounting.
 * `src/actions/events.ts` shipped exactly that swap in four places.
 *
 * This walks every `.ts`/`.tsx` under `src/` with the TypeScript parser and fails when a
 * `consumeBucket` call's FIRST argument is user-id-shaped: an identifier or property access
 * named `userId` / `uid` / `accountId` / `ownerId` / `clerkId` (or ending in one, so
 * `caller.userId` and `targetUserId` count). Parsed, not grepped, so commented-out code can
 * neither satisfy nor trip it.
 *
 * Run: npx tsx scripts/smoke-consume-bucket-args.ts
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const ROOT = "src";

/** Same shape as smoke-action-user-scope's matcher. */
const USER_ID_NAME = /(^|[a-z.])(userId|uid|accountId|ownerId|clerkId|clerkUserId)$/i;

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

/** The trailing name of `userId` / `caller.userId` / `ctx.user.userId`, else null. */
function trailingName(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return null;
}

type Call = { where: string; scopeText: string; swapped: boolean };

function consumeBucketCalls(file: string, source: string): Call[] {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const calls: Call[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "consumeBucket" &&
      node.arguments.length >= 2
    ) {
      const first = node.arguments[0];
      const name = trailingName(first);
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      calls.push({
        where: `${file}:${line}`,
        scopeText: first.getText(sf),
        swapped: name !== null && USER_ID_NAME.test(name),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return calls;
}

// Self-test: the matcher must catch the exact shape that shipped, and pass the right one —
// otherwise a green run below proves nothing.
console.log("matcher self-test");
const fixture = [
  `await consumeBucket(userId, "eventEnrich", RATE_LIMITS.eventEnrich);`,
  `await consumeBucket(caller.userId, "capture", RATE_LIMITS.capture);`,
  `await consumeBucket("eventEnrich", userId, RATE_LIMITS.eventEnrich);`,
  `// await consumeBucket(userId, "commented", RATE_LIMITS.chat);`,
].join("\n");
const fixtureCalls = consumeBucketCalls("fixture.ts", fixture);
check("finds the three live calls and skips the comment", fixtureCalls.length === 3, `${fixtureCalls.length}`);
check("flags `userId` first", fixtureCalls[0]?.swapped === true);
check("flags `caller.userId` first", fixtureCalls[1]?.swapped === true);
check("passes scope-first", fixtureCalls[2]?.swapped === false);

console.log("\nconsumeBucket call sites under src/");
const all = walk(ROOT)
  .sort()
  .flatMap((file) => consumeBucketCalls(file, readFileSync(file, "utf8")));
// Guard against a vacuous pass (renamed function, moved tree): the repo has dozens.
check("found consumeBucket call sites", all.length >= 20, `${all.length}`);
for (const call of all.filter((c) => c.swapped)) {
  check(
    `${call.where} passes the bucket name first`,
    false,
    `first argument is \`${call.scopeText}\`; the signature is consumeBucket(scope, key, policy)`,
  );
}
if (!all.some((c) => c.swapped)) check("no call passes a user id as the scope", true);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
process.exit(0);
