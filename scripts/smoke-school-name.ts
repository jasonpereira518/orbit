/**
 * sameSchool: two spellings of one school, never two different campuses.
 *
 * A false match ("you both went to X") is worse than a miss, so a short name only matches a
 * long one when its letters are the initials of a run of words, never as a prefix.
 *
 * Run: npx tsx scripts/smoke-school-name.ts
 */
import { sameSchool } from "../src/lib/school-name";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
}

const CASES: [string, string, boolean][] = [
  ["UNC Chapel Hill", "University of North Carolina at Chapel Hill", true],
  ["MIT", "Massachusetts Institute of Technology", false],
  ["MIT", "Manipal Institute of Technology", false],
  ["CMU", "Central Michigan University", false],
  ["UC Berkeley", "University of California, Berkeley", true],
  ["University of Michigan", "university of michigan", true],
  ["UC Berkeley", "UCLA", false],
  ["University of California", "University of California, Berkeley", false],
  ["UNC", "University of North Carolina at Charlotte", false],
  ["Yale", "Yale School of Management", false],
  ["", "Yale", false],
  ["USC", "University of Southern California", false],
  ["USC", "University of South Carolina", false],
  ["UC", "University of California", false],
  ["USC", "USC", true],
  ["UNC CH", "University of North Carolina at Chapel Hill", true],
  ["UT Austin", "University of Texas at Austin", true],
  ["UT Austin", "University of Texas at Dallas", false],
  ["Texas A&M University", "Texas A&M University", true],
];

function main() {
  for (const [a, b, expected] of CASES) {
    check(`sameSchool(${JSON.stringify(a)}, ${JSON.stringify(b)}) === ${expected}`, sameSchool(a, b) === expected);
    check(`sameSchool(${JSON.stringify(b)}, ${JSON.stringify(a)}) === ${expected}`, sameSchool(b, a) === expected);
  }
  check("null is never a match", sameSchool(null, "Yale") === false && sameSchool("Yale", undefined) === false);
  console.log("\nAll school-name checks passed.");
}

try {
  main();
  process.exit(0);
} catch (e) {
  console.error("\nFAILED:", e);
  process.exit(1);
}
