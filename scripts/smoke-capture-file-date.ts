/**
 * What date a dropped meeting-note file is about.
 *
 * Two failure modes are pinned. Reading a date that ISN'T one silently shifts every relative
 * reminder in that note ("in two weeks" counts from the anchor), so an ambiguous filename
 * must stay unread rather than be guessed. And `File.lastModified` must not be believed when
 * it is really the copy time — a file pulled out of Drive or an email attachment carries
 * today's date, which would look like evidence and be worthless.
 *
 * Run: npx tsx scripts/smoke-capture-file-date.ts
 */

import {
  MTIME_MIN_AGE_MS,
  anchorForFile,
  dateFromFilename,
} from "../src/lib/capture/file-date";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const NOW = new Date(2026, 8, 16, 12, 0, 0, 0); // 2026-09-16

console.log("\ndates a filename really carries");

{
  const cases: Array<[string, string]> = [
    ["2026-03-15.md", "2026-03-15"],
    ["2026_03_15 standup.txt", "2026-03-15"],
    ["2026.03.15-notes.md", "2026-03-15"],
    ["notes 2026-03-15.md", "2026-03-15"],
    ["20260315.txt", "2026-03-15"],
    ["IMG_20260315_093000.jpg", "2026-03-15"],
    ["Mar 15 2026 - coffee with Maya.md", "2026-03-15"],
    ["March-15-2026.md", "2026-03-15"],
    ["15 March 2026 notes.txt", "2026-03-15"],
    ["15th Mar 2026.md", "2026-03-15"],
    // One component > 12 settles the order without guessing.
    ["15-03-2026.md", "2026-03-15"],
    ["03-15-2026.md", "2026-03-15"],
  ];
  for (const [name, iso] of cases) {
    check(`"${name}" -> ${iso}`, dateFromFilename(name, NOW) === iso, String(dateFromFilename(name, NOW)));
  }
}

console.log("\nfilenames that must NOT yield a date");

{
  const rejects = [
    // THE AMBIGUITY RULE. Both ≤ 12, so this is 3 April or 4 March depending on who named
    // it. Guessing shifts every relative reminder in the note.
    "03-04-2026.md",
    "notes-v2.txt",
    "notes.md",
    "standup.md",
    "meeting notes (final).docx",
    "2026-13-05.md", // month 13
    "2026-02-31.md", // 31 February is not a day
    "1985-03-15.md", // before MIN_YEAR
    "2099-03-15.md", // beyond next year: a build number, not a meeting
    "v2026.md",
    "budget-2026.md",
  ];
  for (const name of rejects) {
    check(`"${name}" -> null`, dateFromFilename(name, NOW) === null, String(dateFromFilename(name, NOW)));
  }
}

console.log("\nthe extension never leaks into the date");

{
  check("a .md suffix is stripped first", dateFromFilename("2026-03-15.md", NOW) === "2026-03-15");
  check("no false match from the extension", dateFromFilename("report.2026", NOW) === null, String(dateFromFilename("report.2026", NOW)));
}

console.log("\nprecedence: filename, then a genuinely old mtime, then nothing");

{
  const named = anchorForFile({ name: "2026-03-15 standup.md", lastModified: NOW.getTime() }, NOW);
  check("a filename date wins over mtime", named.iso === "2026-03-15" && named.source === "filename", JSON.stringify(named));
}
{
  const old = new Date(2026, 2, 1, 9, 0, 0, 0).getTime(); // 2026-03-01
  const guess = anchorForFile({ name: "standup.md", lastModified: old }, NOW);
  check("an old mtime is used when the name says nothing", guess.iso === "2026-03-01" && guess.source === "mtime", JSON.stringify(guess));
}

// THE GUARD. A file copied out of Drive minutes ago has today's mtime, and believing it
// would date a six-month-old meeting as today while looking authoritative.
{
  const justCopied = NOW.getTime() - 60_000;
  const guess = anchorForFile({ name: "standup.md", lastModified: justCopied }, NOW);
  check("a fresh mtime is ignored", guess.iso === null && guess.source === "none", JSON.stringify(guess));
}
{
  const justUnderADay = NOW.getTime() - (MTIME_MIN_AGE_MS - 60_000);
  check("just under the threshold is still ignored", anchorForFile({ name: "x.md", lastModified: justUnderADay }, NOW).iso === null);
  const justOver = NOW.getTime() - (MTIME_MIN_AGE_MS + 60_000);
  check("just over it is used", anchorForFile({ name: "x.md", lastModified: justOver }, NOW).source === "mtime");
}
{
  // Browsers hand back 0 (or nothing) for a file with no mtime.
  check("a zero mtime is ignored", anchorForFile({ name: "x.md", lastModified: 0 }, NOW).source === "none");
  check("a missing mtime is ignored", anchorForFile({ name: "x.md" }, NOW).source === "none");
  check("a NaN mtime is ignored", anchorForFile({ name: "x.md", lastModified: Number.NaN }, NOW).source === "none");
}
{
  const guess = anchorForFile({ name: "notes.md" }, NOW);
  check("nothing to go on yields no date", guess.iso === null && guess.source === "none");
}

console.log("\nAll capture file-date checks passed.");
