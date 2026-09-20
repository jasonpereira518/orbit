/**
 * The /contact submission, minus the request. `src/actions/contact.ts` reads the IP and
 * hands it in, so a smoke script can drive this with a fake IP and a recording sender.
 */
import { Resend } from "resend";
import {
  contactSchema,
  MIN_FILL_MS,
  TOPIC_LABELS,
  type ContactInput,
  type ContactResult,
} from "@/lib/contact-message";
import { withReference } from "@/lib/errors";
import { RATE_LIMITS, consumeBucket, isRateLimitedError } from "@/lib/rate-limit";
import { reportError } from "@/lib/report-error";

export type ContactMail = { from: string; to: string; replyTo: string; subject: string; text: string };
export type ContactSender = (apiKey: string, mail: ContactMail) => Promise<{ error: unknown }>;

const resendSender: ContactSender = async (apiKey, mail) => {
  const { error } = await new Resend(apiKey).emails.send(mail);
  return { error: error ?? null };
};

/** Strip anything that could break out of a header line into a new one. */
function singleLine(value: string) {
  return value.replace(/[\r\n]+/g, " ").trim();
}

export function contactInboxConfig() {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const to = process.env.CONTACT_INBOX_EMAIL?.trim();
  const from = process.env.CONTACT_FROM_EMAIL?.trim() || process.env.RESEND_FROM_EMAIL?.trim();
  if (!apiKey || !to || !from) return null;
  return { apiKey, to, from };
}

export async function submitContactMessageCore(
  input: ContactInput,
  ctx: { ip: string; send?: ContactSender }
): Promise<ContactResult> {
  const parsed = contactSchema.safeParse(input);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const field = String(issue.path[0] ?? "");
      // The honeypot has no visible field; a bot that trips it gets the generic failure.
      if (field && field !== "website" && !fieldErrors[field]) fieldErrors[field] = issue.message;
    }
    return {
      ok: false,
      message: Object.keys(fieldErrors).length
        ? "Please fix the highlighted fields."
        : "That submission didn't look right. Please try again.",
      fieldErrors,
    };
  }

  const { name, email, topic, message, elapsedMs } = parsed.data;
  if (elapsedMs < MIN_FILL_MS) {
    return { ok: false, message: "That was too quick — give it another moment and resend." };
  }

  const config = contactInboxConfig();
  if (!config) {
    return {
      ok: false,
      message: "The form isn't wired up right now. Please reach out via jasonpereira.live instead.",
    };
  }

  // In Postgres rather than instance memory, so a flood spread across Lambdas is still one
  // budget. Fails closed like every other limiter here: a limiter that cannot count must
  // not send on Orbit's key.
  try {
    await consumeBucket("contactForm", ctx.ip, RATE_LIMITS.contactForm);
  } catch (err) {
    if (isRateLimitedError(err)) {
      return {
        ok: false,
        message: "That's a few messages in a short window. Give it a little while before sending another.",
      };
    }
    const ref = reportError(err, { where: "action.contact.limiter", extra: { topic } });
    return {
      ok: false,
      message: withReference(
        "Something went wrong sending that. Please try again, or reach out via jasonpereira.live",
        ref
      ),
    };
  }

  const sender = singleLine(name);
  const senderEmail = singleLine(email);
  try {
    const { error } = await (ctx.send ?? resendSender)(config.apiKey, {
      from: config.from,
      to: config.to,
      // Replying in the mail client goes straight back to the visitor.
      replyTo: `${sender} <${senderEmail}>`,
      subject: `[Orbit] ${TOPIC_LABELS[topic]} — ${sender}`,
      // Plain text only: nothing here is authored by us, and a text body has no markup for
      // a hostile message to escape into.
      text: [`Topic:   ${TOPIC_LABELS[topic]}`, `From:    ${sender} <${senderEmail}>`, "", message].join("\n"),
    });
    if (error) {
      // Resend answers a rejection as data, not a throw. Wrap it so the report reads as
      // "Resend rejected: validation_error: domain not verified", not "[object Object]".
      const rejection = error as { name?: string; message?: string; statusCode?: number };
      const ref = reportError(
        new Error(`Resend rejected the contact message: ${rejection.name}: ${rejection.message}`),
        { where: "action.contact.send", extra: { topic, statusCode: rejection.statusCode ?? null } }
      );
      return {
        ok: false,
        message: withReference(
          "The message couldn't be delivered. Please try again, or reach out via jasonpereira.live",
          ref
        ),
      };
    }
  } catch (err) {
    const ref = reportError(err, { where: "action.contact.send", extra: { topic } });
    return {
      ok: false,
      message: withReference(
        "Something went wrong sending that. Please try again, or reach out via jasonpereira.live",
        ref
      ),
    };
  }
  return { ok: true };
}
