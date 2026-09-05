/**
 * Eventbrite's OAuth handshake.
 *
 * Kept apart from `eventbrite.ts` so that module keeps its "fetch and map, no side effects,
 * fixture-testable" contract — a token exchange is neither of those things.
 *
 * Eventbrite issues long-lived access tokens and does not return a refresh token on the
 * standard authorization-code flow, so there is no refresh path here. An expired or revoked
 * token surfaces as a 401, which `sync.ts` turns into `status = 'needs_reauth'` and a
 * reconnect prompt — the same terminal state Gmail reaches when its refresh token is revoked.
 */
const AUTHORIZE_URL = "https://www.eventbrite.com/oauth/authorize";
const TOKEN_URL = "https://www.eventbrite.com/oauth/token";

export type EventbriteOAuthConfig = {
  configured: boolean;
  clientId: string | null;
  redirectUri: string | null;
};

export function eventbriteOAuthConfig(): EventbriteOAuthConfig {
  const clientId = process.env.EVENTBRITE_CLIENT_ID ?? null;
  const clientSecret = process.env.EVENTBRITE_CLIENT_SECRET ?? null;
  const redirectUri =
    process.env.EVENTBRITE_REDIRECT_URI ??
    (process.env.APP_BASE_URL
      ? new URL("/api/events/eventbrite/callback", process.env.APP_BASE_URL).href
      : null);
  return {
    configured: Boolean(clientId && clientSecret && redirectUri),
    clientId,
    redirectUri,
  };
}

export function buildEventbriteAuthUrl(state: string): string {
  const config = eventbriteOAuthConfig();
  if (!config.configured) throw new Error("Eventbrite is not configured.");
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId!);
  url.searchParams.set("redirect_uri", config.redirectUri!);
  url.searchParams.set("state", state);
  return url.href;
}

export async function exchangeEventbriteCode(code: string): Promise<string> {
  const config = eventbriteOAuthConfig();
  if (!config.configured) throw new Error("Eventbrite is not configured.");

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: process.env.EVENTBRITE_CLIENT_ID!,
      client_secret: process.env.EVENTBRITE_CLIENT_SECRET!,
      code,
      redirect_uri: config.redirectUri!,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Token exchange failed (${res.status})`);

  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) throw new Error("Token exchange returned no access token");
  return body.access_token;
}
