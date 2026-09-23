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
import { finishCopy, type FinishSummary } from "../src/lib/imports/import-finish";

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
  [
    "trailing period",
    (t) => t.trimEnd().endsWith(".") && !t.trimEnd().endsWith("…"),
  ],
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
    if (broken(text))
      problems.push(`${where}  [${rule}]  ${text.slice(0, 90)}`);
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
      problems.push(
        `${where}  [raw error text in a toast — use friendlyError]`,
      );
    }
  }

  for (const m of src.matchAll(
    /new UserFacingError\(\s*(["`])((?:(?!\1)[^\\]|\\.)*)\1/g,
  )) {
    checkText(
      `${file}:${line(m.index!)} (UserFacingError)`,
      m[2].replace(/\$\{[^}]*\}/g, "{}"),
    );
  }
}

/**
 * The flat copy tables, read out of source.
 *
 * `IMPORT_COPY` and `IMPORT_FAILURE_COPY` are not toasts and are not in `toast-copy.ts`, so
 * without naming them here the guard would not see a single line of the import surface's
 * copy — which is most of what a person reads when an import goes wrong.
 */
const COPY_TABLES: { file: string; symbol: string }[] = [
  { file: "src/lib/toast-copy.ts", symbol: "TOAST_COPY" },
  { file: "src/lib/imports/import-copy.ts", symbol: "IMPORT_COPY" },
  { file: "src/lib/import-errors.ts", symbol: "IMPORT_FAILURE_COPY" },
];
for (const table of COPY_TABLES) {
  const tableSrc = readFileSync(table.file, "utf8");
  const start = tableSrc.indexOf(`export const ${table.symbol}`);
  if (start < 0) throw new Error(`${table.symbol} not found in ${table.file}`);
  const block = tableSrc.slice(start);
  let found = 0;
  for (const m of block.matchAll(
    /^\s+(\w+):\s*$|^\s+(\w+):\s*"((?:[^"\\]|\\.)*)"/gm,
  )) {
    if (m[3] === undefined) continue;
    found++;
    checkText(`${table.file} (${table.symbol}.${m[2]})`, m[3]);
  }
  // A guard on the guard: a renamed field or a reformatted table would otherwise pass here
  // without a single string being checked.
  if (found < 5) {
    throw new Error(
      `only ${found} strings read from ${table.symbol} — has its shape changed?`,
    );
  }
}

/**
 * The done card's words, which no amount of source reading would find.
 *
 * `finishCopy` builds every line it returns at runtime, out of counts — so the headline, the
 * detail and the button label are three strings a person reads that this guard had no way to
 * see. The table above covers `IMPORT_COPY`, including the undo's lines; this covers the
 * other half of the finish by running the function over the shapes it is actually given: a
 * plain import, one person, nobody new, a calendar file, several files at once, and a step
 * that didn't land.
 */
const FINISH_SUMMARIES: FinishSummary[] = [
  { importId: "i1", added: 19, existing: 6, meetingsLogged: 0, sources: ["Connections.csv"] },
  { importId: "i2", added: 1, existing: 0, meetingsLogged: 0, sources: ["Contacts.vcf"] },
  { importId: "i3", added: 0, existing: 25, meetingsLogged: 0, sources: ["Connections.csv"] },
  { importId: "i4", added: 0, existing: 0, meetingsLogged: 38, sources: ["work.ics"] },
  {
    importId: "i5",
    added: 12,
    existing: 3,
    meetingsLogged: 0,
    sources: ["Connections.csv", "messages.csv"],
  },
  {
    importId: "i6",
    added: 12,
    existing: 0,
    meetingsLogged: 0,
    sources: ["Connections.csv"],
    unfinished: "Your LinkedIn messages didn’t finish",
  },
];
let finishLines = 0;
for (const summary of FINISH_SUMMARIES) {
  const copy = finishCopy(summary);
  const where = `src/lib/imports/import-finish.ts (finishCopy ${summary.importId})`;
  for (const line of [copy.headline, copy.detail ?? "", copy.action.label]) {
    if (!line) continue;
    finishLines++;
    checkText(where, line);
    // Not one of the shared RULES: this one is about the finish's own connector budget, and
    // `checkText` skips short fragments that a chip is allowed to be.
    if ((line.match(/ — /g) ?? []).length > 1) {
      problems.push(`${where}  [two — connectors in one line]  ${line.slice(0, 90)}`);
    }
  }
}
// A guard on the guard: a `finishCopy` that started returning empty strings would otherwise
// sail through with nothing checked.
if (finishLines < 12) {
  throw new Error(
    `only ${finishLines} finish lines read — has finishCopy's shape changed?`,
  );
}

console.log("Toast copy");
console.log(
  `  ${toastCalls} toast calls, ${messagesChecked} messages checked (${finishLines} from the import finish)`,
);
if (toastCalls < 250) {
  // A guard on the guard: if the call pattern stopped matching, this would pass vacuously.
  throw new Error(
    `only ${toastCalls} toast calls found — has the call shape changed?`,
  );
}
if (problems.length) {
  console.error(`\n${problems.length} message(s) break the house voice:\n`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log("  ok  every message follows the house voice");
process.exit(0);
