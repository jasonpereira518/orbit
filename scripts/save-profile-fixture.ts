/**
 * Turn a LinkedIn page you copied into a work-history eval fixture.
 *
 *   1. Open the profile in your browser, signed in.
 *   2. Click in the page, ⌘A, ⌘C.
 *   3. npx tsx scripts/save-profile-fixture.ts --url <the profile URL>
 *
 * Reads your clipboard (or --file / --stdin), cleans it the way the extension
 * cleans a page before sending it, and writes
 * scripts/eval-fixtures/extension-profile/<slug>.json — which is gitignored,
 * because it is a real person's data. Nothing here sends anything anywhere.
 *
 * The cleaning matters: the eval measures whether the model names an employer
 * the page never mentions, so the fixture has to be the text the model would
 * actually get. `collapseRepeatedLines` is imported from the extension itself
 * (LinkedIn renders most fields twice, once for screen readers), and the
 * trailing "People also viewed" block — other people's jobs — is cut, as the
 * extension's reader cuts it.
 *
 *   --url <url>        required; decides the filename and the section
 *   --name "Full Name" optional; the model is told whose page it is
 *   --expect "A, B, C" optional ground truth: every employer and school the
 *                      page lists. Without it the eval still checks that
 *                      nothing was invented, but cannot measure recall.
 *   --file <path>      read the text from a file instead of the clipboard
 *   --stdin            read the text from stdin
 *   --force            overwrite an existing fixture
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { collapseRepeatedLines } from "../extension/src/inject/dom/text";

const DIR = join("scripts", "eval-fixtures", "extension-profile");
const MIN_CHARS = 500;

/** Headings that introduce OTHER people. Mirrors the extension's denylist. */
const OTHER_PEOPLE = [
  "people also viewed",
  "more profiles for you",
  "people you may know",
  "others named",
  "others viewed",
  "similar profiles",
  "explore premium",
  "you might like",
];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(name);

function fail(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

function readInput(): string {
  const file = arg("--file");
  if (file) return readFileSync(file, "utf8");
  if (has("--stdin")) return readFileSync(0, "utf8");
  try {
    return execFileSync("pbpaste", { encoding: "utf8", maxBuffer: 20_000_000 });
  } catch {
    fail("Couldn't read the clipboard. Use --file <path> or --stdin instead.");
  }
}

/**
 * Everything from the first "other people" heading that appears after the
 * profile's own content has started. Guarded so a page that mentions one of
 * these phrases early isn't truncated to nothing.
 */
function cutOtherPeople(text: string): { text: string; cut: number } {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^(experience|about|education)$/i.test(l.trim()));
  const from = start >= 0 ? start + 1 : Math.floor(lines.length / 2);
  const at = lines.findIndex(
    (l, i) => i >= from && OTHER_PEOPLE.some((h) => l.trim().toLowerCase() === h)
  );
  if (at < 0) return { text, cut: 0 };
  const kept = lines.slice(0, at).join("\n");
  return { text: kept, cut: text.length - kept.length };
}

function clean(raw: string): string {
  const { text, cut } = cutOtherPeople(
    collapseRepeatedLines(raw.replace(/\r\n?/g, "\n"))
      .replace(/[ \t ]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
  if (cut > 0) console.log(`  cut ${cut.toLocaleString()} characters of other people's profiles`);
  return text;
}

const url = arg("--url");
if (!url) fail('Pass --url "https://www.linkedin.com/in/<slug>/…" so the fixture knows whose page it is.');
const slug = url.match(/linkedin\.com\/in\/([^/?#]+)/i)?.[1];
if (!slug) fail(`"${url}" isn't a LinkedIn profile URL (https://www.linkedin.com/in/<slug>/…).`);

const section = /details\/experience/i.test(url)
  ? "experience"
  : /details\/education/i.test(url)
    ? "education"
    : undefined;

const text = clean(readInput());
if (text.length < MIN_CHARS) {
  fail(`Only ${text.length} characters — that isn't a whole profile. Click inside the page, then ⌘A, ⌘C, and try again.`);
}

const expect = arg("--expect")
  ?.split(",")
  .map((s) => s.trim())
  .filter(Boolean);

mkdirSync(DIR, { recursive: true });
const file = join(DIR, `${slug.toLowerCase()}${section ? `-details-${section}` : ""}.json`);
if (existsSync(file) && !has("--force")) {
  fail(`${file} already exists. Pass --force to replace it.`);
}

writeFileSync(
  file,
  `${JSON.stringify(
    {
      url,
      name: arg("--name") ?? null,
      text,
      ...(expect?.length ? { expect: { employers: expect } } : {}),
    },
    null,
    2
  )}\n`
);

// A summary with nothing personal in it, so it is safe to paste anywhere.
const lines = text.split("\n").length;
const shortened = /show all \d+ experiences?/i.test(text);
console.log(
  [
    `\n  wrote ${file}`,
    `  ${text.length.toLocaleString()} characters · ${lines} lines · section: ${section ?? "profile"}`,
    `  lists only some roles ("Show all N experiences"): ${shortened ? "yes" : "no"}`,
    `  ground truth given: ${expect?.length ? `${expect.length} names` : "no (recall won't be measured)"}`,
    text.length >= 40_000
      ? "  NOTE: over 40,000 characters, so the eval will cut it — same as production would."
      : "",
    "",
    "  Next: npx tsx scripts/eval-extension-profile.ts --dry-run",
  ]
    .filter(Boolean)
    .join("\n")
);
