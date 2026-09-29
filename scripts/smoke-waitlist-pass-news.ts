/**
 * The pass's news line: what a returning visitor is told changed since their last visit
 * (`describePassChange`), the live "a friend just joined" line (`liveJoinLine`), and the
 * device-local record they are computed from (`pass-seen.ts`).
 *
 * Pure — `pass-seen` runs against stub storages, including one that throws the way a
 * blocked or full storage does. No browser, no database.
 *
 * Run: npx tsx scripts/smoke-waitlist-pass-news.ts
 */
import {
  SPOTS_PER_REFERRAL,
  describePassChange,
  liveJoinLine,
} from "../src/lib/interest-list";
import { readSeen, writeSeen } from "../src/lib/pass-seen";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}
function eq(label: string, actual: unknown, expected: unknown) {
  check(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

const throwing: Storage = {
  length: 0,
  clear() {},
  key: () => null,
  getItem() {
    throw new Error("SecurityError");
  },
  removeItem() {},
  setItem() {
    throw new Error("QuotaExceededError");
  },
};

function main() {
  console.log("describePassChange");
  const at = (referrals: number, position: number) => ({ referrals, position });
  eq("no change → null", describePassChange(at(2, 40), at(2, 40)), null);
  eq(
    "one friend, moved up",
    describePassChange(at(0, 40), at(1, 35)),
    "A friend joined through your link since your last visit — you moved up 5 spots."
  );
  eq(
    "two friends, moved up",
    describePassChange(at(1, 40), at(3, 30)),
    "2 friends joined through your link since your last visit — you moved up 10 spots."
  );
  eq(
    "friends but pushed back overall",
    describePassChange(at(1, 40), at(2, 41)),
    "A friend joined through your link since your last visit. Others are inviting too, so you're 1 spot further back overall."
  );
  eq(
    "friends, net even",
    describePassChange(at(0, 40), at(1, 40)),
    "A friend joined through your link since your last visit."
  );
  eq(
    "no friends, moved up",
    describePassChange(at(0, 1300), at(0, 1)),
    "You've moved up 1,299 spots since your last visit."
  );
  eq(
    "no friends, one spot back",
    describePassChange(at(0, 40), at(0, 41)),
    `You're 1 spot further back since your last visit — each friend you invite moves you up ${SPOTS_PER_REFERRAL}.`
  );
  eq(
    "no friends, several back",
    describePassChange(at(0, 40), at(0, 52)),
    `You're 12 spots further back since your last visit — each friend you invite moves you up ${SPOTS_PER_REFERRAL}.`
  );

  console.log("liveJoinLine");
  eq("one", liveJoinLine(1), "A friend just joined through your link — +5 spots.");
  eq("three", liveJoinLine(3), "3 friends just joined through your link — +15 spots.");

  console.log("copy stays unbranded and dateless");
  const all = [
    describePassChange(at(0, 40), at(2, 30)),
    describePassChange(at(0, 40), at(1, 45)),
    describePassChange(at(0, 40), at(0, 30)),
    describePassChange(at(0, 40), at(0, 50)),
    liveJoinLine(1),
    liveJoinLine(2),
  ].join(" ");
  check("no product name", !/orbit/i.test(all));
  check("no dates or deadlines", !/\b(today|tomorrow|days?|hours?|deadline|until)\b/i.test(all));

  console.log("pass-seen");
  const store = memoryStorage();
  eq("empty storage → null", readSeen("tok", store), null);
  writeSeen("tok", at(2, 30), store);
  eq("round trip referrals", readSeen("tok", store)?.referrals, 2);
  eq("round trip position", readSeen("tok", store)?.position, 30);
  eq("another pass's record → null", readSeen("other", store), null);
  writeSeen("other", at(0, 9), store);
  eq("a second pass replaces the first", readSeen("tok", store), null);
  store.setItem("waitlist-pass-seen", "{not json");
  eq("corrupt record → null", readSeen("other", store), null);
  store.setItem("waitlist-pass-seen", JSON.stringify({ token: "x", referrals: -1, position: 3 }));
  eq("invalid numbers → null", readSeen("x", store), null);
  eq("throwing storage read → null", readSeen("tok", throwing), null);
  let threw = false;
  try {
    writeSeen("tok", at(1, 1), throwing);
  } catch {
    threw = true;
  }
  check("throwing storage write is swallowed", !threw);
  eq("no window → null (server)", readSeen("tok"), null);

  if (failures > 0) {
    console.error(`\nsmoke-waitlist-pass-news: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\nsmoke-waitlist-pass-news: all checks passed");
}

main();
