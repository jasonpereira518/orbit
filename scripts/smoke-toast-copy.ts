/**
 * Guards the toast voice, so it cannot drift back one call site at a time.
 *
 * The friendlier-toasts pass (docs/superpowers/specs/2026-09-10-friendlier-toasts-design.md)
 * rewrote ~300 toast messages. Before it, one save failure was worded four ways, "Could
 * not X" competed with "X failed" and "Couldn't X", terminal periods split along a
 * directory line, and apostrophes were a mix of straight and curly. None of that is
 * something a reviewer reliably catches in a diff, so this does.
 *
 * It reads every `toast.*(...)` call in src/, plus `TOAST_COPY` and every
 * `UserFacingError` message (both are shown to people verbatim), and checks the static
 * text — string literals, and the literal parts of template strings.
 *
 * Rules:
 *   - Curly apostrophes. "don't" → "don’t".
 *   - "Couldn’t", never "Could not".
 *   - Never "failed" — say what did not happen: "didn’t save", "didn’t finish".
 *   - No trailing period on a message. " — " joins an outcome to its next step instead.
 *   - No raw `err.message` or `toUserFacingError(...).message` inside a toast. In
 *     production Next.js replaces a thrown Server Action message with a digest, so that
 *     shape shows a paragraph about Server Components; in development it shows raw
 *     provider bodies. Use `friendlyError(err, "<copy>")`.
 *
 * Run: npx tsx scripts/smoke-toast-copy.ts
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = "src";
const TOAST_CALL = /\btoast\.(error|success|message|warning|info)\(/g;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

/** Index of the paren that closes the call whose argument list starts at `i`. */
function callEnd(src: string, i: number): number {
  let depth = 1;
  let quote: string | null = null;
  let j = i;
  while (j < src.length && depth) {
    const c = src[j];
    if (quote) {
      if (c === "\\") {
        j += 2;
        continue;
      }
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    j++;
  }
  return j - 1;
}

/** The static text of every string and template literal in `code`. */
function staticTexts(code: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(/"((?:[^"\\]|\\.)*)"/g)) out.push(m[1]);
  for (const m of code.matchAll(/`((?:[^`\\]|\\.)*)`/g)) {
    out.push(m[1].replace(/\$\{[^}]*\}/g, "{}"));
  }
  return out;
}

const RULES: [string, (text: string) => boolean][] = [
  ["straight apostrophe — use ’", (t) => /\w'\w/.test(t)],
  ['"Could not" — use "Couldn’t"', (t) => /\bcould not\b/i.test(t)],
  ['"failed" — say what did not happen', (t) => /\bfailed\b/i.test(t)],
  ["trailing period", (t) => t.trimEnd().endsWith(".") && !t.trimEnd().endsWith("…")],
];

// Text that is not a message: object keys, `params.get("reason")`, pluralisation
// fragments, action labels. Only phrases of a few words are checked.
const isMessage = (t: string) => t.length >= 4 && /\s/.test(t.trim());

const problems: string[] = [];
let toastCalls = 0;
let messagesChecked = 0;

function checkText(where: string, text: string) {
  if (!isMessage(text)) return;
  messagesChecked++;
  for (const [rule, broken] of RULES) {
    if (broken(text)) problems.push(`${where}  [${rule}]  ${text.slice(0, 90)}`);
  }
}

for (const file of walk(ROOT)) {
  const src = readFileSync(file, "utf8");
  const line = (at: number) => src.slice(0, at).split("\n").length;

  for (const m of src.matchAll(TOAST_CALL)) {
    toastCalls++;
    const start = m.index! + m[0].length;
    const arg = src.slice(start, callEnd(src, start));
    const where = `${file}:${line(m.index!)}`;
    for (const text of staticTexts(arg)) checkText(where, text);
    if (/\b(err|e|error)\.message\b|toUserFacingError\(/.test(arg)) {
      problems.push(`${where}  [raw error text in a toast — use friendlyError]`);
    }
  }

  for (const m of src.matchAll(/new UserFacingError\(\s*(["`])((?:(?!\1)[^\\]|\\.)*)\1/g)) {
    checkText(`${file}:${line(m.index!)} (UserFacingError)`, m[2].replace(/\$\{[^}]*\}/g, "{}"));
  }
}

const copySrc = readFileSync("src/lib/toast-copy.ts", "utf8");
const copyBlock = copySrc.slice(copySrc.indexOf("export const TOAST_COPY"));
for (const m of copyBlock.matchAll(/^\s+(\w+):\s*"((?:[^"\\]|\\.)*)"/gm)) {
  checkText(`src/lib/toast-copy.ts (TOAST_COPY.${m[1]})`, m[2]);
}

console.log("Toast copy");
console.log(`  ${toastCalls} toast calls, ${messagesChecked} messages checked`);
if (toastCalls < 250) {
  // A guard on the guard: if the call pattern stopped matching, this would pass vacuously.
  throw new Error(`only ${toastCalls} toast calls found — has the call shape changed?`);
}
if (problems.length) {
  console.error(`\n${problems.length} message(s) break the house voice:\n`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log("  ok  every message follows the house voice");
process.exit(0);
