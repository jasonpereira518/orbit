import { after, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { isDemoMode } from "@/lib/auth";
import { ERROR_SOURCES, recordErrorEvent } from "@/lib/error-events";
import { consumeGranolaFlow } from "@/actions/granola";
import { finishGranolaAuthorization, GRANOLA_AUTO_CAPABILITY } from "@/lib/connectors/granola";
import { getConnectorConnection, loadConnectorConnection, upsertConnectorConnection } from "@/lib/connectors/connections";
import { kickSyncPass } from "@/lib/sync-kick";
import { integrationHref } from "@/components/settings/sections";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const denied = url.searchParams.get("error");
  let redirect = new URL(integrationHref("granola"), url.origin);

  try {
    // Consumed first, on every path, so a cancelled consent can't leave it replayable.
    const flow = await consumeGranolaFlow(state);
    if (denied) throw new Error(`provider_denied: ${denied}`);
    if (!code) throw new Error("Missing authorization code");
    const sessionUserId = isDemoMode() ? "demo-user" : (await auth()).userId;
    // The cookie proves the flow started in this browser; the session proves it is still
    // the same person signed in.
    if (!sessionUserId || sessionUserId !== flow.userId) throw new Error("Signed-in user does not match OAuth state");

    // A reconnect keeps the person's choices: auto-extract off stays off, folders stay picked.
    const previous = await getConnectorConnection(sessionUserId, "granola");
    const previousCursor = previous ? (await loadConnectorConnection(previous.id))?.cursor : null;

    const grant = await finishGranolaAuthorization({
      code,
      codeVerifier: flow.codeVerifier,
      clientId: flow.clientId,
      redirectUri: flow.redirectUri,
    });
    await upsertConnectorConnection({
      userId: sessionUserId,
      connectorId: "granola",
      authKind: "oauth2",
      label: "Granola",
      accountRef: grant.email,
      accessToken: grant.accessToken,
      refreshToken: grant.refreshToken,
      tokenExpiresAt: grant.tokenExpiresAt,
      capabilities: previous?.capabilities ?? [GRANOLA_AUTO_CAPABILITY],
      // A reconnect starts a fresh 30-day look-back; notes already logged are skipped.
      syncCursor: { clientId: flow.clientId, folderIds: previousCursor?.folderIds ?? null },
    });
    after(() => kickSyncPass());
    // Back where the connect started (Capture reopens its Granola picker), else Settings.
    if (flow.returnTo) redirect = new URL(flow.returnTo, url.origin);
    else redirect.searchParams.set("granola", "connected");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordErrorEvent({
      source: ERROR_SOURCES.oauthGranolaCallback,
      kind: message.startsWith("provider_denied") ? "provider_denied" : /state/i.test(message) ? "state_mismatch" : "other",
      message: err,
    });
    // Failures land on the Granola settings page, which says so and offers to try again.
    redirect = new URL(integrationHref("granola"), url.origin);
    redirect.searchParams.set("granola", "error");
  }
  return NextResponse.redirect(redirect);
}
