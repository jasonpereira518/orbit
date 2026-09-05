import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { gmailConnections } from "@/db/schema";
import { decrypt, encrypt } from "@/lib/crypto";
import { ReauthRequiredError, isRefreshRejection } from "@/lib/errors";

const GOOGLE_CONTACTS_SCOPE = "https://www.googleapis.com/auth/contacts.readonly";

/**
 * Sending as the user, rather than through Orbit's own Resend domain, is what makes a
 * recruiter reply land in their inbox and the message appear in their Sent folder.
 *
 * This is a Google *restricted* scope: it works immediately for the developer account
 * and listed test users, but public launch requires app verification and likely a
 * security assessment. Adding it here also invalidates existing consents — every
 * already-connected user must reconnect, which is why `hasSendScope` exists.
 */
const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";

/**
 * Read-only access to the user's calendar, for continuous meeting sync.
 *
 * Unlike `gmail.send` and `gmail.readonly` above, this is a Google *sensitive* scope, not a
 * restricted one: it needs consent-screen verification but no CASA security assessment and no
 * annual reassessment. Adding it therefore costs materially less than widening the Gmail
 * scopes would — but, exactly like the send scope, it does not retroactively apply to consents
 * already granted, which is why `hasCalendarScope` exists.
 */
const GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  GMAIL_SEND_SCOPE,
  "https://www.googleapis.com/auth/userinfo.email",
  GOOGLE_CONTACTS_SCOPE,
  GOOGLE_CALENDAR_SCOPE,
  "openid",
].join(" ");

/** True once a connection has re-consented to the People API scope. */
export function hasContactsScope(scopes: string | null | undefined) {
  return Boolean(scopes?.includes(GOOGLE_CONTACTS_SCOPE));
}

/** True once a connection has re-consented to sending. Connections made before the
 *  send scope shipped return false and must reconnect before they can send. */
export function hasSendScope(scopes: string | null | undefined) {
  return Boolean(scopes?.includes(GMAIL_SEND_SCOPE));
}

/**
 * True once a connection has re-consented to calendar access.
 *
 * The scheduler must check this before claiming a Google connection for calendar sync: a
 * token minted before this scope shipped is still perfectly valid for Gmail and Contacts, and
 * will keep working — but every Calendar API call it makes returns 403. Without the probe
 * that surfaces as a stream of failures on healthy connections, walking them up the backoff
 * ladder for a problem only the user can fix by reconnecting.
 */
export function hasCalendarScope(scopes: string | null | undefined) {
  return Boolean(scopes?.includes(GOOGLE_CALENDAR_SCOPE));
}

/** Canonical Gmail OAuth callback path — must match Google Cloud authorized redirect URIs. */
export const GMAIL_CALLBACK_PATH = "/api/gmail/callback";

/**
 * Exact redirect URI for Google OAuth (auth URL + token exchange).
 * Must be set per environment — never derived from request headers.
 */
export function getGoogleRedirectUri(): string {
  const redirectUri = process.env.GOOGLE_REDIRECT_URI?.trim();
  if (!redirectUri) {
    throw new Error("Missing GOOGLE_REDIRECT_URI");
  }
  if (redirectUri.includes(",")) {
    throw new Error(
      "GOOGLE_REDIRECT_URI must be a single URL (not comma-separated)"
    );
  }
  try {
    const parsed = new URL(redirectUri);
    if (parsed.pathname.replace(/\/$/, "") !== GMAIL_CALLBACK_PATH) {
      throw new Error(
        `GOOGLE_REDIRECT_URI path must be ${GMAIL_CALLBACK_PATH} (got ${parsed.pathname})`
      );
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("GOOGLE_REDIRECT_URI")) {
      throw err;
    }
    throw new Error("GOOGLE_REDIRECT_URI must be a valid absolute URL");
  }
  return redirectUri;
}

