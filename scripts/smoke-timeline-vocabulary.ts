/**
 * The timeline's two pure layers: the interaction family map and the day-granularity date
 * grammar. Both are pinned to a fixed anchor. No network, no DB.
 * Run: npx tsx scripts/smoke-timeline-vocabulary.ts
 */
import {
  INTERACTION_FAMILIES,
  INTERACTION_TYPES,
  interactionFamilySpec,
  interactionTypeFamily,
  isWarmInteractionType,
  normalizeInteractionType,
} from "../src/lib/interaction-types";
import { timelineDayLabel, timelineGapLabel } from "../src/lib/timeline-date";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

// ---------------------------------------------------------------- families

const familyValues = new Set(INTERACTION_FAMILIES.map((f) => f.value));

check(
  "every type has a family that exists",
  INTERACTION_TYPES.every((t) => familyValues.has(t.family)),
  INTERACTION_TYPES.filter((t) => !familyValues.has(t.family)).map((t) => t.value).join(", ")
);

check(
  "every family is reachable from at least one type",
  INTERACTION_FAMILIES.every((f) => INTERACTION_TYPES.some((t) => t.family === f.value)),
  INTERACTION_FAMILIES.filter((f) => !INTERACTION_TYPES.some((t) => t.family === f.value))
    .map((f) => f.value)
    .join(", ")
);

// Every legacy value still stored in `interaction_type` has to land on a real family, or a row
// written before this module existed renders with no colour at all.
for (const legacy of ["meeting_note", "outreach", "coffee", "hangout", "linkedin", "text", "sms"]) {
  const canonical = normalizeInteractionType(legacy);
  check(
    `legacy "${legacy}" resolves to a family`,
    familyValues.has(interactionTypeFamily(legacy)),
    `${legacy} → ${canonical}`
  );
}

check(
  "unknown values fall back to a family rather than throwing",
  interactionTypeFamily("something_nobody_wrote") === "yours"
);

// The family classes are read straight into `className`, so an empty one fails silently as a
// node with no colour rather than as an error.
check(
  "every family carries its four class strings",
  INTERACTION_FAMILIES.every(
    (f) => f.node && f.nodeSelected && f.chip && f.dot && f.text
  )
);

check(
  "the token name in each class string matches the family",
  INTERACTION_FAMILIES.every((f) =>
    [f.node, f.nodeSelected, f.chip, f.dot, f.text].every((cls) =>
      cls.includes(`interaction-${f.value}`)
    )
  )
);

// `tone: "warm"` used to be a second, independent list. It is now derived, and this is the
// assertion that it still draws the same line.
check(
  "warm is exactly the together family",
  INTERACTION_TYPES.every(
    (t) => isWarmInteractionType(t.value) === (t.family === "together")
  )
);

check(
  "spec lookup and family lookup agree",
  INTERACTION_TYPES.every(
    (t) => interactionFamilySpec(t.value).value === interactionTypeFamily(t.value)
  )
);

// ---------------------------------------------------------------- date grammar

// Tuesday 2026-09-01, 09:30 local. Not midnight, so a label computed from elapsed time rather
// than calendar days would give different answers here than at the same date's midnight.
const ANCHOR = new Date(2026, 8, 1, 9, 30, 0, 0);
const day = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h);

const labels: Array<[Date, string]> = [
  [day(2026, 9, 1, 1), "Today"],
  [day(2026, 9, 1, 23), "Today"],
  [day(2026, 8, 31), "Yesterday"],
  [day(2026, 8, 29), "3 days ago"],
  [day(2026, 8, 26), "6 days ago"],
  [day(2026, 8, 25), "1 week ago"],
  [day(2026, 8, 11), "3 weeks ago"],
  [day(2026, 8, 1), "1 month ago"],
  [day(2026, 7, 1), "2 months ago"],
  [day(2026, 3, 1), "6 months ago"],
  [day(2025, 9, 1), "1 year ago"],
  // 20 months back is still "1 year ago" — floored, not rounded up to 2.
  [day(2025, 1, 1), "1 year ago"],
  [day(2023, 9, 1), "3 years ago"],
  [day(2026, 9, 2), "Tomorrow"],
  [day(2026, 9, 5), "In 4 days"],
];

for (const [when, expected] of labels) {
  const got = timelineDayLabel(when, ANCHOR);
  check(`${when.toDateString()} → "${expected}"`, got === expected, got);
}

// The whole reason for calendar-day arithmetic: the label must not depend on the time of day,
// or the server render and the hydrated render disagree.
check(
  "the label is stable across the hours of a day",
  [0, 6, 12, 18, 23].every(
    (h) => timelineDayLabel(day(2026, 8, 20), new Date(2026, 8, 1, h, 17)) === "2 weeks ago"
  )
);

// ---------------------------------------------------------------- gap markers

check("a gap under two months is unremarkable", timelineGapLabel(day(2026, 7, 20), day(2026, 9, 1)) === null);
check("59 days is still unremarkable", timelineGapLabel(day(2026, 7, 4), day(2026, 9, 1)) === null);

const gaps: Array<[Date, Date, string]> = [
  [day(2026, 6, 1), day(2026, 9, 1), "3 months quiet"],
  [day(2025, 11, 1), day(2026, 9, 1), "10 months quiet"],
  [day(2025, 8, 1), day(2026, 9, 1), "About a year quiet"],
  [day(2023, 9, 1), day(2026, 9, 1), "3 years quiet"],
];
for (const [older, newer, expected] of gaps) {
  const got = timelineGapLabel(older, newer);
  check(`gap ${older.toDateString()} → "${expected}"`, got === expected, String(got));
}

console.log("\nsmoke-timeline-vocabulary: all checks passed");
