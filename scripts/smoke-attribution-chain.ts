/**
 * First-touch attribution, end to end: what the proxy captures, what an account is stamped
 * with, and how channels are grouped.
 *
 * Pins (audit U1-U3, U7):
 *   - ONE round-trip filter. An OAuth callback, a Stripe return or Clerk's own portal is never
 *     an acquisition channel, at the proxy's first-touch capture exactly as at the beacon;
 *   - a UTM on a round-tripped URL is still a campaign;
 *   - `signupChannelSql` and `channelOf` are one definition (they are run over the same rows);
 *   - an account that only ever uses a key, an assistant or the extension is attributed lazily
 *     and once, as `direct`, or `waitlist` when its invite links it to a waitlist row.
 *
 * Run: npx tsx scripts/smoke-attribution-chain.ts
 */
import "./smoke/_env";

import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { NextRequest, type NextFetchEvent } from "next/server";
import { getDb } from "../src/db";
import { interestListSignups, userSettings } from "../src/db/schema";
import { ATTRIBUTION_COOKIE, parseAttribution } from "../src/lib/attribution-parse";
import { channelOf, noteMachineSurfaceAccount, signupChannelSql } from "../src/lib/attribution";
import { isOwnOrRoundTrip, ROUND_TRIP_HOSTS } from "../src/lib/round-trip-hosts";
import { linkInviteToAccount } from "../src/lib/site-invites";
import { assertAccountUsable } from "../src/lib/api/auth";
import { ensureUserSettings } from "../src/lib/user-settings";
import { run } from "./smoke/_env";

