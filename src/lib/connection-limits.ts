import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { gmailConnections, outlookConnections } from "@/db/schema";
import { getEntitlements } from "@/lib/entitlements";
import { recordGateHit } from "@/lib/gate-events";

/**
 * The Free Plan's one Google OR Microsoft account (pricing v2; Jason's call, Sep 29 2026 —
 * a deliberate change from the spec table, which put all mail and calendar sync on Pro).
 *
 *  - Connecting: a Free account that already has one provider connected cannot connect the
 *    other. Reconnecting the provider it already has is always allowed.
 *  - Syncing: a Free account that already had BOTH before this rule keeps its EARLIER
 *    connection syncing; the later one is skipped, never disconnected. Its tokens and every
 *    row it synced stay, and it resumes by itself the moment the account is on a paid plan.
 */
export type MailProvider = "google" | "microsoft";

async function connectedAt(userId: string) {
  const db = await getDb();
  const [google, microsoft] = await Promise.all([
    db.query.gmailConnections.findFirst({ where: eq(gmailConnections.userId, userId), columns: { createdAt: true } }),
    db.query.outlookConnections.findFirst({ where: eq(outlookConnections.userId, userId), columns: { createdAt: true } }),
  ]);
  return { google: google?.createdAt ?? null, microsoft: microsoft?.createdAt ?? null };
}

/**
 * False when this connection would be a Free account's second (the refusal is recorded as a
 * gate hit). Returned rather than thrown: a server action's thrown message is an opaque
 * digest in production, so callers turn `false` into the OAuth `reason=plan_limit` redirect
 * the connect UI already knows how to describe.
 */
export async function canConnect(userId: string, provider: MailProvider): Promise<boolean> {
  const ent = await getEntitlements(userId);
  if (ent.canUseExtraConnections) return true;
  const at = await connectedAt(userId);
  const other = provider === "google" ? at.microsoft : at.google;
  const own = provider === "google" ? at.google : at.microsoft;
  if (other && !own) {
    await recordGateHit({ userId, feature: "extraConnections", plan: ent.plan, context: { provider } });
    return false;
  }
  return true;
}

/** Where a refused connect goes instead of the consent screen: back, with the reason. */
export function refusedConnectUrl(returnTo: string, provider: MailProvider): string {
  const url = new URL(returnTo || "/settings?integration=overview", "https://orbit.invalid");
  if (provider === "google") {
    url.searchParams.set("gmail", "error");
    url.searchParams.set("google", "error");
  } else {
    url.searchParams.set("outlook", "error");
  }
  url.searchParams.set("reason", "plan_limit");
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Whether the sync pass should skip this connection: a Free account's later of two. */
export async function extraConnectionPaused(userId: string, provider: MailProvider): Promise<boolean> {
  const ent = await getEntitlements(userId);
  if (ent.canUseExtraConnections) return false;
  const at = await connectedAt(userId);
  if (!at.google || !at.microsoft) return false;
  const mine = provider === "google" ? at.google : at.microsoft;
  const theirs = provider === "google" ? at.microsoft : at.google;
  return mine.getTime() > theirs.getTime();
}
