import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { gmailConnections } from "@/db/schema";
import { decrypt, encrypt } from "@/lib/crypto";
import { ReauthRequiredError, isRefreshRejection } from "@/lib/errors";

const GOOGLE_CONTACTS_SCOPE = "https://www.googleapis.com/auth/contacts.readonly";

const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
  GOOGLE_CONTACTS_SCOPE,
  "openid",
].join(" ");

/** True once a connection has re-consented to the People API scope. */
export function hasContactsScope(scopes: string | null | undefined) {
  return Boolean(scopes?.includes(GOOGLE_CONTACTS_SCOPE));
}

/** Canonical Gmail OAuth callback path — must match Google Cloud authorized redirect URIs. */
export const GMAIL_CALLBACK_PATH = "/api/gmail/callback";

export type GmailRecruiterCandidate = {
  key: string;
  fullName: string;
  email: string;
  firm: string | null;
  linkedinUrl: string | null;
  evidence: string;
  messageCount: number;
};

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
      .set({ status: "needs_reauth", updatedAt: new Date() })
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

function parseFromHeader(from: string): { name: string; email: string } | null {
  const match = from.match(/^(?:"?([^"<]*)"?\s*)?<?([^\s<>]+@[^\s<>]+)>?$/);
  if (!match) return null;
  const email = match[2].trim().toLowerCase();
  let name = (match[1] || "").trim().replace(/^"|"$/g, "");
  if (!name) {
    name = email.split("@")[0].replace(/[._]/g, " ");
  }
  return { name, email };
}

function firmFromEmail(email: string): string | null {
  const domain = email.split("@")[1];
  if (!domain) return null;
  const base = domain.split(".")[0];
  if (!base || ["gmail", "yahoo", "outlook", "hotmail", "icloud"].includes(base)) {
    return null;
  }
  return base.charAt(0).toUpperCase() + base.slice(1);
}

function looksLikeRecruiter(opts: {
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

type GmailMessageMeta = {
  id: string;
  threadId: string;
};

export async function scanGmailForRecruiters(
  userId: string,
  opts?: { maxMessages?: number; days?: number }
): Promise<GmailRecruiterCandidate[]> {
  const accessToken = await getValidAccessToken(userId);
  const days = opts?.days ?? 90;
  const maxMessages = opts?.maxMessages ?? 80;
  const after = Math.floor((Date.now() - days * 86400000) / 1000);

  const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  listUrl.searchParams.set(
    "q",
    `after:${after} (recruiter OR "talent acquisition" OR sourcer OR staffing OR "job opportunity" OR "open role")`
  );
  listUrl.searchParams.set("maxResults", String(maxMessages));

  const listRes = await fetch(listUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!listRes.ok) {
    const text = await listRes.text();
    throw new Error(`Gmail list failed: ${text.slice(0, 200)}`);
  }

  const listData = (await listRes.json()) as { messages?: GmailMessageMeta[] };
  const messages = (listData.messages || []).slice(0, maxMessages);
  const byEmail = new Map<string, GmailRecruiterCandidate>();

  type MessageDetail = {
    snippet?: string;
    payload?: { headers?: Array<{ name: string; value: string }> };
  };

  const GMAIL_DETAIL_CONCURRENCY = 8;
  const GMAIL_DETAIL_TIMEOUT_MS = 10_000;
  const details: (MessageDetail | null)[] = new Array(messages.length);
  let nextIndex = 0;

  async function fetchDetail(msg: GmailMessageMeta): Promise<MessageDetail | null> {
    try {
      const detailRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(GMAIL_DETAIL_TIMEOUT_MS),
        }
      );
      if (!detailRes.ok) return null;
      return (await detailRes.json()) as MessageDetail;
    } catch {
      return null;
    }
  }

  async function worker() {
    while (nextIndex < messages.length) {
      const current = nextIndex++;
      details[current] = await fetchDetail(messages[current]);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(GMAIL_DETAIL_CONCURRENCY, messages.length) },
      () => worker()
    )
  );

  for (const detail of details) {
    if (!detail) continue;
    const headers = detail.payload?.headers || [];
    const from =
      headers.find((h) => h.name.toLowerCase() === "from")?.value || "";
    const subject =
      headers.find((h) => h.name.toLowerCase() === "subject")?.value || "";
    const snippet = detail.snippet || "";

    if (!looksLikeRecruiter({ from, subject, snippet })) continue;
    const parsed = parseFromHeader(from);
    if (!parsed) continue;

    const existing = byEmail.get(parsed.email);
    if (existing) {
      existing.messageCount += 1;
      continue;
    }

    byEmail.set(parsed.email, {
      key: parsed.email,
      fullName: parsed.name.replace(/\b\w/g, (c) => c.toUpperCase()),
      email: parsed.email,
      firm: firmFromEmail(parsed.email),
      linkedinUrl: null,
      evidence: subject || snippet.slice(0, 120),
      messageCount: 1,
    });
  }

  const db = await getDb();
  await db
    .update(gmailConnections)
    .set({ lastSyncedAt: new Date(), updatedAt: new Date() })
    .where(eq(gmailConnections.userId, userId));

  return Array.from(byEmail.values()).sort(
    (a, b) => b.messageCount - a.messageCount
  );
}
