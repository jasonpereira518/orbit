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

  return {
    resendApiKey:
      decryptOrNull(settings?.resendApiKeyEncrypted) ||
      envKey(process.env.RESEND_API_KEY),
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
    const result = await resend.emails.send({
      from: config.fromEmail,
      to: input.toEmail,
      subject: input.subject?.trim() || "Hello",
      text: body,
    });

    if (result.error) {
      throw new Error(result.error.message);
    }

    return { deliveryId: result.data?.id ?? null };
  }

  if (!input.toPhone) throw new Error("Phone number is required.");
  if (!config.twilioAccountSid || !config.twilioAuthToken || !config.twilioFromNumber) {
    throw new Error("Twilio is not fully configured. Add credentials in Settings.");
  }

  const client = twilio(config.twilioAccountSid, config.twilioAuthToken);
  const message = await client.messages.create({
    from: config.twilioFromNumber,
    to: input.toPhone,
    body,
  });

  return { deliveryId: message.sid };
}
