import { startOfUserDay } from "@/lib/user-clock";
import { viewerTimeZone } from "@/lib/viewer-time-zone";
import { outreachFromAddress } from "@/lib/outreach-sender";
import { getEffectivePlanConfig } from "@/lib/plans/plan-rules";
import { type Plan } from "@/lib/plans/plan-config";
import { SMS_OPTED_OUT_MESSAGE, isTwilioOptOut } from "@/lib/twilio-errors";
import { and, eq, gte, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  outreachCampaigns,
  outreachMessages,
  outreachProspects,
  userSettings,
} from "@/db/schema";
import { countAgentSendsToday } from "@/lib/agent-sends";
import type { PgColumn } from "drizzle-orm/pg-core";
import { decryptAndRewrap } from "@/lib/crypto-rewrap";
import { DAILY_SEND_LIMIT, type OutreachChannel } from "@/lib/outreach-types";
import { entitlementsFromSettings, resolvePlan } from "@/lib/entitlements";
import { UserFacingError } from "@/lib/errors";
import { isPlaceholderAddress, PLACEHOLDER_ADDRESS_SEND_MESSAGE } from "@/lib/outreach-quality";
import { outreachEmailPayload } from "@/lib/outreach-email";
import { ERROR_SOURCES, recordErrorEvent } from "@/lib/error-events";
import { gmailProvider } from "@/lib/email/providers/gmail";
import { outlookProvider } from "@/lib/email/providers/outlook";

export type OutreachSendProvider = "gmail" | "outlook" | "resend";

export const FIVE_HOUR_SEND_LIMITS: Record<Plan, number> = {
  free: 5,
  orbit: 50,
  max: 250,
  lifetime: 250,
};

export type FiveHourQuota = {
  plan: Plan;
  limit: number;
  used: number;
  remaining: number;
  resetsAt: Date;
  canSend: boolean;
};

/**
 * Calculates current sends in a 5-hour rolling window and checks user's plan quota
 */
export async function get5HourSendQuota(userId: string): Promise<FiveHourQuota> {
  const db = await getDb();
  const settings = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
  });

  const { plan } = resolvePlan(settings);
  const limit = FIVE_HOUR_SEND_LIMITS[plan] ?? FIVE_HOUR_SEND_LIMITS.free;

  const fiveHoursAgo = new Date(Date.now() - 5 * 3600 * 1000);

  const rows = await db
    .select({
      count: sql<number>`count(*)::int`,
      oldestSentAt: sql<Date | null>`min(${outreachMessages.sentAt})`,
    })
    .from(outreachMessages)
    .innerJoin(
      outreachProspects,
      eq(outreachMessages.prospectId, outreachProspects.id)
    )
    .innerJoin(
      outreachCampaigns,
      eq(outreachProspects.campaignId, outreachCampaigns.id)
    )
    .where(
      and(
        eq(outreachCampaigns.userId, userId),
        eq(outreachMessages.status, "sent"),
        gte(outreachMessages.sentAt, fiveHoursAgo)
      )
    );

  const used = rows[0]?.count ?? 0;
  const remaining = Math.max(0, limit - used);
  const oldestSent = rows[0]?.oldestSentAt ? new Date(rows[0].oldestSentAt) : null;
  const resetsAt = oldestSent
    ? new Date(oldestSent.getTime() + 5 * 3600 * 1000)
    : new Date(Date.now() + 5 * 3600 * 1000);

  return {
    plan,
    limit,
    used,
    remaining,
    resetsAt,
    canSend: remaining > 0,
  };
}

/**
 * Replaces {{variable}} tokens in templates with recipient data
 */
export function interpolateMailMerge(
  template: string,
  variables: {
    first_name?: string | null;
    full_name?: string | null;
    company?: string | null;
    title?: string | null;
    recent_signal?: string | null;
    sender_name?: string | null;
    [key: string]: string | null | undefined;
  }
): string {
  let result = template;
  for (const [key, val] of Object.entries(variables)) {
    const regex = new RegExp(`{{\\s*${key}\\s*}}`, "gi");
    result = result.replace(regex, val || "");
  }
  return result;
}

