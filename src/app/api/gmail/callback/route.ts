import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { consumeGmailOAuthState } from "@/actions/gmail";
import {
  exchangeCodeForTokens,
  fetchGoogleProfileEmail,
  upsertGmailConnection,
} from "@/lib/gmail";
import { isDemoMode } from "@/lib/auth";
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

  // returnTo (if present in state) lets Contacts-initiated connects land back
  // on /imports instead of the default /recruiters destination.
  let redirectBase = new URL("/recruiters", url.origin);

  if (error) {
    // Every failure below is otherwise invisible: the reason is handed to the browser in
    // a query param and nothing is persisted, so a user repeatedly failing to connect
    // leaves no server-side trace at all.
    await recordErrorEvent({
      source: ERROR_SOURCES.oauthGmailCallback,
      kind: "provider_denied",
      message: error,
    });
    redirectBase.searchParams.set("gmail", "error");
    redirectBase.searchParams.set("google", "error");
    redirectBase.searchParams.set("reason", error);
    return NextResponse.redirect(redirectBase);
  }

  try {
    if (!code) throw new Error("Missing authorization code");

    const { userId: stateUserId, returnTo } = await consumeGmailOAuthState(state);
    if (returnTo) redirectBase = new URL(returnTo, url.origin);

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
    const email = await fetchGoogleProfileEmail(tokens.access_token);
    await upsertGmailConnection(sessionUserId, tokens, email);

    redirectBase.searchParams.set("gmail", "connected");
    redirectBase.searchParams.set("google", "connected");
    return NextResponse.redirect(redirectBase);
  } catch (err) {
    await recordErrorEvent({
      source: ERROR_SOURCES.oauthGmailCallback,
      kind: classifyOAuthFailure(err),
      message: err,
    });
    redirectBase.searchParams.set("gmail", "error");
    redirectBase.searchParams.set("google", "error");
    redirectBase.searchParams.set(
      "reason",
      err instanceof Error ? err.message : "oauth_failed"
    );
    return NextResponse.redirect(redirectBase);
  }
}
