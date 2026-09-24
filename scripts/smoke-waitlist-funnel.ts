/**
 * The waitlist's share funnel: the beacon records what a person did and nothing a bot or
 * a malformed body sent, and the admin funnel reads it back alongside referred joins.
 *
 * Run: npx tsx scripts/smoke-waitlist-funnel.ts
 */
import "./smoke/_env";

import { like } from "drizzle-orm";
import { getDb } from "../src/db";
import { interestListEvents, interestListSignups } from "../src/db/schema";
import { generateUnsubscribeToken } from "../src/lib/interest-list-email";
import { readInterestFunnel, recordInterestEvent } from "../src/lib/interest-list-events";

const PREFIX = "smoke-funnel-";
const TOKEN = `${PREFIX}token`;
const BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function cleanup() {
  const db = await getDb();
  await db.delete(interestListSignups).where(like(interestListSignups.email, `${PREFIX}%`));
  // The table is anonymous, so the throwaway database is the scope: clear it all.
  await db.delete(interestListEvents);
}

async function main() {
  await cleanup();
  const db = await getDb();
  const [owner] = await db
    .insert(interestListSignups)
    .values({ email: `${PREFIX}owner@example.test`, unsubscribeToken: generateUnsubscribeToken(), shareToken: TOKEN })
    .returning();

  const { POST } = await import("../src/app/api/interest-list/event/route");
  const post = (body: unknown, ua = BROWSER) =>
    POST(
      new Request("https://join.example/api/interest-list/event", {
        method: "POST",
        headers: { "user-agent": ua, "x-forwarded-for": "203.0.113.9" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      })
    );
  const rows = async () => db.select().from(interestListEvents);

  console.log("the beacon…");
  const res = await post({ kind: "ref_arrival", token: TOKEN });
  check("always answers 204", res.status === 204);
  let all = await rows();
  check("an arrival is recorded against the link's owner", all.length === 1 && all[0]!.kind === "ref_arrival" && all[0]!.signupId === owner!.id);

  await post({ kind: "share_click", token: TOKEN, channel: "whatsapp" });
  all = await rows();
  check("a share click keeps its channel", all.some((r) => r.kind === "share_click" && r.channel === "whatsapp"));

  const before = (await rows()).length;
  await post({ kind: "ref_arrival", token: TOKEN }, "Twitterbot/1.0");
  await post({ kind: "ref_arrival", token: TOKEN }, "");
  await post({ kind: "share_click", token: TOKEN });
  await post({ kind: "share_click", token: TOKEN, channel: "carrier-pigeon" });
  await post({ kind: "pass_request", token: TOKEN });
  await post({ kind: "ref_arrival", token: "no-such-token" });
  await post({ kind: "ref_arrival", token: "x".repeat(200) });
  await post("not json");
  check(
    "bots, unknown kinds and channels, server-only kinds, unknown tokens and junk record nothing",
    (await rows()).length === before,
    String((await rows()).length - before)
  );

  console.log("\nthe funnel…");
  await recordInterestEvent({ kind: "pass_request", signupId: owner!.id });
  await db.insert(interestListSignups).values([
    { email: `${PREFIX}f1@example.test`, unsubscribeToken: generateUnsubscribeToken(), referredById: owner!.id },
    { email: `${PREFIX}f2@example.test`, unsubscribeToken: generateUnsubscribeToken() },
  ]);
  const funnel = await readInterestFunnel(30);
  check("arrivals counted", funnel.arrivals === 1, String(funnel.arrivals));
  check("referred joins come from the signups table", funnel.referredJoins >= 1 && funnel.joins >= 3);
  check("pass requests counted", funnel.passRequests === 1);
  check("shares grouped by channel", funnel.shares.length === 1 && funnel.shares[0]!.channel === "whatsapp" && funnel.shares[0]!.n === 1);

  await cleanup();
  console.log("\nwaitlist funnel: all checks passed");
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => null);
  process.exit(1);
});