export async function getOutreachSendConfig(
  userId: string,
  // Optional: a caller already holding the account's `user_settings` row (from
  // `requireAuthenticatedUser()`, say) passes it and skips the read. Omitted, it is read here.
  loadedSettings?: typeof userSettings.$inferSelect
) {
  const settings =
    loadedSettings ??
    (await (await getDb()).query.userSettings.findFirst({
      where: eq(userSettings.userId, userId),
    }));

  // Orbit's own Resend/Twilio credits are metered, but not open-endedly: every user is
  // capped at DAILY_SEND_LIMIT sends a day regardless of plan, so both paid tiers can
  // reach them — including Lifetime, whose single payment funds a bounded obligation
  // rather than an unbounded one. `hosted` gates the env fallback, never the personal
  // key: a user who supplies their own Resend or Twilio credentials uses it on any plan.
  //
  // Resolved from the row just read rather than `getEntitlements`, which would read it again
  // (in a Server Action or route handler `cache()` does not deduplicate). The same resolver on
  // the same row; a missing row resolves as `getEntitlements` would for a brand-new account.
  const { canUseHostedSending: hosted } = entitlementsFromSettings(userId, settings ?? {}, await getEffectivePlanConfig());
  const envKey = (value: string | undefined) => (hosted ? value || null : null);

  // Re-encrypts a legacy or previous-secret ciphertext on the way past (audit L-06).
  const own = (stored: string | null | undefined, column: PgColumn) =>
    decryptAndRewrap(stored, { table: userSettings, column, idColumn: userSettings.userId, id: userId });
  const [ownResendKey, ownTwilioSid, ownTwilioToken] = await Promise.all([
    own(settings?.resendApiKeyEncrypted, userSettings.resendApiKeyEncrypted),
    own(settings?.twilioAccountSidEncrypted, userSettings.twilioAccountSidEncrypted),
    own(settings?.twilioAuthTokenEncrypted, userSettings.twilioAuthTokenEncrypted),
  ]);
  const hostedResendKey = envKey(process.env.RESEND_API_KEY);

  return {
    resendApiKey: ownResendKey || hostedResendKey,
    /** Whose Resend account a send goes through — only Orbit's refusals are Orbit's alarm. */
    resendKeyOwner: ownResendKey ? ("user" as const) : hostedResendKey ? ("orbit" as const) : null,
    twilioAccountSid:
      ownTwilioSid ||
      envKey(process.env.TWILIO_ACCOUNT_SID),
    twilioAuthToken:
      ownTwilioToken ||
      envKey(process.env.TWILIO_AUTH_TOKEN),
    twilioFromNumber:
      settings?.twilioFromNumber?.trim() ||
      envKey(process.env.TWILIO_FROM_NUMBER),
    fromEmail: process.env.RESEND_FROM_EMAIL || "outreach@orbit.local",
    /** True when the Resend key is the user's own — its From must be their domain. */
    resendKeyIsPersonal: Boolean(ownResendKey),
    firstName: settings?.firstName?.trim() || null,
    // The sender's own address (mirrored from Clerk), so replies — including the footer's
    // "reply and I'll remove you" opt-out — reach them, not Orbit.
    replyTo: settings?.email?.trim() || null,
  };
}

/**
 * How many messages this account has sent today, across every path that sends one.
 *
 * Campaign messages plus assistant drafts the user approved. The second half matters for the
 * cap's meaning: an MCP connector that did not count here would be a documented way to send
 * past a limit the rest of the product enforces.
 */
