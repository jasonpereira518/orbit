/**
 * What Radar may say, and where, about a card built from the user's mail.
 *
 * A card like that carries one model-written sentence in its lead reason. That sentence is
 * fine in the app, and fine inside the fence Radar's AI prompts already use for facts. It is
 * not fine in two places: Radar's Monday email, which leaves Orbit through a mail provider,
 * and the "user intent" line of a draft prompt, which is not fenced. Both use the fixed
 * wording below instead. Pure: no imports from the database or from Next.
 */
import { leadReason, type RadarReason } from "@/lib/radar/types";

export const EMAIL_REASON_CODES: ReadonlySet<string> = new Set([
  "email_prep",
  "email_followup",
  "email_job",
  "email_process",
  "email_news",
  "email_event",
]);

/** An email reason, or the "also:" line that carries one from a runner-up kind. */
export function isEmailReasonCode(code: string): boolean {
  return EMAIL_REASON_CODES.has(code.startsWith("also:") ? code.slice("also:".length) : code);
}

/** True when anything on the card, including an "also" line, came from the user's mail. */
export function isEmailDerived(reasons: readonly RadarReason[]): boolean {
  return reasons.some((r) => isEmailReasonCode(r.code));
}

/** The intent a draft is written to, per email reason: fixed words, never third-party text. */
export const EMAIL_DRAFT_INTENTS: Readonly<Record<string, string>> = {
  email_prep: "an interview or call coming up",
  email_followup: "a reply you owe them from your email",
  email_job: "a role that came up at their company",
  email_process: "a hiring process you are in at their company",
  email_news: "news from their company",
  email_event: "an event you were invited to",
};

/** What the Monday email says about a card built from mail. */
export const EMAIL_DIGEST_LINE = "An update from your email";

/**
 * The line under a person's name in the Monday email. The AI's sentence and the lead reason
 * are both fine for a card built from the network, and both are withheld for one built from
 * mail: the email goes out through a provider, and the notes derived from someone's mail stay
 * in the app.
 */
export function digestLineFor(why: string | null | undefined, reasons: readonly RadarReason[]): string {
  if (isEmailDerived(reasons)) return EMAIL_DIGEST_LINE;
  return why?.trim() || leadReason(reasons)?.label || "Worth a message this week";
}
