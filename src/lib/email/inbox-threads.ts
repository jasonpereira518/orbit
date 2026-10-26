import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { gmailConnections, outlookConnections } from "@/db/schema";
import { getValidAccessToken as gmailToken } from "@/lib/gmail";
import { GOOGLE_SCOPES, hasScope } from "@/lib/google-scopes";
import { getValidAccessToken as outlookToken, hasMailScope } from "@/lib/outlook";

/**
 * The newest message with a contact in the user's own mailbox, for Compose's "reply in thread"
 * (direct-email P5, dark behind feature.reply-inbox). Metadata only — Message-ID, subject,
 * date, thread — read on demand and never stored except as the reply's In-Reply-To. Uses only
 * read scopes the user already granted (the recruiter scan's). Never throws: any failure is
 * "no target".
 */
export type InboxMessage = {
  provider: "gmail" | "outlook";
  id: string;
  subject: string;
  at: Date;
  rfcMessageId: string;
  threadId: string | null;
  mailbox: string;
};

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const GRAPH = "https://graph.microsoft.com/v1.0/me";
const EMAIL = /^[^\s@"<>():]+@[^\s@"<>():]+$/;

async function gmailAccess(userId: string) {
  const db = await getDb();
  const conn = await db.query.gmailConnections.findFirst({
    where: eq(gmailConnections.userId, userId),
    columns: { status: true, scopes: true, emailAddress: true },
  });
  if (!conn || conn.status !== "active" || !hasScope(conn.scopes, GOOGLE_SCOPES.gmailRead)) return null;
  const token = await gmailToken(userId).catch(() => null);
  return token ? { token, mailbox: conn.emailAddress.trim().toLowerCase() } : null;
}

async function outlookAccess(userId: string) {
  const db = await getDb();
  const conn = await db.query.outlookConnections.findFirst({
    where: eq(outlookConnections.userId, userId),
    columns: { status: true, scopes: true, emailAddress: true },
  });
  if (!conn || conn.status !== "active" || !hasMailScope(conn.scopes)) return null;
  const token = await outlookToken(userId).catch(() => null);
  return token ? { token, mailbox: conn.emailAddress.trim().toLowerCase() } : null;
}

async function getJson<T>(url: string, token: string): Promise<T | null> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(8_000),
  }).catch(() => null);
  if (!res || !res.ok) return null;
  return (await res.json().catch(() => null)) as T | null;
}

type GmailMeta = {
  id: string;
  threadId?: string;
  internalDate?: string;
  payload?: { headers?: { name: string; value: string }[] };
};

function fromGmail(m: GmailMeta, mailbox: string): InboxMessage | null {
  const header = (n: string) => m.payload?.headers?.find((h) => h.name.toLowerCase() === n)?.value ?? "";
  const rfc = header("message-id").trim();
  if (!rfc) return null;
  return {
    provider: "gmail",
    id: m.id,
    subject: header("subject"),
    at: new Date(Number(m.internalDate) || Date.now()),
    rfcMessageId: rfc.startsWith("<") ? rfc : `<${rfc}>`,
    threadId: m.threadId ?? null,
    mailbox,
  };
}

async function gmailById(token: string, mailbox: string, id: string) {
  const q = ["format=metadata", "metadataHeaders=Message-ID", "metadataHeaders=Subject"].join("&");
  const m = await getJson<GmailMeta>(`${GMAIL}/messages/${encodeURIComponent(id)}?${q}`, token);
  return m ? fromGmail(m, mailbox) : null;
}

type GraphMessage = { id: string; subject?: string; internetMessageId?: string; receivedDateTime?: string };
const GRAPH_SELECT = "$select=id,subject,internetMessageId,receivedDateTime";

function fromGraph(m: GraphMessage, mailbox: string): InboxMessage | null {
  if (!m.internetMessageId) return null;
  return {
    provider: "outlook",
    id: m.id,
    subject: m.subject ?? "",
    at: new Date(m.receivedDateTime ?? Date.now()),
    rfcMessageId: m.internetMessageId,
    // Mail.Send cannot target a conversation; Outlook replies thread by headers alone.
    threadId: null,
    mailbox,
  };
}

