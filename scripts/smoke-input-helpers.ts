/**
 * The input helpers every boundary uses (audit M-04, M-05, L-11): client dates, ids and
 * free text. Pure: no database. Run: npx tsx scripts/smoke-input-helpers.ts
 */
import { optionalClientDate, parseClientDate, requireClientDate } from "../src/lib/input/dates";
import { isUuid } from "../src/lib/input/ids";
import { TEXT_LIMITS, cleanText, cleanTextList } from "../src/lib/input/text";
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

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll input-helper checks passed.");