export function isGmailConfigured() {
  try {
    getGoogleRedirectUri();
  } catch {
    return false;
  }
  return Boolean(
    process.env.GOOGLE_CLIENT_ID?.trim() &&
      process.env.GOOGLE_CLIENT_SECRET?.trim()
  );
}

/** Safe diagnostics — never includes client secret or tokens. */
export function getGmailOAuthConfigSummary(): {
  configured: boolean;
  hasClientId: boolean;
  hasClientSecret: boolean;
  redirectUri: string | null;
  redirectUriError: string | null;
} {
  let redirectUri: string | null = null;
  let redirectUriError: string | null = null;
  try {
    redirectUri = getGoogleRedirectUri();
  } catch (err) {
    redirectUriError = err instanceof Error ? err.message : "invalid";
  }
  return {
    configured: isGmailConfigured(),
    hasClientId: Boolean(process.env.GOOGLE_CLIENT_ID?.trim()),
    hasClientSecret: Boolean(process.env.GOOGLE_CLIENT_SECRET?.trim()),
    redirectUri,
    redirectUriError,
  };
}

export function buildGmailAuthUrl(state: string) {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  if (!clientId) throw new Error("GOOGLE_CLIENT_ID is not configured");
  const redirectUri = getGoogleRedirectUri();

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GMAIL_SCOPES,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
};

export async function exchangeCodeForTokens(code: string): Promise<TokenResponse> {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new Error("Google OAuth is not configured");
  }
  const redirectUri = getGoogleRedirectUri();

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new Error("Google OAuth is not configured");
  }

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    // A dead grant means reconnect; anything else is transient and must NOT mark the
    // connection, or a provider outage would flag every account at once.
    if (isRefreshRejection(res.status, text)) {
      throw new ReauthRequiredError(`Token refresh rejected: ${text.slice(0, 200)}`);
    }
    throw new Error(`Token refresh failed: ${text.slice(0, 200)}`);
  }
  return res.json();
}

export async function upsertGmailConnection(
  userId: string,
  tokens: TokenResponse,
  emailAddress: string
) {
  const db = await getDb();
  const expiresAt = tokens.expires_in
    ? new Date(Date.now() + tokens.expires_in * 1000)
    : null;

  const existing = await db.query.gmailConnections.findFirst({
    where: eq(gmailConnections.userId, userId),
  });

  const accessEnc = encrypt(tokens.access_token);
  const refreshEnc = tokens.refresh_token
    ? encrypt(tokens.refresh_token)
    : existing?.refreshTokenEncrypted || null;

  if (existing) {
    const [updated] = await db
      .update(gmailConnections)
      .set({
        emailAddress,
        accessTokenEncrypted: accessEnc,
        refreshTokenEncrypted: refreshEnc,
        tokenExpiresAt: expiresAt,
        scopes: tokens.scope || GMAIL_SCOPES,
        status: "active",
        // Re-arm: this is the only path from needs_reauth back to active, so it is also
        // the only place a disarmed connection can rejoin the sync schedule.
        nextSyncAt: new Date(),
        syncFailures: 0,
        syncError: null,
        updatedAt: new Date(),
      })
      .where(eq(gmailConnections.id, existing.id))
      .returning();
    return updated;
  }

  const [created] = await db
    .insert(gmailConnections)
    .values({
      userId,
      emailAddress,
      accessTokenEncrypted: accessEnc,
      refreshTokenEncrypted: refreshEnc,
      tokenExpiresAt: expiresAt,
      scopes: tokens.scope || GMAIL_SCOPES,
      status: "active",
      nextSyncAt: new Date(),
    })
    .returning();
  return created;
}

/**
 * Marks a connection as needing reconnection. Best-effort: health telemetry must never
 * turn a session-expired error into a 500.
 */
