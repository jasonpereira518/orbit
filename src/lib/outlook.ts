import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { outlookConnections } from "@/db/schema";
import { decrypt, encrypt } from "@/lib/crypto";
import { ReauthRequiredError, isRefreshRejection } from "@/lib/errors";

/**
 * Read-only access to the user's calendar, for continuous meeting sync — the Microsoft
 * Graph equivalent of Gmail's `GOOGLE_CALENDAR_SCOPE`. A token minted before this scope
 * shipped is still valid for Contacts and will keep working, but every Calendar call it
 * makes returns 403, which is why `hasCalendarScope` exists.
 */
const MICROSOFT_CALENDAR_SCOPE = "https://graph.microsoft.com/Calendars.Read";

/**
 * Read-only mail access, for the recruiter-scan feature over Outlook mail — the Graph
 * equivalent of Gmail's `gmail.readonly`. Same re-consent caveat as the calendar scope:
 * connections made before this shipped must reconnect before a scan can run.
 */
const MICROSOFT_MAIL_SCOPE = "https://graph.microsoft.com/Mail.Read";

const MICROSOFT_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "https://graph.microsoft.com/Contacts.Read",
  "https://graph.microsoft.com/User.Read",
  MICROSOFT_CALENDAR_SCOPE,
  MICROSOFT_MAIL_SCOPE,
].join(" ");

/** True once a connection has re-consented to the Contacts.Read scope. */
export function hasContactsScope(scopes: string | null | undefined) {
  return Boolean(scopes?.includes("https://graph.microsoft.com/Contacts.Read"));
}

/**
 * True once a connection has re-consented to calendar access.
 *
 * The scheduler must check this before claiming an Outlook connection for calendar sync:
 * a token minted before this scope shipped is still perfectly valid for Contacts and will
 * keep working — but every Calendar API call it makes returns 403. Without the probe that
 * surfaces as a stream of failures on healthy connections, walking them up the backoff
 * ladder for a problem only the user can fix by reconnecting.
 */
export function hasCalendarScope(scopes: string | null | undefined) {
  return Boolean(scopes?.includes(MICROSOFT_CALENDAR_SCOPE));
}

/** True once a connection has re-consented to mail access. Connections made before the
 *  mail scope shipped return false and must reconnect before a recruiter scan can run. */
export function hasMailScope(scopes: string | null | undefined) {
  return Boolean(scopes?.includes(MICROSOFT_MAIL_SCOPE));
}

/** Canonical Outlook OAuth callback path — must match the Azure app's redirect URI. */
export const OUTLOOK_CALLBACK_PATH = "/api/outlook/callback";

function tenant() {
  return process.env.MICROSOFT_TENANT_ID?.trim() || "common";
}

/**
 * Exact redirect URI for Microsoft OAuth (auth URL + token exchange).
 * Must be set per environment — never derived from request headers.
 */
export function getMicrosoftRedirectUri(): string {
  const redirectUri = process.env.MICROSOFT_REDIRECT_URI?.trim();
  if (!redirectUri) {
    throw new Error("Missing MICROSOFT_REDIRECT_URI");
  }
  if (redirectUri.includes(",")) {
    throw new Error(
      "MICROSOFT_REDIRECT_URI must be a single URL (not comma-separated)"
    );
  }
  try {
    const parsed = new URL(redirectUri);
    if (parsed.pathname.replace(/\/$/, "") !== OUTLOOK_CALLBACK_PATH) {
      throw new Error(
        `MICROSOFT_REDIRECT_URI path must be ${OUTLOOK_CALLBACK_PATH} (got ${parsed.pathname})`
      );
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("MICROSOFT_REDIRECT_URI")) {
      throw err;
    }
    throw new Error("MICROSOFT_REDIRECT_URI must be a valid absolute URL");
  }
  return redirectUri;
}