const APP = "orbit.example";
const WAITLIST = "join.orbit-smoke.example";
const CLERK = "clerk.orbit.example";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function eventually(fn: () => Promise<boolean>) {
  for (let i = 0; i < 80; i++) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

run(async () => {
  process.env.APP_BASE_URL = `https://${APP}`;
  process.env.WAITLIST_HOST = WAITLIST;
  // The proxy decides at import time whether Clerk is configured. Imported BEFORE the key below
  // is set, it takes its plain (no-Clerk) branch, which runs the very same first-touch capture
  // and needs no Clerk handshake; the filter reads the key per call.
  const { default: proxy } = await import("../src/proxy");
  // A Clerk publishable key encodes its frontend host: pk_live_<base64("clerk.orbit.example$")>.
  const savedClerkKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = `pk_live_${Buffer.from(`${CLERK}$`).toString("base64")}`;

  console.log("the shared round-trip filter…");
  for (const host of ["accounts.google.com", "login.microsoftonline.com", "checkout.stripe.com", "billing.stripe.com", "appleid.apple.com", "js.stripe.com", "login.live.com"]) {
    check(`${host} is not a channel`, isOwnOrRoundTrip(host, APP));
  }
  check("Clerk's frontend host is not a channel", isOwnOrRoundTrip(CLERK, APP));
  check("…nor Clerk's account portal", isOwnOrRoundTrip(`accounts.${APP}`, APP));
  check("the app's own host is not a channel", isOwnOrRoundTrip(APP, APP) && isOwnOrRoundTrip(`www.${APP}`, "other.example"));
  check("the waitlist host is not a channel from the app (one product, two domains)", isOwnOrRoundTrip(WAITLIST, APP));
  check("a full URL is read as its host", isOwnOrRoundTrip("https://accounts.google.com/o/oauth2/v2/auth?x=1", APP));
  for (const host of ["reddit.com", "news.ycombinator.com", "www.linkedin.com", "google.com", "t.co"]) {
    check(`${host} IS a channel`, !isOwnOrRoundTrip(host, APP));
  }
  check("the list has the providers the beacon always filtered", ["accounts.google.com", "checkout.stripe.com"].every((h) => ROUND_TRIP_HOSTS.has(h)));

  console.log("\nthe proxy's first-touch capture, on the waitlist host…");
  const event = { waitUntil() {} } as unknown as NextFetchEvent;
  async function firstTouch(url: string, referer: string | null, host = WAITLIST) {
    const req = new NextRequest(url, { headers: { host, ...(referer ? { referer } : {}) } });
    const res = await proxy(req, event);
    return parseAttribution(res?.cookies.get(ATTRIBUTION_COOKIE)?.value ?? null);
  }
  const reddit = await firstTouch(`https://${WAITLIST}/`, "https://www.reddit.com/r/crm/comments/x");
  check("an outside referrer is captured as before", reddit?.referrer === "reddit.com", JSON.stringify(reddit));
  for (const referer of ["https://accounts.google.com/", "https://checkout.stripe.com/c/pay", `https://${CLERK}/v1/client`, "https://login.microsoftonline.com/common/oauth2"]) {
    const none = await firstTouch(`https://${APP}/dashboard`, referer, APP);
    check(`an OAuth/payment round trip from ${new URL(referer).host} sets no first touch`, none === null, JSON.stringify(none));
  }
  const tagged = await firstTouch(`https://${APP}/pricing?utm_source=newsletter&utm_medium=email`, "https://accounts.google.com/", APP);
  check("…but a UTM on that URL is still a campaign, with the provider dropped", tagged?.utmSource === "newsletter" && tagged.referrer === null, JSON.stringify(tagged));
  const sameOrigin = await firstTouch(`https://${APP}/pricing`, `https://${APP}/`, APP);
  check("a same-origin referrer still sets nothing", sameOrigin === null);

  console.log("\none channel definition, in SQL and in JS…");
  const db = await getDb();
  const ids = ["attr_chain_utm", "attr_chain_ref", "attr_chain_direct", "attr_chain_none", "attr_chain_blank", "attr_chain_both"];
  await db.delete(userSettings).where(inArray(userSettings.userId, ids));
  const at = new Date();
  await db.insert(userSettings).values([
    { userId: ids[0]!, signupUtmSource: "reddit", signupAttributedAt: at },
    { userId: ids[1]!, signupReferrer: "news.ycombinator.com", signupAttributedAt: at },
    { userId: ids[2]!, signupAttributedAt: at },
    { userId: ids[3]! },
    { userId: ids[4]!, signupUtmSource: "", signupReferrer: "", signupAttributedAt: at },
    { userId: ids[5]!, signupUtmSource: "producthunt", signupReferrer: "t.co", signupAttributedAt: at },
  ]);
  const rows = await db.select().from(userSettings).where(inArray(userSettings.userId, ids));
  const viaSql = await db.execute(sql`SELECT s.user_id AS id, ${signupChannelSql("s")} AS channel FROM user_settings s WHERE s.user_id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`);
  const sqlByUser = new Map((viaSql.rows as Array<{ id: string; channel: string }>).map((r) => [r.id, r.channel]));
  for (const row of rows) {
    check(`${row.userId}: SQL says "${sqlByUser.get(row.userId)}", channelOf agrees`, sqlByUser.get(row.userId) === channelOf(row));
  }
  check("…and the cases cover every branch", new Set(rows.map((r) => channelOf(r))).size === 5);
  let badAlias = false;
  try {
    signupChannelSql("s; drop table user_settings");
  } catch {
    badAlias = true;
  }
  check("the alias is validated before it reaches SQL", badAlias);
  await db.delete(userSettings).where(inArray(userSettings.userId, ids));

  console.log("\nmachine-only accounts are attributed, once…");
  const keyOnly = "attr_chain_keyonly";
  const waitlistBorn = "attr_chain_waitlist_api";
  const [signup] = await db
    .insert(interestListSignups)
    .values({ email: `attr-chain-${randomUUID()}@example.test`, unsubscribeToken: randomUUID(), shareToken: randomUUID(), utmSource: "podcast", referrer: "pod.example", landingPath: "/" })
    .returning();
  await db.delete(userSettings).where(inArray(userSettings.userId, [keyOnly, waitlistBorn]));
  const settings = await ensureUserSettings(keyOnly);
  check("a fresh account starts unattributed", settings.signupAttributedAt === null);
  // The authenticated request paths hand over the row they already read.
  noteMachineSurfaceAccount(keyOnly, settings);
  check("its first key/MCP/extension request attributes it as direct", await eventually(async () => (await db.query.userSettings.findFirst({ where: eq(userSettings.userId, keyOnly) }))?.signupAttributionSource === "direct"));
  const stamped = (await db.query.userSettings.findFirst({ where: eq(userSettings.userId, keyOnly) }))!;
  noteMachineSurfaceAccount(keyOnly, settings);
  noteMachineSurfaceAccount(keyOnly, stamped);
  await new Promise((r) => setTimeout(r, 150));
  check("…and a repeat changes nothing", (await db.query.userSettings.findFirst({ where: eq(userSettings.userId, keyOnly) }))?.signupAttributedAt?.getTime() === stamped.signupAttributedAt?.getTime());

  // An invited, waitlist-born account that only ever uses the API gets the waitlist's channel.
  await ensureUserSettings(waitlistBorn);
  await linkInviteToAccount(waitlistBorn, { interestSignupId: signup!.id });
  const wb = (await db.query.userSettings.findFirst({ where: eq(userSettings.userId, waitlistBorn) }))!;
  check("an invited account with no page view gets the waitlist's first touch", wb.signupAttributionSource === "waitlist" && wb.signupUtmSource === "podcast" && wb.signupReferrer === "pod.example");
  noteMachineSurfaceAccount(waitlistBorn, wb);
  await new Promise((r) => setTimeout(r, 150));
  check("…and the machine-surface pass leaves it alone", (await db.query.userSettings.findFirst({ where: eq(userSettings.userId, waitlistBorn) }))?.signupAttributionSource === "waitlist");

  // The real call site: assertAccountUsable (used by the v1 API key path and by MCP) hands the row over.
  const viaAuth = "attr_chain_via_auth";
  await db.delete(userSettings).where(eq(userSettings.userId, viaAuth));
  await assertAccountUsable(viaAuth, { surface: "mcp" });
  check("assertAccountUsable (API key / MCP auth) attributes a never-seen-in-browser account", await eventually(async () => (await db.query.userSettings.findFirst({ where: eq(userSettings.userId, viaAuth) }))?.signupAttributedAt != null));

  await db.delete(userSettings).where(inArray(userSettings.userId, [keyOnly, waitlistBorn, viaAuth]));
  await db.delete(interestListSignups).where(eq(interestListSignups.id, signup!.id));
  if (savedClerkKey === undefined) delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  else process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = savedClerkKey;
  console.log("\nattribution chain: all checks passed");
});