async function markNeedsReauth(userId: string) {
  try {
    const db = await getDb();
    await db
      .update(gmailConnections)
      // `nextSyncAt: null` is not incidental. A connection whose grant is dead can never
      // produce a token, so leaving it armed makes the scheduler claim, refresh, fail and
      // reschedule it every run, forever. NULL means "not scheduled"; re-running OAuth is
      // the only way back, and `upsert...Connection` re-arms it there.
      .set({ status: "needs_reauth", nextSyncAt: null, updatedAt: new Date() })
      .where(eq(gmailConnections.userId, userId));
  } catch {
    // ignore
  }
}

/** Stamps "this connection produced a usable token", at most once every 15 minutes. */
async function touchLastSynced(conn: { id: string; lastSyncedAt: Date | null }) {
  const now = Date.now();
  if (conn.lastSyncedAt && now - conn.lastSyncedAt.getTime() < 15 * 60 * 1000) return;
  try {
    const db = await getDb();
    await db
      .update(gmailConnections)
      .set({ lastSyncedAt: new Date(now) })
      .where(eq(gmailConnections.id, conn.id));
  } catch {
    // ignore
  }
}

export async function getValidAccessToken(userId: string): Promise<string> {
  const db = await getDb();
  // No `status` predicate here on purpose. Filtering it out would make a needs_reauth row
  // invisible and turn a precise "session expired — reconnect" into a wrong
  // "is not connected".
  const conn = await db.query.gmailConnections.findFirst({
    where: eq(gmailConnections.userId, userId),
  });
  if (!conn) throw new Error("Gmail is not connected");
  if (conn.status !== "active") {
    throw new Error("Gmail session expired — reconnect");
  }

  const expiresSoon =
    conn.tokenExpiresAt &&
    conn.tokenExpiresAt.getTime() < Date.now() + 60_000;

  if (!expiresSoon) {
    await touchLastSynced(conn);
    return decrypt(conn.accessTokenEncrypted);
  }

  if (!conn.refreshTokenEncrypted) {
    await markNeedsReauth(userId);
    throw new Error("Gmail session expired — reconnect");
  }

  let refreshed;
  try {
    refreshed = await refreshAccessToken(decrypt(conn.refreshTokenEncrypted));
  } catch (err) {
    if (err instanceof ReauthRequiredError) {
      await markNeedsReauth(userId);
      throw new Error("Gmail session expired — reconnect");
    }
    throw err;
  }

  // The upsert resets status to "active", which is the only path back from needs_reauth.
  await upsertGmailConnection(userId, refreshed, conn.emailAddress);
  await touchLastSynced({ id: conn.id, lastSyncedAt: null });
  return refreshed.access_token;
}

export async function fetchGoogleProfileEmail(accessToken: string) {
  const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error("Failed to load Google profile");
  const data = (await res.json()) as { email?: string };
  if (!data.email) throw new Error("Google account has no email");
  return data.email;
}

export type GooglePeopleContact = {
  resourceName: string;
  fullName: string;
  firstName: string;
  lastName: string;
  company: string;
  title: string;
  email: string;
  phone: string;
  photoUrl: string | null;
};

type PeopleApiPerson = {
  resourceName?: string;
  names?: Array<{ displayName?: string; givenName?: string; familyName?: string }>;
  organizations?: Array<{ name?: string; title?: string }>;
  emailAddresses?: Array<{ value?: string }>;
  phoneNumbers?: Array<{ value?: string }>;
  photos?: Array<{ url?: string; default?: boolean }>;
};

