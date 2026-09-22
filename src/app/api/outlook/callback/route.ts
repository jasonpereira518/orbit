import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { consumeOutlookOAuthState } from "@/actions/outlook";
import {
  exchangeCodeForTokens,
  fetchMicrosoftProfileEmail,
  upsertOutlookConnection,
} from "@/lib/outlook";
import { isDemoMode } from "@/lib/auth";
import { missingMicrosoftPurposes, serializeMicrosoftPurposes } from "@/lib/microsoft-scopes";
import { ERROR_SOURCES, recordErrorEvent } from "@/lib/error-events";

/** Keeps `error_events.kind` low-cardinality so the admin console can group on it. */
function classifyOAuthFailure(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/authorization code/i.test(message)) return "missing_code";
  if (/OAuth state|does not match/i.test(message)) return "state_mismatch";
  if (/Token exchange/i.test(message)) return "token_exchange_failed";
  if (/profile|no email/i.test(message)) return "profile_fetch_failed";
  return "other";
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  let redirectBase = new URL("/imports", url.origin);

  if (error) {
    // Every failure below is otherwise invisible: the reason is handed to the browser in
    // a query param and nothing is persisted, so a user repeatedly failing to connect
    // leaves no server-side trace at all.
    await recordErrorEvent({
      source: ERROR_SOURCES.oauthOutlookCallback,
      kind: "provider_denied",
      message: error,
    });
    // A cancelled consent still carries the state, so honour its returnTo too — otherwise
    // "Cancel" on Microsoft's screen ignored where the user started from. Best-effort: a
    // bad or missing state just keeps the default.
    try {
      const { returnTo, purposes } = await consumeOutlookOAuthState(state);
      const [purpose] = purposes;
      if (returnTo) redirectBase = new URL(returnTo, url.origin);
      if (purpose) redirectBase.searchParams.set("purpose", purpose);
    } catch {
      // keep the default destination
    }
    redirectBase.searchParams.set("outlook", "error");
    redirectBase.searchParams.set("reason", error);
    return NextResponse.redirect(redirectBase);
  }

  try {
    if (!code) throw new Error("Missing authorization code");

    const { userId: stateUserId, returnTo, purposes } = await consumeOutlookOAuthState(state);
    if (returnTo) redirectBase = new URL(returnTo, url.origin);
    if (purposes.length > 0) redirectBase.searchParams.set("purpose", purposes[0]);

    let sessionUserId: string | null = null;
    if (isDemoMode()) {
      sessionUserId = "demo-user";
    } else {
      const session = await auth();
      sessionUserId = session.userId;
    }

    if (!sessionUserId || sessionUserId !== stateUserId) {
      throw new Error("Signed-in user does not match OAuth state");
    }

    const tokens = await exchangeCodeForTokens(code);
    const email = await fetchMicrosoftProfileEmail(tokens.access_token);
    const { row: connection, switchedFrom } = await upsertOutlookConnection(sessionUserId, tokens, email);

    // Consent can finish without every scope this entry point asked for (a work or school
    // tenant's policy, or an admin-consent requirement). Only a grant that covers none of
    // what was asked is a failed connect; a partial one is connected, and the feature whose
    // scope is missing offers its own Allow button on the account page.
    const missing = missingMicrosoftPurposes(purposes, connection?.scopes);
    if (purposes.length > 0 && missing.length === purposes.length) {
      await recordErrorEvent({
        source: ERROR_SOURCES.oauthOutlookCallback,
        kind: "missing_scope",
        message: serializeMicrosoftPurposes(missing),
      });
      redirectBase.searchParams.set("purpose", missing[0]);
      redirectBase.searchParams.set("outlook", "error");
      redirectBase.searchParams.set("reason", "missing_scope");
      return NextResponse.redirect(redirectBase);
    }

    redirectBase.searchParams.set("outlook", "connected");
    if (switchedFrom) redirectBase.searchParams.set("switched", "1");
    return NextResponse.redirect(redirectBase);
  } catch (err) {
    await recordErrorEvent({
      source: ERROR_SOURCES.oauthOutlookCallback,
      kind: classifyOAuthFailure(err),
      message: err,
    });
    redirectBase.searchParams.set("outlook", "error");
    redirectBase.searchParams.set(
      "reason",
      // A code, not the message. The full error is already in recordErrorEvent above;
      // in the URL it only leaked token-endpoint bodies into a toast, browser history
      // and access logs.
      "oauth_failed"
    );
    return NextResponse.redirect(redirectBase);
  }
}