export async function latestInboxMessage(
  userId: string,
  provider: "gmail" | "outlook",
  addresses: string[]
): Promise<InboxMessage | null> {
  const emails = addresses
    .map((a) => a.trim().toLowerCase())
    .filter((a) => EMAIL.test(a))
    .slice(0, 3);
  if (!emails.length) return null;
  if (provider === "gmail") {
    const access = await gmailAccess(userId);
    if (!access) return null;
    const q = emails.map((e) => `from:${e} OR to:${e}`).join(" OR ");
    const list = await getJson<{ messages?: { id: string }[] }>(
      `${GMAIL}/messages?q=${encodeURIComponent(q)}&maxResults=1`,
      access.token
    );
    const first = list?.messages?.[0];
    return first ? gmailById(access.token, access.mailbox, first.id) : null;
  }
  const access = await outlookAccess(userId);
  if (!access) return null;
  // KQL `participants:` covers from/to/cc; $search results come newest first and take no $orderby.
  // Built by hand: URLSearchParams would encode the `$` of OData's system options.
  const kql = emails.map((e) => `participants:${e}`).join(" OR ");
  const list = await getJson<{ value?: GraphMessage[] }>(
    `${GRAPH}/messages?$search=${encodeURIComponent(`"${kql}"`)}&$top=1&${GRAPH_SELECT}`,
    access.token
  );
  const first = list?.value?.[0];
  return first ? fromGraph(first, access.mailbox) : null;
}

export async function readInboxMessage(
  userId: string,
  provider: "gmail" | "outlook",
  id: string
): Promise<InboxMessage | null> {
  if (!id || id.length > 512) return null;
  if (provider === "gmail") {
    const access = await gmailAccess(userId);
    return access ? gmailById(access.token, access.mailbox, id) : null;
  }
  const access = await outlookAccess(userId);
  if (!access) return null;
  const m = await getJson<GraphMessage>(`${GRAPH}/messages/${encodeURIComponent(id)}?${GRAPH_SELECT}`, access.token);
  return m ? fromGraph(m, access.mailbox) : null;
}

/** Gmail search for mail FROM an address since a time. `after:` takes epoch seconds. */
export function gmailReplyQuery(address: string, since: Date) {
  return `from:${address} after:${Math.floor(since.getTime() / 1000)}`;
}

/** Graph filter for mail FROM an address since a time; a quote in the address is doubled. */
export function outlookReplyFilter(address: string, since: Date) {
  return `from/emailAddress/address eq '${address.replace(/'/g, "''")}' and receivedDateTime ge ${since.toISOString()}`;
}

/**
 * When a person last wrote to the user's own mailbox since `since`, or null. Sender and date
 * only: the Gmail list returns ids, then one read asks for `internalDate` alone (`fields=`);
 * Graph is asked for `receivedDateTime` alone. No subject, snippet or body is requested, and
 * nothing is stored here. Read scopes only (the recruiter scan's), and never throws — a
 * missing grant, a bad address, a network error or an unreadable answer is all "no reply".
 */
export async function repliedSince(
  userId: string,
  provider: "gmail" | "outlook",
  address: string,
  since: Date
): Promise<Date | null> {
  const from = address.trim().toLowerCase();
  if (!EMAIL.test(from) || Number.isNaN(since.getTime())) return null;
  try {
    let at: Date;
    if (provider === "gmail") {
      const access = await gmailAccess(userId);
      if (!access) return null;
      const list = await getJson<{ messages?: { id: string }[] }>(
        `${GMAIL}/messages?q=${encodeURIComponent(gmailReplyQuery(from, since))}&maxResults=1&fields=messages/id`,
        access.token
      );
      const id = list?.messages?.[0]?.id;
      if (!id) return null;
      const m = await getJson<{ internalDate?: string }>(
        `${GMAIL}/messages/${encodeURIComponent(id)}?format=minimal&fields=internalDate`,
        access.token
      );
      at = new Date(Number(m?.internalDate));
    } else {
      const access = await outlookAccess(userId);
      if (!access) return null;
      // Built by hand: URLSearchParams would encode the `$` of OData's system options.
      const list = await getJson<{ value?: { receivedDateTime?: string }[] }>(
        `${GRAPH}/messages?$filter=${encodeURIComponent(outlookReplyFilter(from, since))}&$top=1&$select=receivedDateTime`,
        access.token
      );
      at = new Date(list?.value?.[0]?.receivedDateTime ?? Number.NaN);
    }
    return Number.isNaN(at.getTime()) ? null : at;
  } catch {
    return null;
  }
}
