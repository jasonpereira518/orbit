import { isPlaceholderAddress } from "@/lib/outreach-quality";
import { DRAFT_MAX_CHARS, sanitizeDraft } from "@/lib/chat-draft";

/**
 * The rules for sending a chat draft from the user's Gmail, kept pure so they can be pinned
 * without a mailbox. The action that uses them is `src/actions/chat-send.ts`; the rule at the
 * top of `src/lib/mcp/server.ts` applies here in full — an agent composes, a human sends. The
 * model only ever wrote the DRAFT. Who it goes to, and whether it goes, are decided by the
 * contact record and a person's click, never by anything the model or the page supplied.
 */

export const SEND_SUBJECT_MAX = 200;
export const SEND_BODY_MAX = DRAFT_MAX_CHARS;
export const DEFAULT_SEND_SUBJECT = "Following up";

/** How many chat sends one account may make in a day, counted from the claim rows. */
export const CHAT_SEND_DAILY_CAP = 25;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

export type RecipientCheck =
  | { ok: true; email: string }
  | { ok: false; reason: "no_email" | "invalid_recipient" | "placeholder" };

/**
 * Whether a stored address is exactly one real mailbox.
 *
 * `sendGmailMessage` writes the value straight into a `To:` header and never checks it, so a
 * stored `a@b.com, c@d.com` would go to two people and `Ann <a@b.com>` to whoever the header
 * parser decides. A contact's email is text somebody typed or an import guessed, so the check
 * is deliberately narrower than RFC 5322: one `@`, no whitespace, comma, semicolon, angle
 * bracket, quote, parenthesis or backslash, a dotted domain, and nothing reserved for
 * placeholders. Refusing a rare valid-but-odd address is a fine trade for never sending to two.
 */
export function checkRecipient(raw: string | null | undefined): RecipientCheck {
  const email = (raw ?? "").trim();
  if (!email) return { ok: false, reason: "no_email" };
  if (email.length > 254) return { ok: false, reason: "invalid_recipient" };
  const parts = email.split("@");
  if (parts.length !== 2) return { ok: false, reason: "invalid_recipient" };
  const [local, domain] = parts as [string, string];
  if (!local || local.length > 64 || !domain) return { ok: false, reason: "invalid_recipient" };
  // Every character code, not a regex range: this file must not carry control bytes.
  for (const ch of email) {
    const code = ch.codePointAt(0)!;
    if (code <= 32 || code === 127) return { ok: false, reason: "invalid_recipient" };
    if (",;<>()[]\"'\\".includes(ch)) return { ok: false, reason: "invalid_recipient" };
  }
  const labels = domain.split(".");
  if (labels.length < 2 || labels.some((l) => !l || l.startsWith("-") || l.endsWith("-"))) {
    return { ok: false, reason: "invalid_recipient" };
  }
  if (isPlaceholderAddress(email)) return { ok: false, reason: "placeholder" };
  return { ok: true, email };
}

export type ContentCheck =
  | { ok: true; subject: string; body: string }
  | { ok: false; reason: "empty_body" | "body_too_long" | "subject_too_long" };

/**
 * The subject and body as they will actually be sent.
 *
 * Both are cleaned of what a reader cannot see (control and zero-width characters, bidi
 * overrides) and the dialog shows the cleaned text, so what is previewed is what goes. A blank
 * subject becomes the default rather than an error: an email needs one and "Following up" is
 * the honest default for a follow-up. A subject is one line, so any line break becomes a space.
 */
export function checkContent(input: { subject?: string | null; body: string }): ContentCheck {
  const body = sanitizeDraft(input.body);
  if (!body) return { ok: false, reason: "empty_body" };
  if (Array.from(body).length > SEND_BODY_MAX) return { ok: false, reason: "body_too_long" };
  const oneLine = (sanitizeDraft(input.subject ?? "") ?? "").replace(/\s+/g, " ").trim();
  if (Array.from(oneLine).length > SEND_SUBJECT_MAX) return { ok: false, reason: "subject_too_long" };
  return { ok: true, subject: oneLine || DEFAULT_SEND_SUBJECT, body };
}

/** The key that makes a send claimable exactly once: one message, one person. */
export function chatSendExternalId(messageId: string, contactId: string): string {
  return `chat-send:${messageId}:${contactId}`;
}

/** The contact a claim key names, or null when it is not one of ours. */
export function contactIdFromSendKey(externalId: string, messageId: string): string | null {
  const prefix = `chat-send:${messageId}:`;
  if (!externalId.startsWith(prefix)) return null;
  const rest = externalId.slice(prefix.length);
  return isUuid(rest) ? rest : null;
}

export type SendFailureKind =
  /** Definitely not sent: a release of the claim is safe and a retry is fine. */
  | "definite"
  /** Gmail may have accepted it. Never retry on our own; the person checks Sent. */
  | "ambiguous"
  | "needs_reconnect";

/**
 * Sort a thrown send error into what may safely happen next.
 *
 * The distinction is whether Gmail could have accepted the message. An answer from Gmail that
 * is not a success (`Gmail send failed:`, the 403 refusal) means it did not. A dead grant is
 * caught before any request is made. Everything else — the 20-second abort that fires after
 * the request left, a dropped connection, a success response with no id — is ambiguous, and an
 * ambiguous send keeps its claim so that a retry cannot email the same person twice.
 */
export function classifySendError(err: unknown): SendFailureKind {
  if (err instanceof Error && err.name === "ReauthRequiredError") return "needs_reconnect";
  const message = err instanceof Error ? err.message : String(err);
  if (/^Gmail refused the send/i.test(message)) return "needs_reconnect";
  if (/^Gmail send failed/i.test(message)) return "definite";
  return "ambiguous";
}
