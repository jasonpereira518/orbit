/**
 * The per-IP throttle on the one-click unsubscribe POSTs (`src/lib/unsubscribe-guard.ts`):
 * only bad tokens count, a caller past the allowance is refused before its token is checked,
 * a valid token from a busy address (a mail provider's servers) still works, and all three
 * unsubscribe routes are guarded.
 * Run: npx tsx scripts/smoke-unsubscribe-guard.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { readFileSync } from "node:fs";
import { eq, like } from "drizzle-orm";
import { NextRequest } from "next/server";
import { getDb } from "../src/db";
import { interestListSignups, rateLimitBuckets } from "../src/db/schema";
import { generateUnsubscribeToken } from "../src/lib/interest-list-email";
import { sealUnsubscribeToken } from "../src/lib/interest-list-tokens";
import { RATE_LIMITS } from "../src/lib/rate-limit";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const P = "smoke-unsub-guard-";
const URL_BASE = "https://app.example/api/interest-list/unsubscribe";
const post = (token: string, ip: string) =>
  new NextRequest(`${URL_BASE}?token=${encodeURIComponent(token)}`, { method: "POST", headers: { "x-forwarded-for": ip } });

run(async () => {
  const db = await getDb();
  const cleanup = async () => {
    await db.delete(interestListSignups).where(like(interestListSignups.email, `${P}%`));
    await db.delete(rateLimitBuckets).where(like(rateLimitBuckets.bucket, "unsubscribeMiss:%"));
  };
  await cleanup();
  const { POST } = await import("../src/app/api/interest-list/unsubscribe/route");
  const limit = RATE_LIMITS.unsubscribeMiss.limit;

  const signup = async (name: string) => {
    const token = generateUnsubscribeToken();
    await db.insert(interestListSignups).values({ email: `${P}${name}@example.test`, ...sealUnsubscribeToken(token) });
    return token;
  };

  try {
    console.log("Only bad tokens count");
    const busy = "203.0.113.7"; // one mail provider's servers, many real people
    for (let i = 0; i < limit + 5; i++) {
      const token = await signup(`busy-${i}`);
      const res = await POST(post(token, busy));
      if (res.status !== 200) {
        check(`valid unsubscribe #${i + 1} from one address succeeds`, false, `status ${res.status}`);
        break;
      }
    }
    check(`${limit + 5} valid unsubscribes from one address all succeed`, failures === 0);

    console.log("\nA guessing address is cut off");
    const guesser = "198.51.100.9";
    const statuses: number[] = [];
    for (let i = 0; i < limit; i++) statuses.push((await POST(post(`bogus-${i}`, guesser))).status);
    check(`its first ${limit} bad tokens get the ordinary 404`, statuses.every((s) => s === 404), statuses.join(","));
    const refused = await POST(post("bogus-next", guesser));
    check("the next request is refused with 429", refused.status === 429, String(refused.status));
    check("…and says when to retry", refused.headers.get("retry-after") === "3600");
    const realToken = await signup("after-limit");
    const blocked = await POST(post(realToken, guesser));
    check("…before any token is checked, even a valid one", blocked.status === 429, String(blocked.status));
    const [row] = await db.select().from(interestListSignups).where(eq(interestListSignups.email, `${P}after-limit@example.test`));
    check("…so nothing was written", row?.unsubscribedAt === null, JSON.stringify(row?.unsubscribedAt));

    console.log("\nOther addresses are unaffected");
    const elsewhere = await POST(post(realToken, "192.0.2.44"));
    check("the same valid token from another address works", elsewhere.status === 200, String(elsewhere.status));

    console.log("\nThe bucket");
    const keys = (await db.select().from(rateLimitBuckets).where(like(rateLimitBuckets.bucket, "unsubscribeMiss:%"))).map((b) => b.bucket);
    check("the address is stored hashed, never as typed", keys.length > 0 && keys.every((k) => !k.includes(guesser) && !k.includes(busy)), JSON.stringify(keys));

    console.log("\nEvery unsubscribe POST is guarded");
    for (const route of [
      "src/app/api/interest-list/unsubscribe/route.ts",
      "src/app/api/radar/digest/unsubscribe/route.ts",
      "src/app/api/credits/email/unsubscribe/route.ts",
    ]) {
      const src = readFileSync(route, "utf8");
      check(`${route} checks the allowance and counts misses`, src.includes("unsubscribeAttemptsExhausted(request)") && src.includes("recordUnsubscribeMiss(request)"));
    }
  } finally {
    await cleanup();
  }
  if (failures) throw new Error(`${failures} check(s) failed`);
  console.log("\nunsubscribe guard: all checks passed");
});
