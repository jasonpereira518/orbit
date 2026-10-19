/**
 * The input helpers every boundary uses (audit M-04, M-05, L-11): client dates, ids and
 * free text. Pure: no database. Run: npx tsx scripts/smoke-input-helpers.ts
 */
import { optionalClientDate, parseClientDate, requireClientDate } from "../src/lib/input/dates";
import { isUuid } from "../src/lib/input/ids";
import { TEXT_LIMITS, cleanText, cleanTextList, stripInvisibleFormatting } from "../src/lib/input/text";
import { isLinkedInProfileUrl, isSafeWebsiteUrl } from "../src/lib/contact-input";
import { normalizeLinkedinUrl } from "../src/lib/recruiters";
import { toSpreadsheetCsv } from "../src/lib/csv-export";
import { cleanContactFreeText, normalizeContactInput } from "../src/lib/contact-input";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}
const throws = (fn: () => unknown, name?: string) => {
  try {
    fn();
    return false;
  } catch (e) {
    return name ? (e as Error).name === name : true;
  }
};

console.log("Client dates...");
for (const bad of ["not-a-date", "2024-13-45", "99999999999999999", "Invalid", "0001-01-01", "3000-01-01", {}, [], true]) {
  check(`parseClientDate(${JSON.stringify(bad)}) → null`, parseClientDate(bad) === null);
}
check("an ISO instant parses", parseClientDate("2026-10-17T09:00:00Z")?.toISOString() === "2026-10-17T09:00:00.000Z");
check("a date-only string parses", parseClientDate("2026-10-17") !== null);
check("a Date is copied, not aliased", (() => { const d = new Date(); return parseClientDate(d) !== d; })());
check("absent → null for optional", optionalClientDate(undefined) === null && optionalClientDate(null) === null && optionalClientDate("") === null);
check("garbage → UserFacingError for optional, never RangeError", throws(() => optionalClientDate("garbage", "due date"), "UserFacingError"));
check("the error names the field", (() => { try { optionalClientDate("x", "due date"); } catch (e) { return (e as Error).message.includes("due date"); } return false; })());
check("required rejects absence", throws(() => requireClientDate(undefined), "UserFacingError"));

console.log("\nIds...");
check("a uuid passes", isUuid("2f6b7db9-f223-4527-9701-0e3fd155b522"));
for (const bad of ["", "x' or 1=1", "2f6b7db9f22345279701", 42, null, "2f6b7db9-f223-4527-9701-0e3fd155b52"]) {
  check(`isUuid(${JSON.stringify(bad)}) is false`, !isUuid(bad));
}

console.log("\nFree text...");
check("NUL is stripped", cleanText("a\u0000b", 10) === "ab");
check("other C0 controls and DEL are stripped", cleanText("a\u0001\u0008\u000B\u001F\u007Fb", 10) === "ab");
check("tab and newline survive", cleanText("a\tb\nc", 10) === "a\tb\nc");
check("CRLF and CR fold to LF", cleanText("a\r\nb\rc", 10) === "a\nb\nc");
check("NFC: decomposed é equals composed é", cleanText("é", 10) === "é");
check("capped by code point, never splitting an emoji", cleanText("🚀🚀🚀", 2) === "🚀🚀");
check("a 1 MB string is capped", cleanText("A".repeat(1_000_000), TEXT_LIMITS.title).length === TEXT_LIMITS.title);
check("lists drop blanks, cap entries and length", JSON.stringify(cleanTextList(["  ", "a\u0000", "b".repeat(9)], 3, 1)) === JSON.stringify(["a"]));
check("lists cap the number of entries", cleanTextList(Array.from({ length: 10_000 }, (_, i) => `t${i}`), 10).length === 100);

