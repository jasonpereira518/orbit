import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { outlookConnections } from "@/db/schema";
import { decrypt, encrypt } from "@/lib/crypto";
import { ReauthRequiredError, isRefreshRejection } from "@/lib/errors";
import { graphFetchWithRetry } from "@/lib/graph-fetch";
import {
  hasCalendarScope as msHasCalendarScope,
  hasContactsScope as msHasContactsScope,
  hasMailScope as msHasMailScope,
  microsoftScopesFor,
  unionScopes,
  type MicrosoftPurpose,
} from "@/lib/microsoft-scopes";

/** Token exchange and refresh sit on the shared sync path; a hung provider must not hold it. */
const OAUTH_FETCH_TIMEOUT_MS = 10_000;

// No module-wide scope list any more: each entry point asks for its own scope through
// `microsoftScopesFor(purpose)` in src/lib/microsoft-scopes.ts (audit B5, Microsoft side).

/**
 * True once a connection has been granted the Contacts.Read scope. Exact-token, normalized
 * (short name / full URI / any case) — see `microsoft-scopes.ts`.
 */
export function hasContactsScope(scopes: string | null | undefined) {
  return msHasContactsScope(scopes);
}

/**
 * True once a connection has been granted calendar access.
 *
 * The scheduler must check this before claiming an Outlook connection for calendar sync:
 * a token minted without this scope is still perfectly valid for Contacts and will keep
 * working — but every Calendar API call it makes returns 403. Without the probe that
 * surfaces as a stream of failures on healthy connections, walking them up the backoff
 * ladder for a problem only the user can fix by reconnecting.
 *
 * Normalized on purpose: Microsoft echoes granted scopes as short names or full URIs, in
 * any case, so a case-sensitive URI substring test could read a real grant as "no calendar
 * scope" and silently disarm sync for that user.
 */
export function hasCalendarScope(scopes: string | null | undefined) {
  return msHasCalendarScope(scopes);
}

/** True once a connection has been granted mail access, which the recruiter scan needs. */
export function hasMailScope(scopes: string | null | undefined) {
  return msHasMailScope(scopes);
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

/**
 * `alreadyGranted` is the scopes stored on the person's existing connection (or absent for a
 * first connect): Microsoft has no incremental-consent flag, so the request names what they
 * already enabled alongside the new scope — see `microsoftScopesFor`.
 */
export function buildMicrosoftAuthUrl(
  state: string,
  purposes: readonly MicrosoftPurpose[],
  alreadyGranted?: string | null
) {
  const clientId = process.env.MICROSOFT_CLIENT_ID?.trim();
  if (!clientId) throw new Error("MICROSOFT_CLIENT_ID is not configured");
  const redirectUri = getMicrosoftRedirectUri();

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    response_mode: "query",
    scope: microsoftScopesFor(purposes, alreadyGranted).join(" "),
    prompt: "consent",
    state,
  });
  return `https://login.microsoftonline.com/${tenant()}/oauth2/v2.0/authorize?${params}`;
}

