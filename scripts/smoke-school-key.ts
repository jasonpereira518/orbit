/**
 * School-name normalization: the spellings of one school become one constellation.
 * Pure: no DB, no network.
 * Run: npx tsx scripts/smoke-school-key.ts
 */
import { schoolGroupKeys, schoolKeys } from "../src/lib/school-key";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

function sameGroup(values: string[], a: string, b: string) {
  const groups = schoolGroupKeys(values);
  return groups.get(a) !== undefined && groups.get(a) === groups.get(b);
}

const ALL = [
  "MIT",
  "Massachusetts Institute of Technology",
  "M.I.T.",
  "Stanford",
  "Stanford University",
  "UNC",
  "University of North Carolina",
  "Boston University",
  "Boston College",
  "University of Toronto",
  "University of Texas",
  "UT",
  "Waterloo",
  "University of Waterloo",
  "   ",
];

console.log("\nschoolGroupKeys");
check("MIT = Massachusetts Institute of Technology", sameGroup(ALL, "MIT", "Massachusetts Institute of Technology"));
check("M.I.T. = MIT", sameGroup(ALL, "M.I.T.", "MIT"));
check("Stanford = Stanford University", sameGroup(ALL, "Stanford", "Stanford University"));
check("UNC = University of North Carolina", sameGroup(ALL, "UNC", "University of North Carolina"));
check("Waterloo = University of Waterloo", sameGroup(ALL, "Waterloo", "University of Waterloo"));
check("Boston University ≠ Boston College", !sameGroup(ALL, "Boston University", "Boston College"));
check("University of Toronto ≠ University of Texas", !sameGroup(ALL, "University of Toronto", "University of Texas"));
check(
  "an ambiguous acronym (UT) joins neither",
  !sameGroup(ALL, "UT", "University of Toronto") && !sameGroup(ALL, "UT", "University of Texas")
);
check("blank spelling has no group", schoolGroupKeys(ALL).get("   ") === undefined);
check(
  "deterministic regardless of input order",
  JSON.stringify([...schoolGroupKeys(ALL)].sort()) ===
    JSON.stringify([...schoolGroupKeys([...ALL].reverse())].sort())
);

console.log("\nschoolKeys is unchanged by the move");
check("long form + acronym", JSON.stringify(schoolKeys("University of North Carolina")) === JSON.stringify(["university north carolina", "unc"]));
check("short form", JSON.stringify(schoolKeys("MIT")) === JSON.stringify(["mit"]));
check("empty", schoolKeys("  ").length === 0);

console.log("\nschool-key: all checks passed");
process.exit(0);
