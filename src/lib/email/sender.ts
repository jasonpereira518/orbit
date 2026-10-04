import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { emailSends, gmailConnections, outlookConnections, type EmailProviderId } from "@/db/schema";
import { isDemoWorkspace } from "@/lib/demo-workspace";
import { EMAIL_SEND_DAILY_CAP } from "@/lib/email/config";
import { providerFor } from "@/lib/email/providers";
import { loadSendPreference } from "@/lib/email/settings";
import { getEntitlements } from "@/lib/entitlements";
import { hasSendScope as hasGmailSendScope } from "@/lib/gmail";
import { getOutlookOAuthConfigSummary, hasSendScope as hasOutlookSendScope } from "@/lib/outlook";
import { isSurfaceLive } from "@/lib/surface-visibility";
import { OUTLOOK_SEND_SURFACE_KEY } from "@/lib/surfaces";

export type SendBlockReason = "not_connected" | "no_send_scope" | "needs_reauth";
export type MailboxId = "gmail" | "outlook";
export type Mailbox = { id: MailboxId; email: string; canSend: boolean; needsReauth: boolean };

let outlookSendOverride: boolean | null = null;
/** Smoke tests only: force Outlook sending on or off regardless of config and release state. */
export function setOutlookSendOverride(v: boolean | null) {
  outlookSendOverride = v;
}

/**
 * Whether Outlook may send for this user: Microsoft OAuth is configured on this deployment and
 * `feature.outlook-send` is released to them (coming-soon until the privacy page discloses
 * Mail.Send — direct-email P3).
 */
async function outlookAvailable(userId: string): Promise<boolean> {
  if (outlookSendOverride !== null) return outlookSendOverride;
  if (!getOutlookOAuthConfigSummary().configured) return false;
  return isSurfaceLive(userId, OUTLOOK_SEND_SURFACE_KEY);
}

/** The mailboxes this user has connected, and whether each can send right now. */
export async function listMailboxes(userId: string, includeOutlook?: boolean): Promise<Mailbox[]> {
  const db = await getDb();
  const withOutlook = includeOutlook ?? (await outlookAvailable(userId));
  const columns = { status: true, scopes: true, emailAddress: true } as const;
  const [gmail, outlook] = await Promise.all([
    db.query.gmailConnections.findFirst({ where: eq(gmailConnections.userId, userId), columns }),
    withOutlook
      ? db.query.outlookConnections.findFirst({ where: eq(outlookConnections.userId, userId), columns })
      : Promise.resolve(undefined),
  ]);
  const out: Mailbox[] = [];
  if (gmail) {
    out.push({
      id: "gmail",
      email: gmail.emailAddress.trim().toLowerCase(),
      canSend: gmail.status === "active" && hasGmailSendScope(gmail.scopes),
      needsReauth: gmail.status !== "active",
    });
  }
  if (outlook) {
    out.push({
      id: "outlook",
      email: outlook.emailAddress.trim().toLowerCase(),
      canSend: outlook.status === "active" && hasOutlookSendScope(outlook.scopes),
      needsReauth: outlook.status !== "active",
    });
  }
  return out;
}

export type ResolvedSender =
  | { ok: true; provider: EmailProviderId; fromEmail: string }
  | { ok: false; reason: SendBlockReason; provider: MailboxId | null };

/**
 * Which mailbox a send goes out through: an explicit choice → the saved default → the only
 * mailbox that can send → Gmail. When none can send, the block names the mailbox to fix, most
 * actionable first: one that needs reconnecting, then one without send permission.
 */
export async function resolveSender(userId: string, preferred?: MailboxId | null): Promise<ResolvedSender> {
  if (await isDemoWorkspace(userId)) {
    const id = await providerFor("demo").identity(userId);
    if (id) return { ok: true, provider: "demo", fromEmail: id.email };
  }
  const [mailboxes, { defaultProvider }] = await Promise.all([listMailboxes(userId), loadSendPreference(userId)]);
  const sendable = mailboxes.filter((m) => m.canSend);
  const pick =
    (preferred ? sendable.find((m) => m.id === preferred) : undefined) ??
    (defaultProvider ? sendable.find((m) => m.id === defaultProvider) : undefined) ??
    (sendable.length === 1 ? sendable[0] : sendable.find((m) => m.id === "gmail"));
  if (pick) return { ok: true, provider: pick.id, fromEmail: pick.email };
  const reauth = mailboxes.find((m) => m.needsReauth);
  if (reauth) return { ok: false, reason: "needs_reauth", provider: reauth.id };
  const scopeless = mailboxes.find((m) => !m.canSend);
  if (scopeless) return { ok: false, reason: "no_send_scope", provider: scopeless.id };
  return { ok: false, reason: "not_connected", provider: null };
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

type CapabilityContext = {
  dailyCap: number;
  usedToday: number;
  /** Every connected mailbox, so a surface can offer to fix or switch. */
  mailboxes: Mailbox[];
  defaultProvider: MailboxId | null;
  /** Whether Outlook can be offered at all (configured here and released to this user). */
  outlookAvailable: boolean;
};

export type SendCapability =
  | ({ ok: true; provider: EmailProviderId; fromEmail: string; remainingToday: number } & CapabilityContext)
  | ({ ok: false; reason: SendBlockReason | "cap_reached"; provider: MailboxId | null } & CapabilityContext);

export async function getSendCapability(userId: string): Promise<SendCapability> {
  const withOutlook = await outlookAvailable(userId);
  const [sender, ent, usedToday, mailboxes, { defaultProvider }] = await Promise.all([
    resolveSender(userId),
    getEntitlements(userId),
    countEmailSendsToday(userId),
    listMailboxes(userId, withOutlook),
    loadSendPreference(userId),
  ]);
  const context: CapabilityContext = {
    dailyCap: EMAIL_SEND_DAILY_CAP[ent.plan],
    usedToday,
    mailboxes,
    defaultProvider,
    outlookAvailable: withOutlook,
  };
  if (!sender.ok) return { ok: false, reason: sender.reason, provider: sender.provider, ...context };
  if (usedToday >= context.dailyCap) return { ok: false, reason: "cap_reached", provider: null, ...context };
  return {
    ok: true,
    provider: sender.provider,
    fromEmail: sender.fromEmail,
    remainingToday: context.dailyCap - usedToday,
    ...context,
  };
}