export type TokenResponse = {
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
      signal: AbortSignal.timeout(OAUTH_FETCH_TIMEOUT_MS),
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
      signal: AbortSignal.timeout(OAUTH_FETCH_TIMEOUT_MS),
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

type OutlookConnectionRow = typeof outlookConnections.$inferSelect;

/**
 * Stores an Outlook OAuth grant and decides two things the caller cannot: whether this
 * connect just armed calendar sync, and whether it just replaced a different Microsoft
 * account.
 *
 * Arming: `nextSyncAt` is only set when the union of old and new scopes covers calendar.
 * A contacts-only (or mail-only) grant is left unscheduled — arming it unconditionally
 * used to get the row claimed by the scheduler, disarmed for a missing scope, and the UI
 * then told someone who never asked for calendar that their sync was paused.
 *
 * Inheriting: the row is keyed by `userId` alone, so reconnecting with a *different*
 * Microsoft account would otherwise keep the previous account's scope union and calendar
 * cursor. Comparing the normalized previous and incoming email catches that switch here —
 * the only place it can be noticed — and drops the old scopes and sync cursor instead of
 * carrying them into the new account.
 */
export async function upsertOutlookConnection(
  userId: string,
  tokens: TokenResponse,
  emailAddress: string
): Promise<{ row: OutlookConnectionRow; switchedFrom: string | null }> {
  const db = await getDb();
  const expiresAt = tokens.expires_in
    ? new Date(Date.now() + tokens.expires_in * 1000)
    : null;

  const existing = await db.query.outlookConnections.findFirst({
    where: eq(outlookConnections.userId, userId),
  });

  const normalized = emailAddress?.trim().toLowerCase() ?? null;
  const previous = existing?.emailAddress?.trim().toLowerCase() ?? null;
  // A different Microsoft account is a different mailbox and a different calendar: its
  // grant cannot inherit the last account's scopes, and its cursor would resume a sync
  // that never happened here. The row is keyed by Orbit's user, so this is the only place
  // to notice.
  const switchedFrom = previous && normalized && previous !== normalized ? existing!.emailAddress : null;

  const accessEnc = encrypt(tokens.access_token);
  const refreshEnc = tokens.refresh_token
    ? encrypt(tokens.refresh_token)
    : switchedFrom
      ? // A different account's refresh token would mint access tokens for the OLD
        // mailbox under a row everyone believes now belongs to the new one.
        null
      : existing?.refreshTokenEncrypted || null;

  const scopes = switchedFrom ? unionScopes(null, tokens.scope) : unionScopes(existing?.scopes, tokens.scope);
  // Only a grant that covers calendar belongs in the sync queue. A grant without calendar is
  // never queued — arming a contacts-only grant unconditionally used to get the row claimed
  // by the scheduler, disarmed for a missing scope, and left the UI saying "Calendar sync
  // paused" to someone who never asked for calendar. A row the old code armed by mistake
  // heals here on its next connect.
  const armed = hasCalendarScope(scopes);
  // The pause is the person's own choice (`pauseSync`) and only they undo it (`resumeSync`,
  // the Meetings switch) — reconnecting the SAME account to add another feature (mail, say)
  // must not silently arm meetings back on. A different account already drops `syncStatus`
  // via `switchedFrom` above, so switching accounts still starts fresh and armed.
  const pausedByUser = !switchedFrom && existing?.syncStatus === "paused";

  if (existing) {
    const [row] = await db
      .update(outlookConnections)
      .set({
        emailAddress,
        accessTokenEncrypted: accessEnc,
        refreshTokenEncrypted: refreshEnc,
        tokenExpiresAt: expiresAt,
        scopes,
        status: "active",
        nextSyncAt: armed && !pausedByUser ? new Date() : null,
        syncFailures: 0,
        syncError: null,
        ...(switchedFrom ? { syncCursor: null, syncStatus: null, syncStartedAt: null, lastSyncedAt: null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(outlookConnections.id, existing.id))
      .returning();
    return { row, switchedFrom };
  }

  const [row] = await db
    .insert(outlookConnections)
    .values({
      userId,
      emailAddress,
      accessTokenEncrypted: accessEnc,
      refreshTokenEncrypted: refreshEnc,
      tokenExpiresAt: expiresAt,
      scopes,
      status: "active",
      nextSyncAt: armed ? new Date() : null,
    })
    .returning();
  return { row, switchedFrom };
}

/**
 * Stores a refreshed access token and nothing else — see `storeRefreshedGmailToken` in
 * `gmail.ts` for why a refresh must not re-arm sync or reset its failure state.
 */
export async function storeRefreshedOutlookToken(
  userId: string,
  tokens: TokenResponse
): Promise<void> {
  const db = await getDb();
  await db
    .update(outlookConnections)
    .set({
      accessTokenEncrypted: encrypt(tokens.access_token),
      ...(tokens.refresh_token
        ? { refreshTokenEncrypted: encrypt(tokens.refresh_token) }
        : {}),
      tokenExpiresAt: tokens.expires_in
        ? new Date(Date.now() + tokens.expires_in * 1000)
        : null,
      updatedAt: new Date(),
    })
    .where(eq(outlookConnections.userId, userId));
}

const OUTLOOK_SESSION_EXPIRED = "Outlook session expired — reconnect";

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

export async function getValidAccessToken(
  userId: string,
  opts: { minValidityMs?: number } = {}
): Promise<string> {
  const db = await getDb();
  // No `status` predicate here on purpose. Filtering it out would make a needs_reauth row
  // invisible and turn a precise "session expired — reconnect" into a wrong
  // "is not connected".
  const conn = await db.query.outlookConnections.findFirst({
    where: eq(outlookConnections.userId, userId),
  });
  if (!conn) throw new Error("Outlook is not connected");
  if (conn.status !== "active") {
    throw new ReauthRequiredError(OUTLOOK_SESSION_EXPIRED);
  }

  // A long-running caller (the recruiter scan) asks for a token that outlives its whole
  // invocation, so it is not minted with two minutes left and expired half-way through a page.
  const minValidityMs = opts.minValidityMs ?? 60_000;
  const expiresSoon =
    conn.tokenExpiresAt &&
    conn.tokenExpiresAt.getTime() < Date.now() + minValidityMs;

  if (!expiresSoon) {
    await touchLastSynced(conn);
    return decrypt(conn.accessTokenEncrypted);
  }

  if (!conn.refreshTokenEncrypted) {
    await markNeedsReauth(userId);
    throw new ReauthRequiredError(OUTLOOK_SESSION_EXPIRED);
  }

  let refreshed;
  try {
    refreshed = await refreshAccessToken(decrypt(conn.refreshTokenEncrypted));
  } catch (err) {
    if (err instanceof ReauthRequiredError) {
      await markNeedsReauth(userId);
      throw new ReauthRequiredError(OUTLOOK_SESSION_EXPIRED);
    }
    throw err;
  }

  await storeRefreshedOutlookToken(userId, refreshed);
  await touchLastSynced({ id: conn.id, lastSyncedAt: null });
  return refreshed.access_token;
}

export async function fetchMicrosoftProfileEmail(accessToken: string) {
  const res = await fetch("https://graph.microsoft.com/v1.0/me", {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(OAUTH_FETCH_TIMEOUT_MS),
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

/**
 * One-shot fetch of all Outlook contacts (Microsoft Graph), paging until exhausted.
 *
 * `select` narrows the read for a caller that uses only some of the fields; fields not
 * selected come back as their empty defaults. The name fields decide which contacts are
 * kept, so every selection must include `displayName,givenName,surname`.
 */
export async function fetchOutlookContacts(
  accessToken: string,
  select = "displayName,givenName,surname,companyName,jobTitle,emailAddresses,businessPhones,mobilePhone"
): Promise<OutlookContact[]> {
  const people: OutlookContact[] = [];
  let url:
    | string
    | null = `https://graph.microsoft.com/v1.0/me/contacts?$top=200&$select=${select}`;

  while (url) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      // A page of contacts, not a token call: longer, but still bounded.
      signal: AbortSignal.timeout(30_000),
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
 * Graph search-syntax adaptation of Gmail's `RECRUITER_QUERY_TERMS` — the same terms.
 *
 * Best-effort, not a byte-for-byte equivalent: Graph's `$search` on `/me/messages` takes a
 * single quoted KQL string tested against subject/body/sender, whereas Gmail's `q` supports a
 * full boolean grammar. This narrows the mailbox sweep the same way Gmail's query does —
 * cheaply, and recall-biased — before `looksLikeRecruiter` and the classifier both get a
 * veto downstream. Phrases are backslash-escaped because they sit inside the outer quotes.
 */
const OUTLOOK_RECRUITER_TERMS = [
  "recruiter",
  '\\"talent acquisition\\"',
  "sourcer",
  "staffing",
  '\\"job opportunity\\"',
  '\\"open role\\"',
  '\\"reaching out\\"',
  "headhunter",
  '\\"your background\\"',
  '\\"role at\\"',
].join(" OR ");

/** Kept for callers that want the unbounded whole-mailbox query. */
export const OUTLOOK_RECRUITER_SEARCH_QUERY = `"${OUTLOOK_RECRUITER_TERMS}"`;

/** KQL wants a plain `YYYY-MM-DD`. */
function kqlDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Builds the discovery query. The window is the single largest cost lever in the scan, so it
 * goes into the query as a KQL `received>=` restriction rather than being filtered after the
 * fetch. Graph does not allow `$filter` alongside `$search` on messages, which is why the date
 * lives inside the search string; the processor ALSO drops anything older than the window
 * client-side, so a query the service reads loosely can only cost work, never widen the scan.
 */
export function buildOutlookRecruiterQuery(opts: { after?: Date | null } = {}): string {
  const inner = opts.after
    ? `received>=${kqlDate(opts.after)} AND (${OUTLOOK_RECRUITER_TERMS})`
    : OUTLOOK_RECRUITER_TERMS;
  return `"${inner}"`;
}

/** Graph messages don't need a separate thread id for this use case. */
export type OutlookMessageRef = { id: string };

const GRAPH_MESSAGES = "https://graph.microsoft.com/v1.0/me/messages";

/**
 * Microsoft allows a small number of concurrent requests per mailbox; past it Graph answers
 * 429. Four is that ceiling, not a tuning knob.
 */
const GRAPH_MAIL_CONCURRENCY = 4;

/**
 * One page of message ids from Microsoft Graph.
 *
 * Graph pagination hands back a full `@odata.nextLink` URL rather than a bare token, so —
 * unlike Gmail's `pageToken` — the caller stores and refetches that whole URL directly on
 * the next page. Simpler and correct for Graph's pagination model; there is no separate
 * token to reconstruct the query string from.
 *
 * Note for the record: `$search` over messages is capped by Graph at the newest ~1000 hits,
 * sorted by date. A very large keyword-matching mailbox is therefore read newest-first and
 * truncated at that cap, where Gmail's list keeps paging.
 */
export async function listOutlookMessagePage(
  accessToken: string,
  opts: { query: string; skipToken?: string | null; top?: number }
): Promise<{ messages: OutlookMessageRef[]; nextLink: string | null }> {
  const url =
    opts.skipToken ||
    `${GRAPH_MESSAGES}?$search=${encodeURIComponent(opts.query)}&$top=${opts.top ?? 200}&$select=id`;

  const res = await graphFetchWithRetry(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      // $search requires this header (or an equivalent ConsistencyLevel) on /me/messages.
      ConsistencyLevel: "eventual",
    },
    timeoutMs: 30_000,
  });
  if (res.status === 401) throw new ReauthRequiredError(OUTLOOK_SESSION_EXPIRED);
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

/**
 * Ids of the folders Gmail's `-in:spam -in:trash` would have removed: Junk Email and Deleted
 * Items. Graph cannot exclude a folder inside `$search`, so the caller drops messages whose
 * `folderId` is in this set once it has their headers. A folder an account does not have
 * (404) simply contributes nothing.
 */
export async function fetchOutlookExcludedFolderIds(accessToken: string): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const name of ["junkemail", "deleteditems"]) {
    const res = await graphFetchWithRetry(
      `https://graph.microsoft.com/v1.0/me/mailFolders/${name}?$select=id`,
      { headers: { Authorization: `Bearer ${accessToken}` }, timeoutMs: 10_000 }
    );
    if (res.status === 401) throw new ReauthRequiredError(OUTLOOK_SESSION_EXPIRED);
    if (res.status === 404) continue;
    if (!res.ok) {
      throw new Error(`Outlook folder lookup failed: ${(await res.text()).slice(0, 200)}`);
    }
    const data = (await res.json()) as { id?: string };
    if (data.id) ids.add(data.id);
  }
  return ids;
}

export type OutlookHeaderSummary = {
  id: string;
  from: string;
  subject: string;
  snippet: string;
  internalDate: number | null;
  /** The message's folder — compared against `fetchOutlookExcludedFolderIds`. */
  folderId: string;
  /**
   * Bulk-mail markers, read from `internetMessageHeaders`. Graph only returns that collection
   * when it is named in `$select`, so it rides on the per-message fetch this function already
   * makes; asking for it on the list endpoint would ship every header of every hit.
   */
  listUnsubscribe: string;
  listId: string;
  precedence: string;
};

/** What the classifier reads: a header summary plus the (trimmed) plain-text body. */
export type OutlookMessageContent = Omit<
  OutlookHeaderSummary,
  "folderId" | "listUnsubscribe" | "listId" | "precedence"
> & { body: string };

type GraphMessage = {
  id?: string;
  subject?: string;
  bodyPreview?: string;
  receivedDateTime?: string;
  parentFolderId?: string;
  from?: { emailAddress?: { name?: string; address?: string } };
  body?: { contentType?: string; content?: string };
  internetMessageHeaders?: Array<{ name?: string; value?: string }>;
};

function graphHeader(msg: GraphMessage, name: string): string {
  return (
    msg.internetMessageHeaders?.find((h) => h.name?.toLowerCase() === name.toLowerCase())
      ?.value || ""
  );
}

/**
 * `from` reconstructed as `"Name <email>"` from Graph's `{ emailAddress: { name, address } }`
 * shape — exactly the string form `parseFromHeader` already parses.
 */
function graphFrom(msg: GraphMessage): string {
  const address = msg.from?.emailAddress?.address || "";
  const name = msg.from?.emailAddress?.name || "";
  return address ? (name ? `${name} <${address}>` : address) : "";
}

function graphDate(msg: GraphMessage): number | null {
  const received = msg.receivedDateTime ? Date.parse(msg.receivedDateTime) : NaN;
  return Number.isFinite(received) ? received : null;
}

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
 *
 * A 401 is the session, not the message — thrown as `ReauthRequiredError` so a page of
 * expired-token answers is not counted as "scanned, nothing recruiter-shaped".
 */
export async function fetchOutlookMessageHeaders(
  accessToken: string,
  refs: OutlookMessageRef[],
  concurrency = GRAPH_MAIL_CONCURRENCY
): Promise<OutlookHeaderSummary[]> {
  const results = await mapWithConcurrency(refs, concurrency, async (ref) => {
    try {
      const res = await graphFetchWithRetry(
        `${GRAPH_MESSAGES}/${encodeURIComponent(ref.id)}?$select=id,subject,from,bodyPreview,receivedDateTime,parentFolderId,internetMessageHeaders`,
        { headers: { Authorization: `Bearer ${accessToken}` }, timeoutMs: 10_000 }
      );
      if (res.status === 401) throw new ReauthRequiredError(OUTLOOK_SESSION_EXPIRED);
      if (!res.ok) return null;
      const msg = (await res.json()) as GraphMessage;
      return {
        id: ref.id,
        from: graphFrom(msg),
        subject: msg.subject || "",
        snippet: msg.bodyPreview || "",
        internalDate: graphDate(msg),
        folderId: msg.parentFolderId || "",
        listUnsubscribe: graphHeader(msg, "List-Unsubscribe"),
        listId: graphHeader(msg, "List-Id"),
        precedence: graphHeader(msg, "Precedence"),
      } satisfies OutlookHeaderSummary;
    } catch (err) {
      if (err instanceof ReauthRequiredError) throw err;
      return null;
    }
  });
  return results.filter((r): r is OutlookHeaderSummary => r !== null);
}

/**
 * Full plain-text content for the few messages the classifier reads per sender — Gmail's
 * `fetchGmailMessages`. `Prefer: outlook.body-content-type="text"` makes Graph do the
 * HTML-to-text conversion; if it hands back HTML anyway the tags are stripped here.
 */
export async function fetchOutlookMessages(
  accessToken: string,
  ids: string[],
  concurrency = GRAPH_MAIL_CONCURRENCY
): Promise<OutlookMessageContent[]> {
  const results = await mapWithConcurrency(ids, concurrency, async (id) => {
    try {
      const res = await graphFetchWithRetry(
        `${GRAPH_MESSAGES}/${encodeURIComponent(id)}?$select=id,subject,from,bodyPreview,receivedDateTime,body`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Prefer: 'outlook.body-content-type="text"',
          },
          timeoutMs: 15_000,
        }
      );
      if (res.status === 401) throw new ReauthRequiredError(OUTLOOK_SESSION_EXPIRED);
      if (!res.ok) return null;
      const msg = (await res.json()) as GraphMessage;
      const raw = msg.body?.content || "";
      const text =
        msg.body?.contentType?.toLowerCase() === "html"
          ? raw
              .replace(/<style[\s\S]*?<\/style>/gi, " ")
              .replace(/<[^>]+>/g, " ")
              .replace(/\s+/g, " ")
          : raw;
      return {
        id,
        from: graphFrom(msg),
        subject: msg.subject || "",
        snippet: msg.bodyPreview || "",
        internalDate: graphDate(msg),
        // Trimmed hard: quoted reply chains add nothing the classifier needs.
        body: text.trim().slice(0, 4000),
      } satisfies OutlookMessageContent;
    } catch (err) {
      if (err instanceof ReauthRequiredError) throw err;
      return null;
    }
  });
  return results.filter((r): r is OutlookMessageContent => r !== null);
}
