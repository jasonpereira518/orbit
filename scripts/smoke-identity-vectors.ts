/**
 * The app's half of the identity contract with the browser extension.
 *
 * `linkedinSlug` and `normalizeXHandle` here and their copies in
 * `extension/src/inject/dom/url.ts` are two spellings of one rule: the extension
 * decides "do you already know this person" from its copy, and the app writes
 * `contact_identities` rows from this one. If they drift, the panel confidently
 * says "new to your orbit" about someone the user has known for years.
 *
 * Both files carry a comment asking whoever edits one to edit the other. That is
 * all that guarded it until now. This script and
 * `extension/test/identity-vectors.test.ts` read the SAME vectors file, so the
 * agreement is checked by two suites instead of remembered by two comments.
 *
 * `app` on a vector overrides `expected` for this side, and pins a divergence
 * that is deliberate — the vectors file explains each one. Reaching for a new
 * override to make this pass means the two have drifted instead.
 *
 * Pure: no database, no network.
 * Run: npx tsx scripts/smoke-identity-vectors.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { linkedinSlug, normalizeXHandle } from "@/lib/duplicates";

type Vector = {
  input: string | null;
  expected: string;
  app?: string;
  note?: string;
};

const VECTORS_PATH = join(
  process.cwd(),
  "extension/test/vectors/identity.json"
);

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
    failures++;
  }
}

let raw: string;
try {
  raw = readFileSync(VECTORS_PATH, "utf8");
} catch {
  console.error(
    `smoke-identity-vectors: cannot read ${VECTORS_PATH}.\n` +
      "The vectors are the contract between the app and the extension; if the " +
      "extension directory is gone, this guard is meaningless and the failure " +
      "is real."
  );
  process.exit(1);
}

const vectors = JSON.parse(raw) as {
  linkedinSlug: Vector[];
  xHandle: Vector[];
};

function run(
  name: string,
  fn: (value: string | null | undefined) => string,
  cases: Vector[]
) {
  console.log(`${name} (${cases.length} vectors)`);
  for (const vector of cases) {
    const expected = vector.app ?? vector.expected;
    const actual = fn(vector.input);
    check(
      `${JSON.stringify(vector.input)} → ${JSON.stringify(expected)}${
        vector.app ? " [app-only]" : ""
      }`,
      actual === expected,
      `got ${JSON.stringify(actual)}${vector.note ? `; ${vector.note}` : ""}`
    );
  }
}

run("linkedinSlug", linkedinSlug, vectors.linkedinSlug);
run("normalizeXHandle", normalizeXHandle, vectors.xHandle);

// A vectors file that has quietly emptied out would pass every check above
// while guarding nothing.
check(
  "the vectors file still carries both sets",
  vectors.linkedinSlug.length >= 10 && vectors.xHandle.length >= 10,
  `linkedinSlug=${vectors.linkedinSlug.length}, xHandle=${vectors.xHandle.length}`
);

if (failures) {
  console.error(`\nsmoke-identity-vectors: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nsmoke-identity-vectors: all checks passed");
process.exit(0);
