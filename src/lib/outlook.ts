import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { outlookConnections } from "@/db/schema";
import { decrypt, encrypt } from "@/lib/crypto";
import { ReauthRequiredError, isRefreshRejection } from "@/lib/errors";

const MICROSOFT_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "https://graph.microsoft.com/Contacts.Read",
  "https://graph.microsoft.com/User.Read",
].join(" ");

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
