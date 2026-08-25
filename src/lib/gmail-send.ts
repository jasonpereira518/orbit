import { getValidAccessToken } from "@/lib/gmail";

/**
 * Sends mail as the user through the Gmail API.
 *
 * Chosen over Orbit's Resend path deliberately: the message comes from the user's real
 * address, appears in their Sent folder, and threads under the conversation the
 * recruiter already started, so a reply reaches the user rather than Orbit.
 */

export type GmailSendInput = {
  to: string;
  subject: string;
  body: string;
  /**
   * The address the recruiter will see. Gmail only accepts an address the authorizing
   * account may send as, so this must be the connected account (or one of its verified
   * aliases) — it cannot be used to send as an arbitrary address. Passing it explicitly
   * makes the sending identity deterministic and testable rather than whatever Gmail
   * decides to fill in.
   */
  from?: { name: string | null; email: string } | null;
  /** Thread to reply into. Without it Gmail starts a new conversation. */
  threadId?: string | null;
  /** Message-ID of the message being replied to, for correct client-side threading. */
  inReplyToMessageId?: string | null;
};

export type GmailSendResult = {
  gmailMessageId: string;
  gmailThreadId: string | null;
};

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

function encodeHeader(value: string) {
  if (isAscii(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/** Strip CR/LF from header values — an unescaped newline is a header-injection vector. */
function sanitizeHeader(value: string) {
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

function toBase64Url(input: string) {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function buildMimeMessage(input: GmailSendInput): string {
  const headers = [
    ...(input.from ? [`From: ${formatAddress(input.from.name, input.from.email)}`] : []),
    `To: ${sanitizeHeader(input.to)}`,
    `Subject: ${encodeHeader(sanitizeHeader(input.subject))}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
  ];

  if (input.inReplyToMessageId) {
    const ref = sanitizeHeader(input.inReplyToMessageId);
    headers.push(`In-Reply-To: ${ref}`, `References: ${ref}`);
  }

  return `${headers.join("\r\n")}\r\n\r\n${input.body}`;
}

export async function sendGmailMessage(
  userId: string,
  input: GmailSendInput
): Promise<GmailSendResult> {
  const accessToken = await getValidAccessToken(userId);
  const raw = toBase64Url(buildMimeMessage(input));

  const res = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(
        input.threadId ? { raw, threadId: input.threadId } : { raw }
      ),
      signal: AbortSignal.timeout(20_000),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    // 403 here is almost always the missing send scope on an older connection.
    if (res.status === 403) {
      throw new Error(
        "Gmail refused the send. Reconnect Gmail to grant permission to send mail."
      );
    }
    throw new Error(`Gmail send failed: ${text.slice(0, 200)}`);
  }

  const data = (await res.json()) as { id?: string; threadId?: string };
  if (!data.id) throw new Error("Gmail send returned no message id");
  return { gmailMessageId: data.id, gmailThreadId: data.threadId || null };
}
