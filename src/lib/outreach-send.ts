import { SMS_OPTED_OUT_MESSAGE, isTwilioOptOut } from "@/lib/twilio-errors";
import { and, eq, gte, sql } from "drizzle-orm";
import { Resend } from "resend";
import twilio from "twilio";
import { getDb } from "@/db";
import {
  outreachCampaigns,
  outreachMessages,
  outreachProspects,
  userSettings,
} from "@/db/schema";
import { decryptOrNull } from "@/lib/crypto";
import { DAILY_SEND_LIMIT, type OutreachChannel } from "@/lib/outreach-types";
import { getEntitlements } from "@/lib/entitlements";
import { UserFacingError } from "@/lib/errors";
import { isPlaceholderAddress, PLACEHOLDER_ADDRESS_SEND_MESSAGE } from "@/lib/outreach-quality";
import { outreachEmailPayload } from "@/lib/outreach-email";
import { ERROR_SOURCES, recordErrorEvent } from "@/lib/error-events";

export async function getOutreachSendConfig(userId: string) {
  const db = await getDb();
  const settings = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
  });

  // Orbit's own Resend/Twilio credits are metered, but not open-endedly: every user is
  // capped at DAILY_SEND_LIMIT sends a day regardless of plan, so both paid tiers can
  // reach them — including Lifetime, whose single payment funds a bounded obligation
  // rather than an unbounded one. `hosted` gates the env fallback, never the personal
  // key: a user who supplies their own Resend or Twilio credentials uses it on any plan.
  const { canUseHostedSending: hosted } = await getEntitlements(userId);
  const envKey = (value: string | undefined) => (hosted ? value || null : null);

  const ownResendKey = decryptOrNull(settings?.resendApiKeyEncrypted);
  const hostedResendKey = envKey(process.env.RESEND_API_KEY);

  return {
    resendApiKey: ownResendKey || hostedResendKey,
    /** Whose Resend account a send goes through — only Orbit's refusals are Orbit's alarm. */
    resendKeyOwner: ownResendKey ? ("user" as const) : hostedResendKey ? ("orbit" as const) : null,
    twilioAccountSid:
      decryptOrNull(settings?.twilioAccountSidEncrypted) ||
      envKey(process.env.TWILIO_ACCOUNT_SID),
    twilioAuthToken:
      decryptOrNull(settings?.twilioAuthTokenEncrypted) ||
      envKey(process.env.TWILIO_AUTH_TOKEN),
    twilioFromNumber:
      settings?.twilioFromNumber?.trim() ||
      envKey(process.env.TWILIO_FROM_NUMBER),
    fromEmail: process.env.RESEND_FROM_EMAIL || "outreach@orbit.local",
    // The sender's own address (mirrored from Clerk), so replies — including the footer's
    // "reply and I'll remove you" opt-out — reach them, not Orbit.
    replyTo: settings?.email?.trim() || null,
  };
}

export async function countSendsToday(userId: string) {
  const db = await getDb();
  const start = new Date();
  start.setHours(0, 0, 0, 0);

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

  return rows[0]?.count ?? 0;
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
}) {
  if (input.channel === "linkedin") {
    throw new Error("LinkedIn automated send is not supported.");
  }

  // Every caller (campaign sends, contact follow-ups) passes through here, so a sample's
  // example.com address is refused even after it was copied onto a contact.
  if (input.channel === "email" && isPlaceholderAddress(input.toEmail)) {
    throw new UserFacingError(PLACEHOLDER_ADDRESS_SEND_MESSAGE);
  }

  const sentToday = await countSendsToday(input.userId);
  if (sentToday >= DAILY_SEND_LIMIT) {
    throw new Error(`Daily send limit of ${DAILY_SEND_LIMIT} reached.`);
  }

  const config = await getOutreachSendConfig(input.userId);
  const body = appendComplianceFooter(input.channel, input.body);

  if (input.channel === "email") {
    if (!input.toEmail) throw new Error("Email address is required.");
    if (!config.resendApiKey) {
      throw new Error("Resend API key not configured. Add one in Settings.");
    }

    const resend = new Resend(config.resendApiKey);
    const result = await resend.emails.send(
      outreachEmailPayload({
        from: config.fromEmail,
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
