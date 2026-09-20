/**
 * Does the constellation show a few comets per cluster, rather than everyone gone quiet?
 *
 * A year without contact is ordinary in an imported network, so marking every such contact
 * turned whole constellations red. `pickClusterComets` keeps a handful per cluster — the closest
 * relationships first, then the longest silent — and never picks someone recently in touch.
 *
 * Run: npx tsx scripts/smoke-comet-cap.ts
 */
import { COMETS_PER_CLUSTER, pickClusterComets } from "../src/lib/comet";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

const big = Array.from({ length: 40 }, (_, i) => ({
  id: `big${i}`,
  lastInteractionAt: ago(i % 2 ? 800 : 2000),
  orbitScore: (i % 5) + 1,
}));
const recentClose = { id: "bigRecent", lastInteractionAt: ago(10), orbitScore: 5 };
const neverTouched = { id: "bigNever", lastInteractionAt: null, orbitScore: 5 };
const small = [
  { id: "small0", lastInteractionAt: ago(400), orbitScore: 2 },
  { id: "small1", lastInteractionAt: ago(30), orbitScore: 2 },
];
const loose = Array.from({ length: 10 }, (_, i) => ({
  id: `loose${i}`,
  lastInteractionAt: ago(500 + i),
  orbitScore: 1,
}));
const contacts = [...big, recentClose, neverTouched, ...small, ...loose];
const clusters = [
  { id: "big", contactIds: [...big.map((c) => c.id), recentClose.id, neverTouched.id] },
  { id: "small", contactIds: small.map((c) => c.id) },
];

const picked = pickClusterComets(contacts, clusters);
const inGroup = (prefix: string) => [...picked].filter((id) => id.startsWith(prefix));

check(
  `a 42-person cluster gets ${COMETS_PER_CLUSTER} comets, not 40`,
  inGroup("big").length === COMETS_PER_CLUSTER,
  [...picked].join(", ")
);
check(
  "they are its closest dormant relationships, longest silent first among equals",
  inGroup("big").every((id) => big.find((c) => c.id === id)?.orbitScore === 5) &&
    inGroup("big").every((id) => Number(id.slice(3)) % 2 === 0),
  inGroup("big").join(", ")
);
check("someone in touch last week is never a comet", !picked.has("bigRecent"));
check("someone never contacted is never a comet", !picked.has("bigNever"));
check(
  "a small cluster keeps only the comets it really has",
  inGroup("small").length === 1 && picked.has("small0")
);
check(
  "contacts in no cluster share one group, capped the same way",
  inGroup("loose").length === COMETS_PER_CLUSTER
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll comet-cap checks passed.");
process.exit(0);