export function isOutlookConfigured() {
  try {
    getMicrosoftRedirectUri();
  } catch {
    return false;
  }
  return Boolean(
    process.env.MICROSOFT_CLIENT_ID?.trim() &&
      process.env.MICROSOFT_CLIENT_SECRET?.trim()
  );
}

/** Safe diagnostics — never includes client secret or tokens. */
export function getOutlookOAuthConfigSummary(): {
  configured: boolean;
  hasClientId: boolean;
  hasClientSecret: boolean;
  redirectUri: string | null;
  redirectUriError: string | null;
} {
  let redirectUri: string | null = null;
  let redirectUriError: string | null = null;
  try {
    redirectUri = getMicrosoftRedirectUri();
  } catch (err) {
    redirectUriError = err instanceof Error ? err.message : "invalid";
  }
  return {
    configured: isOutlookConfigured(),
    hasClientId: Boolean(process.env.MICROSOFT_CLIENT_ID?.trim()),
    hasClientSecret: Boolean(process.env.MICROSOFT_CLIENT_SECRET?.trim()),
    redirectUri,
    redirectUriError,
  };
}

export function buildMicrosoftAuthUrl(state: string) {
  const clientId = process.env.MICROSOFT_CLIENT_ID?.trim();
  if (!clientId) throw new Error("MICROSOFT_CLIENT_ID is not configured");
  const redirectUri = getMicrosoftRedirectUri();

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    response_mode: "query",
    scope: MICROSOFT_SCOPES,
    prompt: "consent",
    state,
  });
  return `https://login.microsoftonline.com/${tenant()}/oauth2/v2.0/authorize?${params}`;
}

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
};

export async function exchangeCodeForTokens(code: string): Promise<TokenResponse> {
  const clientId = process.env.MICROSOFT_CLIENT_ID?.trim();
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new Error("Microsoft OAuth is not configured");
  }
  const redirectUri = getMicrosoftRedirectUri();

  const res = await fetch(
    `https://login.microsoftonline.com/${tenant()}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const clientId = process.env.MICROSOFT_CLIENT_ID?.trim();
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new Error("Microsoft OAuth is not configured");
  }

  const res = await fetch(
    `https://login.microsoftonline.com/${tenant()}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "refresh_token",
      }),
    }
  );

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

