import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { isDemoMode } from "@/lib/auth";
import { ERROR_SOURCES, recordErrorEvent } from "@/lib/error-events";
import { consumeEventbriteOAuthState } from "@/actions/events";
import {
  exchangeEventbriteCode,
} from "@/lib/events/connectors/eventbrite-oauth";
import { listOrganizations } from "@/lib/events/connectors/eventbrite";
import { upsertEventConnection } from "@/lib/events/connections";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Keeps `error_events.kind` low-cardinality so the admin console can group on it. */
function classifyOAuthFailure(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/authorization code/i.test(message)) return "missing_code";
  if (/OAuth state|does not match/i.test(message)) return "state_mismatch";
  if (/Token exchange/i.test(message)) return "token_exchange_failed";
  if (/organization/i.test(message)) return "no_organization";
  return "other";
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const denied = url.searchParams.get("error");
  const redirect = new URL("/events", url.origin);

  if (denied) {
    // Otherwise invisible: the reason goes to the browser in a query param and nothing is
    // persisted, so a user repeatedly failing to connect leaves no server-side trace.
    await recordErrorEvent({
      source: ERROR_SOURCES.oauthEventbriteCallback,
      kind: "provider_denied",
      message: denied,
    });
    redirect.searchParams.set("eventbrite", "error");
    redirect.searchParams.set("reason", denied);
    return NextResponse.redirect(redirect);
  }

  try {
    if (!code) throw new Error("Missing authorization code");

    const stateUserId = await consumeEventbriteOAuthState(state);
    const sessionUserId = isDemoMode() ? "demo-user" : (await auth()).userId;
    // Both halves matter: a valid state proves the flow started here, and matching it to the
    // live session proves it started in THIS browser as THIS user.
    if (!sessionUserId || sessionUserId !== stateUserId) {
      throw new Error("Signed-in user does not match OAuth state");
    }

    const token = await exchangeEventbriteCode(code);
    // The token is scoped to organisations, and attendee lists hang off them — a connection
    // without one can authenticate but can never list an event, so refuse it here rather
    // than storing something that silently syncs nothing.
    const organizations = await listOrganizations(token);
    const organization = organizations[0];
    if (!organization) {
      throw new Error("That Eventbrite account has no organization to sync.");
    }

    await upsertEventConnection(sessionUserId, {
      provider: "eventbrite",
      authKind: "oauth",
      secret: token,
      label: organization.name,
      accountRef: organization.id,
    });

    redirect.searchParams.set("eventbrite", "connected");
    return NextResponse.redirect(redirect);
  } catch (err) {
    await recordErrorEvent({
      source: ERROR_SOURCES.oauthEventbriteCallback,
      kind: classifyOAuthFailure(err),
      message: err,
    });
    redirect.searchParams.set("eventbrite", "error");
    redirect.searchParams.set(
      "reason",
      err instanceof Error ? err.message : "oauth_failed"
    );
    return NextResponse.redirect(redirect);
  }
}
