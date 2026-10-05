import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { outlookConnections } from "@/db/schema";
import { MAX_ATTACHMENT_BYTES_OUTLOOK, MAX_ATTACHMENT_BYTES_OUTLOOK_REPLY } from "@/lib/email/config";
import { buildMime, withBccHeader } from "@/lib/email/mime";
import { MailProviderError, type MailProvider, type OutboundMessage } from "@/lib/email/providers/types";
import { graphFetchWithRetry } from "@/lib/graph-fetch";
import { getValidAccessToken, hasMailScope, hasSendScope } from "@/lib/outlook";

/**
 * Sends as the user through Microsoft Graph `POST /me/sendMail`, with only the `Mail.Send`
 * permission (direct-email P3, decision 1). Graph answers `202 Accepted` with no body, so a
 * send has no message or thread id. Each message carries `x-orbit-send-id` = the outbox row's
 * RFC id, so a retry can look for it in Sent Items — which needs `Mail.Read`, granted only with
 * the recruiter scan. Without it an unsure send is reported "may have sent" by the outbox,
 * never resent.
 *
 * Graph rules this relies on (v1.0 docs, checked Sep 30 2026): custom headers must be named
 * `x-…`, can only be set when the message is created or sent, and come back only when a single
 * message is read with `$select=internetMessageHeaders`.
 *
 * Replies (direct-email P5) post MIME instead (`Content-Type: text/plain`, base64 — still
 * Mail.Send, checked Sep 30 2026): only the MIME form can carry In-Reply-To/References, since
 * JSON `internetMessageHeaders` takes `x-` names only. New messages keep JSON.
 *
 * sendMail is deliberately NOT sent through `graphFetchWithRetry`: that helper retries 429/503/
 * 504, and retrying a non-idempotent send is how a person gets two copies. The outbox's own
 * retry checks Sent first.
 */
export const ORBIT_SEND_HEADER = "x-orbit-send-id";
const GRAPH = "https://graph.microsoft.com/v1.0/me";

type Recipient = { emailAddress: { address: string } };
const recipients = (emails: string[]): Recipient[] => emails.map((address) => ({ emailAddress: { address } }));

export function sendMailPayload(msg: OutboundMessage, sendHeader: string) {
  return {
    message: {
      subject: msg.subject,
      body: msg.bodyHtml
        ? { contentType: "HTML" as const, content: msg.bodyHtml }
        : { contentType: "Text" as const, content: msg.bodyText },
      toRecipients: recipients(msg.to),
      ccRecipients: recipients(msg.cc),
      bccRecipients: recipients(msg.bcc),
      internetMessageHeaders: [{ name: ORBIT_SEND_HEADER, value: sendHeader }],
      ...(msg.attachments?.length
        ? {
            attachments: msg.attachments.map((a) => ({
              "@odata.type": "#microsoft.graph.fileAttachment",
              name: a.filename,
              contentType: a.contentType,
              contentBytes: Buffer.from(a.bytes).toString("base64"),
            })),
          }
        : {}),
    },
    saveToSentItems: true,
  };
}

async function connection(userId: string) {
  const db = await getDb();
  return db.query.outlookConnections.findFirst({
    where: eq(outlookConnections.userId, userId),
    columns: { status: true, scopes: true, emailAddress: true },
  });
}

/** Token errors happen before any request leaves, so they are never ambiguous. */
async function token(userId: string): Promise<string> {
  try {
    return await getValidAccessToken(userId);
  } catch (err) {
    throw new MailProviderError("auth", err instanceof Error ? err.message : "Outlook is not connected");
  }
}

function classify(status: number, body: string): MailProviderError {
  const detail = `Graph ${status}: ${body.slice(0, 200)}`;
  // 403 on sendMail is almost always the missing Mail.Send grant on an older connection.
  if (status === 401 || status === 403) return new MailProviderError("auth", detail);
  // Throttled or explicitly unavailable: Graph did not take the message.
  if (status === 429 || status === 503) return new MailProviderError("transient", detail);
  // Any other 5xx — a gateway timeout above all — may have been accepted before it failed.
  if (status >= 500) return new MailProviderError("ambiguous", detail);
  return new MailProviderError("permanent", detail);
}

type SentListItem = { id: string; conversationId?: string; subject?: string };

