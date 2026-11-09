import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { isDemoMode } from "@/lib/auth";
import { ERROR_SOURCES, recordErrorEvent } from "@/lib/error-events";
import { exchangeCode, parseOAuthState } from "@/lib/connectors/oauth";
import { notionWorkspace } from "@/lib/connectors/notion";
import { getConnectorConnection, loadConnectorConnection, upsertConnectorConnection } from "@/lib/connectors/connections";
import { integrationHref } from "@/components/settings/sections";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// No maxDuration on purpose: each distinct value is another Vercel function, and Hobby is capped.

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const denied = url.searchParams.get("error");
  let redirect = new URL(integrationHref("notion"), url.origin);

  try {
    const state = parseOAuthState(url.searchParams.get("state"));
    if (!state || state.connectorId !== "notion") throw new Error("Invalid OAuth state");
    if (denied) throw new Error(`provider_denied: ${denied}`);
    if (!code) throw new Error("Missing authorization code");
    // A signed state proves Orbit minted it, not who brought it back (see `OAuthState`).
    const sessionUserId = isDemoMode() ? "demo-user" : (await auth()).userId;
    if (!sessionUserId || sessionUserId !== state.userId) throw new Error("Signed-in user does not match OAuth state");

    // Must match the authorize-time redirect exactly (`callbackUrl` in actions/notion.ts).
    const redirectUri = process.env.APP_BASE_URL
      ? new URL("/api/notion/callback", process.env.APP_BASE_URL).href
      : url.origin + url.pathname;
    const grant = await exchangeCode("notion", code, redirectUri);
    // A reconnect (how people change which pages Orbit sees) keeps the chosen people database.
    const previous = await getConnectorConnection(sessionUserId, "notion");
    const kept = previous ? (await loadConnectorConnection(previous.id))?.cursor?.notion : null;
    const workspace = notionWorkspace(grant.raw);
    await upsertConnectorConnection({
      userId: sessionUserId,
      connectorId: "notion",
      authKind: "oauth2",
      label: "Notion",
      accountRef: workspace.workspaceName,
      accessToken: grant.accessToken,
      refreshToken: grant.refreshToken,
      tokenExpiresAt: grant.expiresAt,
      capabilities: previous?.capabilities ?? [],
      syncCursor: {
        notion: { ...workspace, dataSourceId: kept?.dataSourceId ?? null, dataSourceTitle: kept?.dataSourceTitle ?? null, mapping: kept?.mapping ?? null },
      },
    });
    redirect = new URL(state.returnTo, url.origin);
    redirect.searchParams.set("notion", "connected");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordErrorEvent({
      source: ERROR_SOURCES.oauthNotionCallback,
      kind: message.startsWith("provider_denied") ? "provider_denied" : /state/i.test(message) ? "state_mismatch" : "other",
      message: err,
    });
    redirect = new URL(integrationHref("notion"), url.origin);
    redirect.searchParams.set("notion", "error");
  }
  return NextResponse.redirect(redirect);
}