export async function upsertOutlookConnection(
  userId: string,
  tokens: TokenResponse,
  emailAddress: string
) {
  const db = await getDb();
  const expiresAt = tokens.expires_in
    ? new Date(Date.now() + tokens.expires_in * 1000)
    : null;

  const existing = await db.query.outlookConnections.findFirst({
    where: eq(outlookConnections.userId, userId),
  });

  const accessEnc = encrypt(tokens.access_token);
  const refreshEnc = tokens.refresh_token
    ? encrypt(tokens.refresh_token)
    : existing?.refreshTokenEncrypted || null;

  if (existing) {
    const [updated] = await db
      .update(outlookConnections)
      .set({
        emailAddress,
        accessTokenEncrypted: accessEnc,
        refreshTokenEncrypted: refreshEnc,
        tokenExpiresAt: expiresAt,
        scopes: tokens.scope || MICROSOFT_SCOPES,
        status: "active",
        // Re-arm: this is the only path from needs_reauth back to active, so it is also
        // the only place a disarmed connection can rejoin the sync schedule.
        nextSyncAt: new Date(),
        syncFailures: 0,
        syncError: null,
        updatedAt: new Date(),
      })
      .where(eq(outlookConnections.id, existing.id))
      .returning();
    return updated;
  }

  const [created] = await db
    .insert(outlookConnections)
    .values({
      userId,
      emailAddress,
      accessTokenEncrypted: accessEnc,
      refreshTokenEncrypted: refreshEnc,
      tokenExpiresAt: expiresAt,
      scopes: tokens.scope || MICROSOFT_SCOPES,
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
      .update(outlookConnections)
      // `nextSyncAt: null` is not incidental. A connection whose grant is dead can never
      // produce a token, so leaving it armed makes the scheduler claim, refresh, fail and
      // reschedule it every run, forever. NULL means "not scheduled"; re-running OAuth is
      // the only way back, and `upsert...Connection` re-arms it there.
      .set({ status: "needs_reauth", nextSyncAt: null, updatedAt: new Date() })
      .where(eq(outlookConnections.userId, userId));
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
      .update(outlookConnections)
      .set({ lastSyncedAt: new Date(now) })
      .where(eq(outlookConnections.id, conn.id));
  } catch {
    // ignore
  }
}

export async function getValidAccessToken(userId: string): Promise<string> {
  const db = await getDb();
  // No `status` predicate here on purpose. Filtering it out would make a needs_reauth row
  // invisible and turn a precise "session expired — reconnect" into a wrong
  // "is not connected".
  const conn = await db.query.outlookConnections.findFirst({
    where: eq(outlookConnections.userId, userId),
  });
  if (!conn) throw new Error("Outlook is not connected");
  if (conn.status !== "active") {
    throw new Error("Outlook session expired — reconnect");
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
    throw new Error("Outlook session expired — reconnect");
  }

  let refreshed;
  try {
    refreshed = await refreshAccessToken(decrypt(conn.refreshTokenEncrypted));
  } catch (err) {
    if (err instanceof ReauthRequiredError) {
      await markNeedsReauth(userId);
      throw new Error("Outlook session expired — reconnect");
    }
    throw err;
  }

  // The upsert resets status to "active", which is the only path back from needs_reauth.
  await upsertOutlookConnection(userId, refreshed, conn.emailAddress);
  await touchLastSynced({ id: conn.id, lastSyncedAt: null });
  return refreshed.access_token;
}

export async function fetchMicrosoftProfileEmail(accessToken: string) {
  const res = await fetch("https://graph.microsoft.com/v1.0/me", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error("Failed to load Microsoft profile");
  const data = (await res.json()) as { mail?: string; userPrincipalName?: string };
  const email = data.mail || data.userPrincipalName;
  if (!email) throw new Error("Microsoft account has no email");
  return email;
}

export type OutlookContact = {
  id: string;
  fullName: string;
  firstName: string;
  lastName: string;
  company: string;
  title: string;
  email: string;
  phone: string;
};

type GraphContact = {
  id?: string;
  displayName?: string;
  givenName?: string;
  surname?: string;
  companyName?: string;
  jobTitle?: string;
  emailAddresses?: Array<{ address?: string }>;
  businessPhones?: string[];
  mobilePhone?: string;
};

/** One-shot fetch of all Outlook contacts (Microsoft Graph), paging until exhausted. */
export async function fetchOutlookContacts(
  accessToken: string
): Promise<OutlookContact[]> {
  const people: OutlookContact[] = [];
  let url:
    | string
    | null = `https://graph.microsoft.com/v1.0/me/contacts?$top=200&$select=displayName,givenName,surname,companyName,jobTitle,emailAddresses,businessPhones,mobilePhone`;

  while (url) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Outlook contacts fetch failed: ${text.slice(0, 200)}`);
    }
    const data = (await res.json()) as {
      value?: GraphContact[];
      "@odata.nextLink"?: string;
    };

    for (const c of data.value || []) {
      const fullName =
        c.displayName || [c.givenName, c.surname].filter(Boolean).join(" ");
      people.push({
        id: c.id || "",
        fullName,
        firstName: c.givenName || "",
        lastName: c.surname || "",
        company: c.companyName || "",
        title: c.jobTitle || "",
        email: c.emailAddresses?.[0]?.address || "",
        phone: c.businessPhones?.[0] || c.mobilePhone || "",
      });
    }

    url = data["@odata.nextLink"] || null;
  }

  return people.filter((p) => p.fullName.trim());
}

/**
 * Graph search-syntax adaptation of Gmail's `RECRUITER_QUERY_TERMS`.
 *
 * Best-effort, not a byte-for-byte equivalent: Graph's `$search` on `/me/messages` takes a
 * single quoted string tested against subject/body/sender, whereas Gmail's `q` supports a
 * full boolean grammar. This narrows the mailbox sweep the same way Gmail's query does —
 * cheaply, and recall-biased — before `looksLikeRecruiter` and the classifier both get a
 * veto downstream.
 */
export const OUTLOOK_RECRUITER_SEARCH_QUERY =
  '"recruiter OR staffing OR headhunter OR \\"talent acquisition\\" OR \\"job opportunity\\" OR \\"open role\\""';

/** Graph messages don't need a separate thread id for this use case. */
export type OutlookMessageRef = { id: string };

/**
 * One page of message ids from Microsoft Graph.
 *
 * Graph pagination hands back a full `@odata.nextLink` URL rather than a bare token, so —
 * unlike Gmail's `pageToken` — the caller stores and refetches that whole URL directly on
 * the next page. Simpler and correct for Graph's pagination model; there is no separate
 * token to reconstruct the query string from.
 */
export async function listOutlookMessagePage(
  accessToken: string,
  opts: { query: string; skipToken?: string | null; top?: number }
): Promise<{ messages: OutlookMessageRef[]; nextLink: string | null }> {
  const url =
    opts.skipToken ||
    `https://graph.microsoft.com/v1.0/me/messages?$search=${encodeURIComponent(
      opts.query
    )}&$top=${opts.top ?? 200}&$select=id`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      // $search requires this header (or an equivalent ConsistencyLevel) on /me/messages.
      ConsistencyLevel: "eventual",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`Outlook message list failed: ${(await res.text()).slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    value?: OutlookMessageRef[];
    "@odata.nextLink"?: string;
  };
  return {
    messages: data.value || [],
    nextLink: data["@odata.nextLink"] || null,
  };
}

