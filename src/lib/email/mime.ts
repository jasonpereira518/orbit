import { randomUUID } from "node:crypto";

/**
 * RFC 5322 message building for Orbit's outbound mail. Pure: no network, no DB. Moved here
 * from `src/lib/gmail-send.ts` so every mail provider builds the same bytes.
 */

/**
 * RFC 2047 encoded-word, so non-ASCII subjects survive transport.
 * Headers are 7-bit only; a bare "Café" arrives mojibaked.
 */
function isAscii(value: string) {
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) > 127) return false;
  }
  return true;
}

export function encodeHeader(value: string) {
  if (isAscii(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/** Strip CR/LF from header values — an unescaped newline is a header-injection vector. */
export function sanitizeHeader(value: string) {
  return value.replace(/[\r\n]+/g, " ").trim();
}

/**
 * Render a `Display Name <addr>` header value.
 *
 * ASCII names are quoted unconditionally — always valid, and it sidesteps having to
 * decide whether a given name contains RFC 5322 specials. Non-ASCII names use an
 * encoded-word instead, which must NOT be quoted.
 */
export function formatAddress(name: string | null | undefined, email: string) {
  const addr = sanitizeHeader(email);
  const display = sanitizeHeader(name || "");
  if (!display) return addr;
  if (!isAscii(display)) return `${encodeHeader(display)} <${addr}>`;
  const escaped = display.replace(/(["\\])/g, "\\$1");
  return `"${escaped}" <${addr}>`;
}

export function toBase64Url(input: string) {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export type MimeInput = {
  from: { name: string | null; email: string };
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  bodyText: string;
  bodyHtml: string | null;
  /** Fixed at enqueue; the outbox's duplicate check searches Sent for it. */
  messageId: string;
  inReplyTo?: string | null;
  references?: string | null;
};

/** `<uuid@orbit.mail>` — globally unique, and searchable via Gmail's `rfc822msgid:`. */
export function newRfcMessageId(domain = "orbit.mail"): string {
  return `<${randomUUID()}@${domain}>`;
}

function addressList(emails: string[]) {
  return emails.map((e) => sanitizeHeader(e)).join(", ");
}

/**
 * The message every recipient sees. Bcc is deliberately not written here: a provider that
 * reads recipients from the raw headers adds it with `withBccHeader` on its own copy, and one
 * that takes an envelope (Graph) never needs it.
 */
export function buildMime(input: MimeInput, boundary = `orbit-${randomUUID()}`): string {
  const headers = [
    `From: ${formatAddress(input.from.name, input.from.email)}`,
    `To: ${addressList(input.to)}`,
    ...(input.cc.length ? [`Cc: ${addressList(input.cc)}`] : []),
    `Subject: ${encodeHeader(sanitizeHeader(input.subject))}`,
    `Message-ID: ${sanitizeHeader(input.messageId)}`,
    "MIME-Version: 1.0",
  ];
  if (input.inReplyTo) headers.push(`In-Reply-To: ${sanitizeHeader(input.inReplyTo)}`);
  if (input.references) headers.push(`References: ${sanitizeHeader(input.references)}`);

  if (!input.bodyHtml) {
    headers.push('Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: 8bit");
    return `${headers.join("\r\n")}\r\n\r\n${input.bodyText}`;
  }
  headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
  const part = (type: string, content: string) =>
    [`--${boundary}`, `Content-Type: ${type}; charset="UTF-8"`, "Content-Transfer-Encoding: 8bit", "", content].join(
      "\r\n"
    );
  return [headers.join("\r\n"), "", part("text/plain", input.bodyText), part("text/html", input.bodyHtml), `--${boundary}--`, ""].join(
    "\r\n"
  );
}

/**
 * Gmail's `messages.send` takes recipients from the raw headers and strips Bcc before
 * delivery, so its copy carries the Bcc header. Nothing else should call this.
 */
export function withBccHeader(mime: string, bcc: string[]): string {
  if (!bcc.length) return mime;
  const split = mime.indexOf("\r\n\r\n");
  return `${mime.slice(0, split)}\r\nBcc: ${addressList(bcc)}${mime.slice(split)}`;
}
