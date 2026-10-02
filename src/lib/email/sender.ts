import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { emailSends, gmailConnections, type EmailProviderId } from "@/db/schema";
import { isDemoWorkspace } from "@/lib/demo-workspace";
import { EMAIL_SEND_DAILY_CAP } from "@/lib/email/config";
import { providerFor } from "@/lib/email/providers";
import { getEntitlements } from "@/lib/entitlements";
import { hasSendScope } from "@/lib/gmail";

export type SendBlockReason = "not_connected" | "no_send_scope" | "needs_reauth";

export type ResolvedSender =
  | { ok: true; provider: EmailProviderId; fromEmail: string }
  | { ok: false; reason: SendBlockReason };

/**
 * Which mailbox a send goes out through. P1 knows Gmail and the demo workspace; Outlook
 * (P3) slots in here and honours `user_settings.default_send_provider`.
 */
export async function resolveSender(userId: string): Promise<ResolvedSender> {
  if (await isDemoWorkspace(userId)) {
    const id = await providerFor("demo").identity(userId);
    if (id) return { ok: true, provider: "demo", fromEmail: id.email };
  }
  const db = await getDb();
  const conn = await db.query.gmailConnections.findFirst({
    where: eq(gmailConnections.userId, userId),
    columns: { status: true, scopes: true, emailAddress: true },
  });
  if (!conn) return { ok: false, reason: "not_connected" };
  if (conn.status !== "active") return { ok: false, reason: "needs_reauth" };
  if (!hasSendScope(conn.scopes)) return { ok: false, reason: "no_send_scope" };
  return { ok: true, provider: "gmail", fromEmail: conn.emailAddress.trim().toLowerCase() };
}

/** Rolling 24h, every origin, counting anything not canceled or failed. */
export async function countEmailSendsToday(userId: string): Promise<number> {
  const db = await getDb();
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(emailSends)
    .where(
      and(
        eq(emailSends.userId, userId),
        inArray(emailSends.status, ["queued", "sending", "sent"]),
        gte(emailSends.createdAt, sql`now() - interval '24 hours'`)
      )
    );
  return Number(row?.n ?? 0);
}

export type SendCapability =
  | {
      ok: true;
      provider: EmailProviderId;
      fromEmail: string;
      dailyCap: number;
      usedToday: number;
      remainingToday: number;
    }
  | { ok: false; reason: SendBlockReason | "cap_reached"; dailyCap: number; usedToday: number };

export async function getSendCapability(userId: string): Promise<SendCapability> {
  const [sender, ent, usedToday] = await Promise.all([
    resolveSender(userId),
    getEntitlements(userId),
    countEmailSendsToday(userId),
  ]);
  const dailyCap = EMAIL_SEND_DAILY_CAP[ent.plan];
  if (!sender.ok) return { ok: false, reason: sender.reason, dailyCap, usedToday };
  if (usedToday >= dailyCap) return { ok: false, reason: "cap_reached", dailyCap, usedToday };
  return {
    ok: true,
    provider: sender.provider,
    fromEmail: sender.fromEmail,
    dailyCap,
    usedToday,
    remainingToday: dailyCap - usedToday,
  };
}