export async function countSendsToday(userId: string) {
  const db = await getDb();
  // The user's midnight, not the server's (UTC): the cap resets when their day does.
  const start = startOfUserDay(await viewerTimeZone(userId));

  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(outreachMessages)
    .innerJoin(
      outreachProspects,
      eq(outreachMessages.prospectId, outreachProspects.id)
    )
    .innerJoin(
      outreachCampaigns,
      eq(outreachProspects.campaignId, outreachCampaigns.id)
    )
    .where(
      and(
        eq(outreachCampaigns.userId, userId),
        eq(outreachMessages.status, "sent"),
        gte(outreachMessages.sentAt, start)
      )
    );

  return (rows[0]?.count ?? 0) + (await countAgentSendsToday(userId));
}

function appendComplianceFooter(channel: OutreachChannel, body: string) {
  if (channel === "sms") {
    return `${body.trim()}\n\nReply STOP to opt out.`;
  }
  if (channel === "email") {
    return `${body.trim()}\n\n—\nIf you'd rather not hear from me, reply and I'll remove you.`;
  }
  return body;
}

export async function sendOutreachMessage(input: {
  userId: string;
  channel: OutreachChannel;
  toEmail?: string | null;
  toPhone?: string | null;
  subject?: string | null;
  body: string;
  provider?: OutreachSendProvider;
}) {
  if (input.channel === "linkedin") {
    throw new Error("Direct LinkedIn send requires Browser Use automation. Use the 'Connect via LinkedIn (Browser Use)' option.");
  }

  // Every caller (campaign sends, contact follow-ups) passes through here, so a sample's
  // example.com address is refused even after it was copied onto a contact.
  if (input.channel === "email" && isPlaceholderAddress(input.toEmail)) {
    throw new UserFacingError(PLACEHOLDER_ADDRESS_SEND_MESSAGE);
  }

  // 1. Enforce 5-Hour Rolling Window Quota based on plan
  if (input.channel === "email") {
    const quota = await get5HourSendQuota(input.userId);
    if (!quota.canSend) {
      throw new UserFacingError(
        `5-hour send quota reached (${quota.used}/${quota.limit} on ${quota.plan} plan). Resets at ${quota.resetsAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`
      );
    }
  }

  const sentToday = await countSendsToday(input.userId);
  if (sentToday >= DAILY_SEND_LIMIT) {
    throw new Error(`Daily send limit of ${DAILY_SEND_LIMIT} reached.`);
  }

  const config = await getOutreachSendConfig(input.userId);
  const body = appendComplianceFooter(input.channel, input.body);

  if (input.channel === "email") {
    if (!input.toEmail) throw new Error("Email address is required.");

    // Handle sending via connected Gmail
    if (input.provider === "gmail") {
      const gmailIdentity = await gmailProvider.identity(input.userId);
      if (!gmailIdentity) {
        throw new UserFacingError("Gmail account is not connected or lacks send permission. Connect Gmail in Settings.");
      }
      const sent = await gmailProvider.send(
        input.userId,
        {
          from: { name: config.firstName, email: gmailIdentity.email },
          to: [input.toEmail],
          cc: [],
          bcc: [],
          subject: input.subject || "",
          bodyText: body,
          bodyHtml: null,
          messageId: `<orbit-${crypto.randomUUID()}@orbit.local>`,
        },
        { sendId: `send-${crypto.randomUUID()}` }
      );
      return { deliveryId: sent.providerMessageId || `gmail-${Date.now()}` };
    }

    // Handle sending via connected Outlook
    if (input.provider === "outlook") {
      const outlookIdentity = await outlookProvider.identity(input.userId);
      if (!outlookIdentity) {
        throw new UserFacingError("Outlook account is not connected or lacks send permission. Connect Outlook in Settings.");
      }
      const sent = await outlookProvider.send(
        input.userId,
        {
          from: { name: config.firstName, email: outlookIdentity.email },
          messageId: `orbit-${crypto.randomUUID()}`,
          to: [input.toEmail],
          cc: [],
          bcc: [],
          subject: input.subject || "",
          bodyText: body,
          bodyHtml: null,
        },
        { sendId: `send-${crypto.randomUUID()}` }
      );
      return { deliveryId: sent.providerMessageId || `outlook-${Date.now()}` };
    }

    // Default to Resend
    if (!config.resendApiKey) {
      // If user has connected Gmail or Outlook, hint at that!
      const [gmailIdent, outlookIdent] = await Promise.all([
        gmailProvider.identity(input.userId).catch(() => null),
        outlookProvider.identity(input.userId).catch(() => null),
      ]);
      if (gmailIdent) {
        const sent = await gmailProvider.send(
          input.userId,
          {
            from: { name: config.firstName, email: gmailIdent.email },
            to: [input.toEmail],
            cc: [],
            bcc: [],
            subject: input.subject || "",
            bodyText: body,
            bodyHtml: null,
            messageId: `<orbit-${crypto.randomUUID()}@orbit.local>`,
          },
          { sendId: `send-${crypto.randomUUID()}` }
        );
        return { deliveryId: sent.providerMessageId || `gmail-${Date.now()}` };
      }
      if (outlookIdent) {
        const sent = await outlookProvider.send(
          input.userId,
          {
            from: { name: config.firstName, email: outlookIdent.email },
            messageId: `orbit-${crypto.randomUUID()}`,
            to: [input.toEmail],
            cc: [],
            bcc: [],
            subject: input.subject || "",
            bodyText: body,
            bodyHtml: null,
          },
          { sendId: `send-${crypto.randomUUID()}` }
        );
        return { deliveryId: sent.providerMessageId || `outlook-${Date.now()}` };
      }
      throw new Error("No sending account configured. Connect Gmail, Outlook, or add a Resend key in Settings.");
    }

    // Orbit's domain is only sendable on Orbit's key; a personal key sends from a domain
    // verified in that Resend account, or refuses.
    const from = await outreachFromAddress({
      userId: input.userId,
      apiKey: config.resendApiKey,
      resendKeyIsPersonal: config.resendKeyIsPersonal,
      firstName: config.firstName,
      hostedFrom: config.fromEmail,
    });

    // Imported here for the same reason as Twilio below: this module sits under every page
    // that can reach an outreach action, and only an actual email send needs the SDK.
    const { Resend } = await import("resend");
    const resend = new Resend(config.resendApiKey);
    const result = await resend.emails.send(
      outreachEmailPayload({
        from,
        to: input.toEmail,
        subject: input.subject,
        text: body,
        replyTo: config.replyTo,
      })
    );

    if (result.error) {
      if (config.resendKeyOwner === "orbit") {
        await recordErrorEvent({
          source: ERROR_SOURCES.resendRejected,
          kind: "outreach",
          userId: input.userId,
          message: result.error,
          context: { name: result.error.name },
        });
      }
      throw new Error(result.error.message);
    }

    return { deliveryId: result.data?.id ?? null };
  }

  if (!input.toPhone) throw new Error("Phone number is required.");
  if (!config.twilioAccountSid || !config.twilioAuthToken || !config.twilioFromNumber) {
    throw new Error("Twilio is not fully configured. Add credentials in Settings.");
  }

  // Imported here, not at the top of the file. The Twilio SDK is ~19 MB on disk and this
  // module sits under every page that can reach an outreach action, so a static import put
  // it in the shared server chunk and made every cold start of the app evaluate it — for a
  // channel almost nobody uses. Only an actual SMS send pays for it now.
  const { default: twilio } = await import("twilio");
  const client = twilio(config.twilioAccountSid, config.twilioAuthToken);
  let message;
  try {
    message = await client.messages.create({
      from: config.twilioFromNumber,
      to: input.toPhone,
      body,
    });
  } catch (err) {
    // The footer's promise, kept by Twilio: a STOP'd number is final, not "try again".
    if (isTwilioOptOut(err)) throw new UserFacingError(SMS_OPTED_OUT_MESSAGE);
    throw err;
  }

  return { deliveryId: message.sid };
}
