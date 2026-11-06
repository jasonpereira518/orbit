import type { EmailProviderId } from "@/db/schema";
import type { MimeInput } from "@/lib/email/mime";

export type OutboundMessage = MimeInput;
/** Ids the provider assigned. Outlook's sendMail returns none, so both can be null. */
export type SendResult = { providerMessageId: string | null; providerThreadId: string | null };

/** What a provider can use to find an earlier attempt in Sent. */
export type FindSentRef = {
  /** The row's fixed RFC Message-ID (Gmail searches it; Outlook sends it as x-orbit-send-id). */
  rfcMessageId: string;
  subject: string;
  /** No earlier than the row's creation, so a search can be bounded. */
  since: Date;
};

export type ProviderSendOptions = { threadId?: string | null; sendId: string };
export type MailErrorKind = "auth" | "transient" | "permanent" | "ambiguous";

/**
 * How a send failed, which decides what the outbox does next:
 *   auth       — the connection needs reconnecting; fail, don't retry
 *   transient  — 429/5xx; back off and retry
 *   permanent  — the provider refused this message; fail
 *   ambiguous  — the request may have reached the provider; never blindly resend
 * `message` is internal. Users see origin copy or `friendlyError`, never this text.
 */
export class MailProviderError extends Error {
  readonly kind: MailErrorKind;
  constructor(kind: MailErrorKind, message: string) {
    super(message);
    this.name = "MailProviderError";
    this.kind = kind;
  }
}

export interface MailProvider {
  id: EmailProviderId;
  /** The sending address, or null when not connected / no send scope / needs reauth. */
  identity(userId: string): Promise<{ email: string } | null>;
  send(userId: string, msg: OutboundMessage, opts: ProviderSendOptions): Promise<SendResult>;
  /** Is this message already in Sent? "unknown" = no read access, or the lookup failed. */
  findSent(userId: string, ref: FindSentRef): Promise<SendResult | null | "unknown">;
}
