import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { gmailConnections } from "@/db/schema";
import { decrypt, encrypt } from "@/lib/crypto";

const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
  "openid",
].join(" ");

export type GmailRecruiterCandidate = {
  key: string;
  fullName: string;
  email: string;
  firm: string | null;
  linkedinUrl: string | null;
  evidence: string;
  messageCount: number;
};

export function isGmailConfigured() {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID?.trim() &&
      process.env.GOOGLE_CLIENT_SECRET?.trim()
  );
}

export function getGoogleRedirectUri() {
  return (
    process.env.GOOGLE_REDIRECT_URI?.trim() ||
    `${process.env.NEXT_PUBLIC_APP_URL?.trim() || "http://localhost:3000"}/api/gmail/callback`
  );
}

export function buildGmailAuthUrl(state: string) {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  if (!clientId) throw new Error("GOOGLE_CLIENT_ID is not configured");

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: getGoogleRedirectUri(),
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

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: getGoogleRedirectUri(),
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

export async function getValidAccessToken(userId: string): Promise<string> {
  const db = await getDb();
  const conn = await db.query.gmailConnections.findFirst({
    where: and(
      eq(gmailConnections.userId, userId),
      eq(gmailConnections.status, "active")
    ),
  });
  if (!conn) throw new Error("Gmail is not connected");

  const expiresSoon =
    conn.tokenExpiresAt &&
    conn.tokenExpiresAt.getTime() < Date.now() + 60_000;

  if (!expiresSoon) {
    return decrypt(conn.accessTokenEncrypted);
  }

  if (!conn.refreshTokenEncrypted) {
    throw new Error("Gmail session expired — reconnect");
  }

  const refreshed = await refreshAccessToken(
    decrypt(conn.refreshTokenEncrypted)
  );
  await upsertGmailConnection(userId, refreshed, conn.emailAddress);
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
  const messages = listData.messages || [];
  const byEmail = new Map<string, GmailRecruiterCandidate>();

  for (const msg of messages.slice(0, maxMessages)) {
    const detailRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!detailRes.ok) continue;
    const detail = (await detailRes.json()) as {
      snippet?: string;
      payload?: { headers?: Array<{ name: string; value: string }> };
    };
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
