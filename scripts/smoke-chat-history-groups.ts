/**
 * Pins the day-bucketing behind the chat history rail (`src/lib/chat-history-groups.ts`).
 *
 * The interesting cases are the boundaries: "Today" is a calendar day, not the last 24
 * hours, so a chat from 23:50 last night must already read as Yesterday at 00:10.
 *
 * Pure: no network, no database. Run: npx tsx scripts/smoke-chat-history-groups.ts
 */
import { groupThreadsByDay } from "../src/lib/chat-history-groups";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const t = (id: string, updatedAt: Date | string) => ({ id, title: id, updatedAt });
// A fixed "now" mid-afternoon, local time, so the day maths does not depend on when this runs.
const now = new Date(2026, 8, 20, 15, 30);
const at = (daysAgo: number, h = 12, m = 0) =>
  new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, h, m);

console.log("Bucketing by calendar day...");
{
  const groups = groupThreadsByDay(
    [t("now", at(0, 9)), t("yest", at(1, 20)), t("three", at(3)), t("ten", at(10)), t("old", at(90))],
    now
  );
  const byLabel = Object.fromEntries(groups.map((g) => [g.label, g.threads.map((x) => x.id)]));
  check("this morning is Today", byLabel["Today"]?.[0] === "now");
  check("last evening is Yesterday", byLabel["Yesterday"]?.[0] === "yest");
  check("three days ago is in the last week", byLabel["Previous 7 days"]?.[0] === "three");
  check("ten days ago is Earlier", byLabel["Earlier"]?.includes("ten") === true);
  check("ninety days ago is Earlier", byLabel["Earlier"]?.includes("old") === true);
  check("groups come out in reading order", groups.map((g) => g.label).join() === "Today,Yesterday,Previous 7 days,Earlier");
}

console.log("\nThe midnight boundary");
{
  const justAfterMidnight = new Date(2026, 8, 21, 0, 10);
  const lateLastNight = new Date(2026, 8, 20, 23, 50);
  const g = groupThreadsByDay([t("late", lateLastNight)], justAfterMidnight);
  check("23:50 last night is Yesterday at 00:10, not Today", g[0]?.label === "Yesterday");

  const earlyToday = groupThreadsByDay([t("early", new Date(2026, 8, 21, 0, 1))], justAfterMidnight);
  check("00:01 today is still Today", earlyToday[0]?.label === "Today");

  const edge = groupThreadsByDay([t("edge", at(7, 0, 0))], now);
  check("exactly seven days back at midnight is still in the last week", edge[0]?.label === "Previous 7 days");
  const past = groupThreadsByDay([t("past", at(8, 23, 59))], now);
  check("eight days back is Earlier", past[0]?.label === "Earlier");
}

console.log("\nOrdering and edge cases");
{
  const g = groupThreadsByDay([t("a", at(0, 8)), t("b", at(0, 14)), t("c", at(0, 11))], now);
  check("newest first inside a bucket, whatever order came in", g[0]?.threads.map((x) => x.id).join() === "b,c,a");

  check("no threads means no groups", groupThreadsByDay([], now).length === 0);
  check("empty buckets are dropped", groupThreadsByDay([t("x", at(0))], now).length === 1);

  const iso = groupThreadsByDay([t("s", at(0, 10).toISOString())], now);
  check("ISO strings from the server bucket the same as Dates", iso[0]?.label === "Today");

  const bad = groupThreadsByDay([t("bad", "not a date")], now);
  check("an unparseable date lands in Earlier rather than throwing", bad[0]?.label === "Earlier");

  const input = [t("a", at(2)), t("b", at(0))];
  groupThreadsByDay(input, now);
  check("the input array is not mutated", input[0]?.id === "a");
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll chat history group checks passed");
process.exit(0);