console.log("\nContact input...");
const cleaned = cleanContactFreeText({ fullName: "Null\u0000Byte", notes: "N".repeat(200_000), keyFacts: Array.from({ length: 500 }, () => "f"), tagNames: ["x".repeat(500)] });
check("a NUL in a name is stripped", cleaned.fullName === "NullByte");
check("notes are capped", (cleaned.notes ?? "").length === TEXT_LIMITS.rawNotes);
check("key facts are capped in count", (cleaned.keyFacts ?? []).length === 100);
check("a tag is capped in length", (cleaned.tagNames ?? [])[0]?.length === TEXT_LIMITS.tag);
const strict = normalizeContactInput({ fullName: "Ada\u0000 Lovelace" });
check("strict normalisation stores the cleaned name", strict.ok && strict.value.fullName === "Ada Lovelace");
const lenient = normalizeContactInput({ fullName: "Grace", notes: "x\u0000y" } as never, "lenient");
check("lenient normalisation cleans too", lenient.ok && lenient.value.notes === "xy");
check("a name that is only control characters is still refused", !normalizeContactInput({ fullName: "\u0000\u0001" }).ok);


console.log("Invisible formatting (audit L-03, EC-UNI-1)...");
check("a bidi override is stripped", cleanText("Al\u202Eecila\u202C Smith", 100) === "Alecila Smith");
check("zero-width spaces are stripped", cleanText("\u200B\u200Bhidden", 100) === "hidden");
check("isolates, LRM/RLM, word joiner and BOM are stripped", stripInvisibleFormatting("a\u2066b\u2069c\u200Ed\u200Fe\u2060f\uFEFF") === "abcdef");
check("a ZWJ emoji sequence survives", cleanText("👩\u200D💻 dev", 100) === "👩\u200D💻 dev");
check("a Persian ZWNJ survives", cleanText("می\u200Cخواهم", 100) === "می\u200Cخواهم");
check("Hebrew, Arabic and CJK text is untouched", cleanText("מישהו عربي 名字", 100) === "מישהו عربي 名字");

console.log("URL schemes (audit EC-URL-1)...");
for (const bad of ["javascript:alert(1)", "data:text/html,<script>x</script>", "vbscript:msgbox", "https://user:pw@example.com"]) {
  check(`website ${JSON.stringify(bad)} is refused`, !isSafeWebsiteUrl(bad));
}
for (const good of ["https://example.com", "http://example.com/a?b=1", "example.com"]) {
  check(`website ${JSON.stringify(good)} is accepted`, isSafeWebsiteUrl(good));
}
check("a javascript: link mentioning linkedin.com/ is not a LinkedIn URL", !isLinkedInProfileUrl("javascript:alert(1)//linkedin.com/in/x"));
check("a real LinkedIn URL still is", isLinkedInProfileUrl("uk.linkedin.com/in/ada") && isLinkedInProfileUrl("https://www.linkedin.com/in/ada"));
check("a LinkedIn URL on another host is not", !isLinkedInProfileUrl("https://evil.example.com/in/ada"));
check("an unparseable recruiter LinkedIn URL normalises to null", normalizeLinkedinUrl("javascript:alert(1)") === null);
{
  const strict = normalizeContactInput({ fullName: "Ada", website: "javascript:alert(1)" }, "strict");
  check("strict mode refuses a javascript: website", !strict.ok);
  const lenient = normalizeContactInput({ fullName: "Ada", website: "javascript:alert(1)", linkedinUrl: "data:text/html,x" }, "lenient");
  check("lenient mode keeps the row but drops the unsafe links",
    lenient.ok && lenient.value.website === undefined && lenient.value.linkedinUrl === undefined);
  const fine = normalizeContactInput({ fullName: "Ada", website: "example.com" }, "lenient");
  check("lenient mode keeps a safe website exactly as typed", fine.ok && fine.value.website === "example.com");
}

console.log("CSV export (audit INJ-CSV)...");
{
  const csv = toSpreadsheetCsv([{ name: "=HYPERLINK(\"https://x.example\")", n: "+1", at: "@SUM(A1)", ok: "Ada" }]);
  const line = csv.split("\n")[1] ?? "";
  check("formula-looking cells are prefixed so they read as text", line.startsWith(`"'=HYPERLINK`) && line.includes("'+1") && line.includes("'@SUM"), line);
  check("ordinary cells are unchanged", line.endsWith(",Ada"), line);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll input-helper checks passed.");