export type OutlookHeaderSummary = {
  id: string;
  from: string;
  subject: string;
  snippet: string;
  internalDate: number | null;
};

type GraphMessage = {
  id?: string;
  subject?: string;
  bodyPreview?: string;
  receivedDateTime?: string;
  from?: { emailAddress?: { name?: string; address?: string } };
};

/** Bounded-concurrency fetch, mirroring Gmail's `mapWithConcurrency`. */
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

/**
 * Batch-fetch headers for a page of message refs, shaped like Gmail's `GmailHeaderSummary`
 * so `parseFromHeader`/`looksLikeRecruiter` (from `recruiter-detect.ts`) work unchanged.
 * `from` is reconstructed as `"Name <email>"` from Graph's `{ emailAddress: { name,
 * address } }` shape, which is exactly the string form `parseFromHeader` already parses.
 */
export async function fetchOutlookMessageHeaders(
  accessToken: string,
  refs: OutlookMessageRef[],
  concurrency = 8
): Promise<OutlookHeaderSummary[]> {
  const results = await mapWithConcurrency(refs, concurrency, async (ref) => {
    try {
      const res = await fetch(
        `https://graph.microsoft.com/v1.0/me/messages/${ref.id}?$select=id,subject,from,bodyPreview,receivedDateTime`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(10_000),
        }
      );
      if (!res.ok) return null;
      const msg = (await res.json()) as GraphMessage;
      const address = msg.from?.emailAddress?.address || "";
      const name = msg.from?.emailAddress?.name || "";
      const from = address ? (name ? `${name} <${address}>` : address) : "";
      const received = msg.receivedDateTime ? Date.parse(msg.receivedDateTime) : NaN;
      return {
        id: ref.id,
        from,
        subject: msg.subject || "",
        snippet: msg.bodyPreview || "",
        internalDate: Number.isFinite(received) ? received : null,
      } satisfies OutlookHeaderSummary;
    } catch {
      return null;
    }
  });
  return results.filter((r): r is OutlookHeaderSummary => r !== null);
}
