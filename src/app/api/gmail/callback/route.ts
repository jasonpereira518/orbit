import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { consumeGmailOAuthState } from "@/actions/gmail";
import {
  exchangeCodeForTokens,
  fetchGoogleProfileEmail,
  upsertGmailConnection,
} from "@/lib/gmail";
import { isDemoMode } from "@/lib/auth";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  const redirectBase = new URL("/recruiters", url.origin);

  if (error) {
    redirectBase.searchParams.set("gmail", "error");
    redirectBase.searchParams.set("reason", error);
    return NextResponse.redirect(redirectBase);
  }

  try {
    if (!code) throw new Error("Missing authorization code");

    const stateUserId = await consumeGmailOAuthState(state);
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
    return NextResponse.redirect(redirectBase);
  } catch (err) {
    redirectBase.searchParams.set("gmail", "error");
    redirectBase.searchParams.set(
      "reason",
      err instanceof Error ? err.message : "oauth_failed"
    );
    return NextResponse.redirect(redirectBase);
  }
}
