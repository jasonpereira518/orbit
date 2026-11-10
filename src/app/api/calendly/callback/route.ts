import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { isDemoMode } from "@/lib/auth";
import { ERROR_SOURCES, recordErrorEvent } from "@/lib/error-events";
import { exchangeCode, parseOAuthState } from "@/lib/connectors/oauth";
import { getConnectorConnection, upsertConnectorConnection } from "@/lib/connectors/connections";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const denied = url.searchParams.get("error");
  let redirect = new URL("/settings", url.origin);

  try {
    const state = parseOAuthState(url.searchParams.get("state"));
    if (!state || state.connectorId !== "calendly") throw new Error("Invalid OAuth state");
    if (denied) throw new Error(`provider_denied: ${denied}`);
    if (!code) throw new Error("Missing authorization code");

    const sessionUserId = isDemoMode() ? "demo-user" : (await auth()).userId;
    if (!sessionUserId || sessionUserId !== state.userId) throw new Error("Signed-in user does not match OAuth state");

    const redirectUri = process.env.APP_BASE_URL
      ? new URL("/api/calendly/callback", process.env.APP_BASE_URL).href
      : url.origin + url.pathname;

    const grant = await exchangeCode("calendly", code, redirectUri);

    // Fetch user info from Calendly
    let accountEmail: string | null = null;
    try {
      const meRes = await fetch("https://api.calendly.com/users/me", {
        headers: { Authorization: `Bearer ${grant.accessToken}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (meRes.ok) {
        const meJson = await meRes.json();
        accountEmail = meJson?.resource?.email ?? null;
      }
    } catch {
      // Continue even if profile read times out
    }

    const previous = await getConnectorConnection(sessionUserId, "calendly");
    await upsertConnectorConnection({
      userId: sessionUserId,
      connectorId: "calendly",
      authKind: "oauth2",
      label: "Calendly",
      accountRef: accountEmail,
      accessToken: grant.accessToken,
      refreshToken: grant.refreshToken,
      tokenExpiresAt: grant.expiresAt,
      capabilities: previous?.capabilities?.length ? previous.capabilities : ["syncEvents"],
    });

    redirect = new URL(state.returnTo, url.origin);
    redirect.searchParams.set("calendly", "connected");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordErrorEvent({
      source: ERROR_SOURCES.oauthCalendlyCallback,
      kind: message.startsWith("provider_denied") ? "provider_denied" : /state/i.test(message) ? "state_mismatch" : "other",
      message: err,
    });
    redirect = new URL("/settings", url.origin);
    redirect.searchParams.set("calendly", "error");
  }
  return NextResponse.redirect(redirect);
}
