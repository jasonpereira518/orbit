import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { gmailConnections } from "@/db/schema";
import { buildMime, toBase64Url, withBccHeader } from "@/lib/email/mime";
import { MailProviderError, type MailProvider } from "@/lib/email/providers/types";
import { getValidAccessToken, hasSendScope } from "@/lib/gmail";
import { GOOGLE_SCOPES, hasScope } from "@/lib/google-scopes";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

async function connection(userId: string) {
  const db = await getDb();
  return db.query.gmailConnections.findFirst({
    where: eq(gmailConnections.userId, userId),
    columns: { status: true, scopes: true, emailAddress: true },
  });
}

/** Token errors happen before any request leaves, so they are never ambiguous. */
async function token(userId: string): Promise<string> {
  try {
    return await getValidAccessToken(userId);
  } catch (err) {
    throw new MailProviderError("auth", err instanceof Error ? err.message : "Gmail is not connected");
  }
}

function classify(status: number, body: string): MailProviderError {
  const detail = `Gmail ${status}: ${body.slice(0, 200)}`;
  // 403 on send is almost always the missing gmail.send scope on an older connection.
  if (status === 401 || status === 403) return new MailProviderError("auth", detail);
  if (status === 429 || status >= 500) return new MailProviderError("transient", detail);
  return new MailProviderError("permanent", detail);
}

/**
 * Sends as the user through the Gmail API: the message comes from their real address,
 * lands in their Sent folder, and threads under an existing conversation when given one.
 */
export const gmailProvider: MailProvider = {
  id: "gmail",

  async identity(userId) {
    const conn = await connection(userId);
    if (!conn || conn.status !== "active" || !hasSendScope(conn.scopes)) return null;
    return { email: conn.emailAddress.trim().toLowerCase() };
  },

  async send(userId, msg, opts = {}) {
    const accessToken = await token(userId);
    const raw = toBase64Url(withBccHeader(buildMime(msg), msg.bcc));
    let res: Response;
    try {
      res = await fetch(`${API}/messages/send`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(opts.threadId ? { raw, threadId: opts.threadId } : { raw }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      // The request may have reached Gmail. The outbox checks Sent before any retry.
      throw new MailProviderError("ambiguous", err instanceof Error ? err.message : "network error");
    }
    if (!res.ok) throw classify(res.status, await res.text().catch(() => ""));
    const data = (await res.json().catch(() => ({}))) as { id?: string; threadId?: string };
    if (!data.id) throw new MailProviderError("ambiguous", "Gmail accepted the send but returned no id");
    return { providerMessageId: data.id, providerThreadId: data.threadId ?? null };
  },

  async findSent(userId, rfcMessageId) {
    const conn = await connection(userId);
    if (!conn || conn.status !== "active" || !hasScope(conn.scopes, GOOGLE_SCOPES.gmailRead)) return "unknown";
    let accessToken: string;
    try {
      accessToken = await getValidAccessToken(userId);
    } catch {
      return "unknown";
    }
    const q = encodeURIComponent(`rfc822msgid:${rfcMessageId.replace(/^<|>$/g, "")}`);
    const res = await fetch(`${API}/messages?q=${q}&maxResults=1`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (!res || !res.ok) return "unknown";
    const data = (await res.json().catch(() => ({}))) as { messages?: { id: string; threadId?: string }[] };
    const hit = data.messages?.[0];
    return hit ? { providerMessageId: hit.id, providerThreadId: hit.threadId ?? null } : null;
  },
};