/** One-shot fetch of all Google Contacts (People API), paging until exhausted. */
export async function fetchGooglePeopleContacts(
  accessToken: string
): Promise<GooglePeopleContact[]> {
  const people: GooglePeopleContact[] = [];
  let pageToken: string | undefined;

  do {
    const url = new URL("https://people.googleapis.com/v1/people/me/connections");
    url.searchParams.set(
      "personFields",
      "names,emailAddresses,organizations,photos,phoneNumbers"
    );
    url.searchParams.set("pageSize", "200");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Google Contacts fetch failed: ${text.slice(0, 200)}`);
    }
    const data = (await res.json()) as {
      connections?: PeopleApiPerson[];
      nextPageToken?: string;
    };

    for (const person of data.connections || []) {
      const name = person.names?.[0];
      const org = person.organizations?.[0];
      const photo = person.photos?.find((p) => !p.default);
      people.push({
        resourceName: person.resourceName || "",
        fullName: name?.displayName || "",
        firstName: name?.givenName || "",
        lastName: name?.familyName || "",
        company: org?.name || "",
        title: org?.title || "",
        email: person.emailAddresses?.[0]?.value || "",
        phone: person.phoneNumbers?.[0]?.value || "",
        photoUrl: photo?.url || null,
      });
    }

    pageToken = data.nextPageToken;
  } while (pageToken);

  return people.filter((p) => p.fullName || p.firstName || p.lastName);
}

const RECRUITER_TITLE_RE =
  /\b(recruiter|talent\s*acquisition|sourcer|staffing|headhunter|talent\s*partner|technical\s*recruiter)\b/i;

const AGENCY_DOMAIN_HINTS = [
  "robertwalters",
  "michaelpage",
  "hays",
  "roberthalf",
  "kforce",
  "aerotek",
  "randstad",
  "adecco",
  "manpower",
  "teksystems",
  "insightglobal",
  "cybercoders",
  "jeffersonfrank",
  "harveynash",
];

export function parseFromHeader(from: string): { name: string; email: string } | null {
  const match = from.match(/^(?:"?([^"<]*)"?\s*)?<?([^\s<>]+@[^\s<>]+)>?$/);
  if (!match) return null;
  const email = match[2].trim().toLowerCase();
  let name = (match[1] || "").trim().replace(/^"|"$/g, "");
  if (!name) {
    name = email.split("@")[0].replace(/[._]/g, " ");
  }
  return { name, email };
}

export function firmFromEmail(email: string): string | null {
  const domain = email.split("@")[1];
  if (!domain) return null;
  const base = domain.split(".")[0];
  if (!base || ["gmail", "yahoo", "outlook", "hotmail", "icloud"].includes(base)) {
    return null;
  }
  return base.charAt(0).toUpperCase() + base.slice(1);
}

export function looksLikeRecruiter(opts: {
  from: string;
  subject: string;
  snippet: string;
}): boolean {
  const blob = `${opts.from} ${opts.subject} ${opts.snippet}`;
  if (RECRUITER_TITLE_RE.test(blob)) return true;
  const emailMatch = opts.from.match(/@([^\s>]+)/);
  const domain = emailMatch?.[1]?.toLowerCase() || "";
  if (AGENCY_DOMAIN_HINTS.some((h) => domain.includes(h))) return true;
  if (
    /\b(open\s+role|hiring|job\s+opportunity|opportunity\s+with|are\s+you\s+open)\b/i.test(
      blob
    ) &&
    /\b(recruit|talent|staffing|hiring\s+for)\b/i.test(blob)
  ) {
    return true;
  }
  return false;
}

/**
 * Gmail-side keyword filter. Everything downstream is far more expensive than this —
 * a metadata fetch per hit, then an LLM call per surviving sender — so narrowing here
 * is what makes a whole-mailbox scan affordable.
 *
 * Deliberately recall-biased and imprecise: `looksLikeRecruiter` and then the classifier
 * both get a veto, so a false positive costs one cheap fetch while a false negative is
 * invisible forever.
 */
export const RECRUITER_QUERY_TERMS =
  '(recruiter OR "talent acquisition" OR sourcer OR staffing OR "job opportunity" OR "open role" OR "reaching out" OR headhunter OR "your background" OR "role at")';

export type GmailMessageRef = { id: string; threadId: string };

/**
 * One page of message ids. The caller owns the cursor so a time-boxed job can persist
 * `nextPageToken` and resume in a later invocation instead of restarting the mailbox.
 */
export async function listGmailMessagePage(
  accessToken: string,
  opts: { query: string; pageToken?: string | null; maxResults?: number }
): Promise<{ messages: GmailMessageRef[]; nextPageToken: string | null }> {
  const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  url.searchParams.set("q", opts.query);
  url.searchParams.set("maxResults", String(opts.maxResults ?? 500));
  if (opts.pageToken) url.searchParams.set("pageToken", opts.pageToken);

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`Gmail list failed: ${(await res.text()).slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    messages?: GmailMessageRef[];
    nextPageToken?: string;
  };
  return {
    messages: data.messages || [],
    nextPageToken: data.nextPageToken || null,
  };
}

export type GmailHeaderSummary = {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  snippet: string;
  internalDate: number | null;
};

type RawGmailMessage = {
  id?: string;
  threadId?: string;
  snippet?: string;
  internalDate?: string;
  payload?: {
    headers?: Array<{ name: string; value: string }>;
    mimeType?: string;
    body?: { data?: string };
    parts?: RawGmailMessage["payload"][];
  };
};

function headerValue(msg: RawGmailMessage, name: string) {
  return (
    msg.payload?.headers?.find(
      (h) => h.name.toLowerCase() === name.toLowerCase()
    )?.value || ""
  );
}

/** Bounded-concurrency fetch, matching the pool the original scan used. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker())
  );
  return out;
}

export async function fetchGmailHeaders(
  accessToken: string,
  refs: GmailMessageRef[],
  concurrency = 8
): Promise<GmailHeaderSummary[]> {
  const results = await mapWithConcurrency(refs, concurrency, async (ref) => {
    try {
      const res = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${ref.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(10_000),
        }
      );
      if (!res.ok) return null;
      const msg = (await res.json()) as RawGmailMessage;
      const internal = Number(msg.internalDate);
      return {
        id: ref.id,
        threadId: msg.threadId || ref.threadId,
        from: headerValue(msg, "From"),
        subject: headerValue(msg, "Subject"),
        snippet: msg.snippet || "",
        internalDate: Number.isFinite(internal) ? internal : null,
      } satisfies GmailHeaderSummary;
    } catch {
      return null;
    }
  });
  return results.filter((r): r is GmailHeaderSummary => r !== null);
}

function decodeBase64Url(data: string) {
  try {
    return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  } catch {
    return "";
  }
}

/** Depth-first walk for the first text/plain part; falls back to stripped HTML. */
function extractBody(payload: RawGmailMessage["payload"]): string {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }
  for (const part of payload.parts || []) {
    const found = extractBody(part);
    if (found) return found;
  }
  if (payload.mimeType === "text/html" && payload.body?.data) {
    return decodeBase64Url(payload.body.data)
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ");
  }
  return "";
}

export type GmailMessageContent = GmailHeaderSummary & { body: string };

export async function fetchGmailMessages(
  accessToken: string,
  ids: string[],
  concurrency = 4
): Promise<GmailMessageContent[]> {
  const results = await mapWithConcurrency(ids, concurrency, async (id) => {
    try {
      const res = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(15_000),
        }
      );
      if (!res.ok) return null;
      const msg = (await res.json()) as RawGmailMessage;
      const internal = Number(msg.internalDate);
      return {
        id,
        threadId: msg.threadId || "",
        from: headerValue(msg, "From"),
        subject: headerValue(msg, "Subject"),
        snippet: msg.snippet || "",
        internalDate: Number.isFinite(internal) ? internal : null,
        // Trimmed hard: quoted reply chains routinely run to tens of thousands of
        // characters and add nothing the classifier needs.
        body: extractBody(msg.payload).slice(0, 4000),
      } satisfies GmailMessageContent;
    } catch {
      return null;
    }
  });
  return results.filter((r): r is GmailMessageContent => r !== null);
}
