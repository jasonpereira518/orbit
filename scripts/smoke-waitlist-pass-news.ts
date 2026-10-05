/**
 * The pass's news line: what a returning visitor is told changed since their last visit
 * (`describePassChange`), the live "a friend just joined" line (`liveJoinLine`), and the
 * device-local record they are computed from (`pass-seen.ts`), and the invites-out count
 * behind the tracker's "invited" circles (`pass-invites.ts`).
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
  tierCrossed,
} from "../src/lib/interest-list";
import { joinNotification } from "../src/lib/join-notify";
import { readSeen, writeSeen } from "../src/lib/pass-seen";
import { nextInvites, readInvites } from "../src/lib/pass-invites";

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

  console.log("tierCrossed");
  eq("0 → 1 unlocks move-up", tierCrossed(0, 1)?.id, "move-up");
  eq("1 → 2 unlocks nothing", tierCrossed(1, 2), null);
  eq("2 → 3 unlocks priority beta", tierCrossed(2, 3)?.id, "priority-beta");
  eq("several at once: the highest", tierCrossed(0, 5)?.id, "early-access");
  eq("to ten: founding", tierCrossed(9, 10)?.id, "founding");
  eq("no change: nothing", tierCrossed(3, 3), null);
  eq("going down: nothing", tierCrossed(5, 3), null);

  console.log("joinNotification");
  const one = joinNotification(1, 1234, null);
  eq("one friend: title", one.title, "A friend joined through your link");
  eq("one friend: body", one.body, "You moved up 5 spots — you're now #1,234.");
  const two = joinNotification(2, 40, tierCrossed(1, 3));
  eq("two friends: title", two.title, "2 friends joined through your link");
  eq("with a tier: body", two.body, "You moved up 10 spots — you're now #40. Priority beta unlocked.");
  check("notifications never name the product", !/orbit/i.test(`${one.title} ${one.body} ${two.title} ${two.body}`));

  console.log("pass-invites");
  const share = nextInvites(null, "t", 0, "share");
  eq("first share → 1 invited", share.pending, 1);
  const three = nextInvites(nextInvites(share, "t", 0, "share"), "t", 0, "share");
  eq("three shares → 3", three.pending, 3);
  eq("a join consumes one", nextInvites(three, "t", 1, "sync").pending, 2);
  eq("more joins than invites floor at 0", nextInvites(three, "t", 5, "sync").pending, 0);
  eq("a join then a share", nextInvites(three, "t", 2, "share").pending, 2);
  let capped = nextInvites(null, "t", 8, "share");
  for (let i = 0; i < 5; i++) capped = nextInvites(capped, "t", 8, "share");
  eq("capped at the empty circles left", capped.pending, 2);
  eq("no room at 10 friends", nextInvites(null, "t", 10, "share").pending, 0);
  eq("another pass starts fresh", nextInvites(three, "other", 0, "share").pending, 1);
  eq("referrals never go backwards in the record", nextInvites(nextInvites(share, "t", 3, "sync"), "t", 1, "sync").referrals, 3);
  const inv = memoryStorage();
  inv.setItem("waitlist-pass-invites", JSON.stringify({ token: "t", pending: 2, referrals: 1 }));
  eq("stored record reads back", readInvites(inv)?.pending, 2);
  inv.setItem("waitlist-pass-invites", JSON.stringify({ token: "t", pending: -1, referrals: 1 }));
  eq("invalid record → null", readInvites(inv), null);
  eq("throwing storage → null", readInvites(throwing), null);

  if (failures > 0) {
    console.error(`\nsmoke-waitlist-pass-news: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\nsmoke-waitlist-pass-news: all checks passed");
}

main();