export const outlookProvider: MailProvider = {
  id: "outlook",

  async identity(userId) {
    const conn = await connection(userId);
    if (!conn || conn.status !== "active" || !hasSendScope(conn.scopes)) return null;
    return { email: conn.emailAddress.trim().toLowerCase() };
  },

  async send(userId, msg) {
    // Files ride inline in sendMail, which caps them (Mail.Send only — no upload session).
    // Enqueue already refuses more; this keeps a stale row from failing at Graph instead.
    const reply = Boolean(msg.inReplyTo);
    const attached = (msg.attachments ?? []).reduce((n, a) => n + a.bytes.length, 0);
    if (attached > (reply ? MAX_ATTACHMENT_BYTES_OUTLOOK_REPLY : MAX_ATTACHMENT_BYTES_OUTLOOK)) {
      throw new MailProviderError("permanent", "attachments over Outlook's sendMail limit");
    }
    const accessToken = await token(userId);
    // Bcc rides in the MIME headers; Exchange strips it on delivery like any MTA.
    const request = reply
      ? {
          contentType: "text/plain",
          body: Buffer.from(
            withBccHeader(buildMime({ ...msg, extraHeaders: [[ORBIT_SEND_HEADER, msg.messageId]] }), msg.bcc),
            "utf8"
          ).toString("base64"),
        }
      : { contentType: "application/json", body: JSON.stringify(sendMailPayload(msg, msg.messageId)) };
    let res: Response;
    try {
      res = await fetch(`${GRAPH}/sendMail`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": request.contentType },
        body: request.body,
        signal: AbortSignal.timeout(reply && msg.attachments?.length ? 60_000 : 20_000),
      });
    } catch (err) {
      // The request may have reached Graph. The outbox checks Sent before any retry.
      throw new MailProviderError("ambiguous", err instanceof Error ? err.message : "network error");
    }
    if (!res.ok) throw classify(res.status, await res.text().catch(() => ""));
    return { providerMessageId: null, providerThreadId: null };
  },

  async findSent(userId, ref) {
    const conn = await connection(userId);
    if (!conn || conn.status !== "active" || !hasMailScope(conn.scopes)) return "unknown";
    let accessToken: string;
    try {
      accessToken = await getValidAccessToken(userId);
    } catch {
      return "unknown";
    }
    const headers = { Authorization: `Bearer ${accessToken}` };
    // Filtered by time only and matched on subject here: a single-property filter with an
    // orderby on the same property is the combination Graph reliably accepts.
    const since = new Date(ref.since.getTime() - 5 * 60_000).toISOString();
    // Built by hand: URLSearchParams would encode the `$` of OData's system options and turn
    // spaces into `+`.
    const query = [
      `$filter=${encodeURIComponent(`sentDateTime ge ${since}`)}`,
      `$orderby=${encodeURIComponent("sentDateTime desc")}`,
      "$select=id,conversationId,subject",
      "$top=25",
    ].join("&");
    const list = await graphFetchWithRetry(`${GRAPH}/mailFolders/sentitems/messages?${query}`, {
      headers,
      timeoutMs: 10_000,
    }).catch(() => null);
    if (!list || !list.ok) return "unknown";
    const { value = [] } = (await list.json().catch(() => ({}))) as { value?: SentListItem[] };
    const candidates = value.filter((m) => (m.subject ?? "").trim() === ref.subject.trim()).slice(0, 5);
    for (const candidate of candidates) {
      const one = await graphFetchWithRetry(
        `${GRAPH}/messages/${encodeURIComponent(candidate.id)}?$select=id,conversationId,internetMessageHeaders`,
        { headers, timeoutMs: 10_000 }
      ).catch(() => null);
      if (!one || !one.ok) return "unknown";
      const full = (await one.json().catch(() => ({}))) as {
        id?: string;
        conversationId?: string;
        internetMessageHeaders?: { name: string; value: string }[];
      };
      const tagged = full.internetMessageHeaders?.some(
        (h) => h.name.toLowerCase() === ORBIT_SEND_HEADER && h.value === ref.rfcMessageId
      );
      if (tagged && full.id) return { providerMessageId: full.id, providerThreadId: full.conversationId ?? null };
    }
    return null;
  },
};
