/**
 * The review card no longer asks "how many days?" or "remind me?" — both fall out of
 * closeness and relevance. This pins the two pure rules so a later tweak to either table
 * is a deliberate change, not drift.
 *
 * Run: npx tsx scripts/smoke-follow-up-cadence.ts
 */
import {
  DEFAULT_FOLLOW_UP_WINDOW_DAYS,
  FOLLOW_UP_DAYS_BY_CLOSENESS,
  followUpDaysFor,
  shouldCreateFollowUp,
} from "../src/lib/note-batches";
import { CLOSENESS_LEVELS, clampCloseness, closenessLegend } from "../src/lib/capture/closeness";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

// --- the cadence table --------------------------------------------------------------
check("closer people get shorter windows", FOLLOW_UP_DAYS_BY_CLOSENESS[5] < FOLLOW_UP_DAYS_BY_CLOSENESS[1]);
check("table is monotonic", [5, 4, 3, 2, 1].every((c, i, arr) => i === 0 || FOLLOW_UP_DAYS_BY_CLOSENESS[c as 1 | 2 | 3 | 4 | 5] > FOLLOW_UP_DAYS_BY_CLOSENESS[arr[i - 1] as 1 | 2 | 3 | 4 | 5]));
check("closeness 5 → 14d", followUpDaysFor(5, null) === 14);
check("closeness 1 → 180d", followUpDaysFor(1, null) === 180);
check("closeness 3 → 60d", followUpDaysFor(3, undefined) === 60);
check("out-of-range closeness clamps", followUpDaysFor(9, null) === 14 && followUpDaysFor(0, null) === 180);
check("fractional closeness rounds", followUpDaysFor(3.6, null) === 30);
check("unknown closeness → default window", followUpDaysFor(null, null) === DEFAULT_FOLLOW_UP_WINDOW_DAYS);

// --- the model's suggestion wins when it is sane -----------------------------------
check("AI days override the table", followUpDaysFor(1, 7) === 7);
check("AI days are rounded", followUpDaysFor(1, 6.6) === 7);
check("AI zero falls back to the table", followUpDaysFor(2, 0) === 90);
check("AI negative falls back to the table", followUpDaysFor(2, -3) === 90);
check("AI beyond a year falls back to the table", followUpDaysFor(4, 400) === 30);
check("AI NaN falls back to the table", followUpDaysFor(4, Number.NaN) === 30);

// --- whether to remind at all --------------------------------------------------------
check("an explicit recommendation always wins", shouldCreateFollowUp(1, 1, true));
check("no goals: real conversation qualifies", shouldCreateFollowUp(3, null, false));
check("no goals: met once does not", !shouldCreateFollowUp(2, null, false));
check("no goals: unknown closeness is treated as 2", !shouldCreateFollowUp(null, null, false));
check("goals: 3 + 3 qualifies", shouldCreateFollowUp(3, 3, false));
check("goals: 2 + 2 does not", !shouldCreateFollowUp(2, 2, false));
check("goals: 4 + 2 qualifies (sum 6)", shouldCreateFollowUp(4, 2, false));
check("goals: 2 + 3 does not (sum 5)", !shouldCreateFollowUp(2, 3, false));
check("goals: a 5 on relevance alone qualifies", shouldCreateFollowUp(1, 5, false));
check("goals: a 5 on closeness alone qualifies", shouldCreateFollowUp(5, 1, false));

// --- the shared vocabulary -----------------------------------------------------------
check("five closeness levels, 1..5", CLOSENESS_LEVELS.map((l) => l.value).join() === "1,2,3,4,5");
check("legend is the prompt string the model has always seen", closenessLegend() === "1=barely know, 2=met once, 3=real conversation, 4=strong, 5=mentor/advocate");
check("clampCloseness defaults to 2", clampCloseness(null) === 2 && clampCloseness(undefined) === 2);
check("clampCloseness clamps", clampCloseness(0) === 1 && clampCloseness(7) === 5 && clampCloseness(3.4) === 3);

console.log("\nsmoke-follow-up-cadence: all checks passed");
