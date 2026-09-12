"use server";

import { headers } from "next/headers";
import { Resend } from "resend";
import {
  contactSchema,
  MIN_FILL_MS,
  TOPIC_LABELS,
  type ContactInput,
  type ContactResult,
} from "@/lib/contact-message";

/**
 * Per-instance throttle. Fluid Compute reuses instances, so this catches the
 * obvious cases (one person hammering submit, a naive script) without a table
 * and a migration. It is a speed bump, not a guarantee: a distributed flood
 * would land on several instances and slip through. If that ever happens, the
 * upgrade is Vercel BotID in front of this action rather than a bigger Map.
 */
const RATE_WINDOW_MS = 10 * 60_000;
const RATE_MAX = 3;
const recentBySender = new Map<string, number[]>();

function overRateLimit(key: string, now: number) {
  const recent = (recentBySender.get(key) ?? []).filter(
    (at) => now - at < RATE_WINDOW_MS
  );
  if (recent.length >= RATE_MAX) {
    recentBySender.set(key, recent);
    return true;
  }
  recent.push(now);
  recentBySender.set(key, recent);

  // The map should only ever hold senders inside the window; without this it
  // grows for the lifetime of the instance.
  if (recentBySender.size > 500) {
    for (const [sender, times] of recentBySender) {
      if (times.every((at) => now - at >= RATE_WINDOW_MS)) {
        recentBySender.delete(sender);
      }
    }
  }
  return false;
}

/** Strip anything that could break out of a header line into a new one. */
function singleLine(value: string) {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function inboxConfig() {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const to = process.env.CONTACT_INBOX_EMAIL?.trim();
  const from =
    process.env.CONTACT_FROM_EMAIL?.trim() ||
    process.env.RESEND_FROM_EMAIL?.trim();
  if (!apiKey || !to || !from) return null;
  return { apiKey, to, from };
}

/**
 * Whether the contact form can actually deliver. The page hides the form when
 * this is false rather than showing one that always fails.
 */
export async function isContactFormEnabled() {
  return inboxConfig() !== null;
}

export async function submitContactMessage(
  input: ContactInput
): Promise<ContactResult> {
  const parsed = contactSchema.safeParse(input);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const field = String(issue.path[0] ?? "");
      // The honeypot has no visible field to attach an error to; a bot that
      // trips it gets the same generic failure as any other bad submission.
      if (field && field !== "website" && !fieldErrors[field]) {
        fieldErrors[field] = issue.message;
      }
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
    return {
      ok: false,
      message: "That was too quick — give it another moment and resend.",
    };
  }

  const config = inboxConfig();
  if (!config) {
    return {
      ok: false,
      message:
        "The form isn't wired up right now. Please reach out via jasonpereira.live instead.",
    };
  }

  const headerList = await headers();
  // First hop in x-forwarded-for is the client; the rest are proxies.
  const ip =
    headerList.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    headerList.get("x-real-ip")?.trim() ||
    "unknown";

  if (overRateLimit(ip, Date.now())) {
    return {
      ok: false,
      message:
        "That's a few messages in a short window. Give it a little while before sending another.",
    };
  }

  const sender = singleLine(name);
  const senderEmail = singleLine(email);

  try {
    const resend = new Resend(config.apiKey);
    const { error } = await resend.emails.send({
      from: config.from,
      to: config.to,
      // Replying in the mail client goes straight back to the visitor.
      replyTo: `${sender} <${senderEmail}>`,
      subject: `[Orbit] ${TOPIC_LABELS[topic]} — ${sender}`,
      // Plain text only: nothing here is authored by us, and a text body has
      // no markup for a hostile message to escape into.
      text: [
        `Topic:   ${TOPIC_LABELS[topic]}`,
        `From:    ${sender} <${senderEmail}>`,
        "",
        message,
      ].join("\n"),
    });

    if (error) {
      console.error("[contact] Resend rejected the message", error);
      return {
        ok: false,
        message:
          "The message couldn't be delivered. Please try again, or reach out via jasonpereira.live.",
      };
    }
  } catch (err) {
    console.error("[contact] Failed to send", err);
    return {
      ok: false,
      message:
        "Something went wrong sending that. Please try again, or reach out via jasonpereira.live.",
    };
  }

  return { ok: true };
}
