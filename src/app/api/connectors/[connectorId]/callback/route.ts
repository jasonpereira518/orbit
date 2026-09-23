import { NextResponse } from "next/server";
import { parseOAuthState } from "@/lib/connectors/oauth";
import { CrmConnectError, completeCrmConnect, isCrmConnectorId } from "@/lib/crm/connect";
import { isPaywallError } from "@/lib/entitlements";
import { ERROR_SOURCES, recordErrorEvent } from "@/lib/error-events";
import { requireCrmUser } from "@/lib/plan-guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ connectorId: string }> };

/** The codes the Leads page knows how to say. A code, never a message: URLs land in history and logs. */
type Reason = "access_denied" | "not_entitled" | "oauth_failed";

export async function GET(request: Request, { params }: Params) {
  // Next 16: route params are a Promise and must be awaited.
  const { connectorId } = await params;
  const url = new URL(request.url);
  const state = parseOAuthState(url.searchParams.get("state"));
  const back = new URL(state?.returnTo ?? "/leads", url.origin);

  async function fail(kind: string, reason: Reason, message?: unknown) {
    await recordErrorEvent({
      source: ERROR_SOURCES.oauthConnectorCallback,
      kind,
      message,
      context: { connectorId },
    });
    back.searchParams.set("crm", "error");
    back.searchParams.set("reason", reason);
    return NextResponse.redirect(back);
  }

  const denied = url.searchParams.get("error");
  if (denied) return fail("provider_denied", denied === "access_denied" ? "access_denied" : "oauth_failed", denied);
  if (!isCrmConnectorId(connectorId)) return fail("unknown_connector", "oauth_failed", connectorId);
  if (!state) return fail("state_invalid", "oauth_failed");
  const code = url.searchParams.get("code");
  if (!code) return fail("missing_code", "oauth_failed");

  let userId: string;
  try {
    // The same gate as every CRM action: signed in, Leads released for them, and paid.
    userId = await requireCrmUser();
  } catch (err) {
    return isPaywallError(err) ? fail("not_entitled", "not_entitled", err) : fail("not_allowed", "oauth_failed", err);
  }

  try {
    await completeCrmConnect({ sessionUserId: userId, connectorId, code, state });
  } catch (err) {
    return fail(err instanceof CrmConnectError ? err.kind : "other", "oauth_failed", err);
  }

  back.searchParams.set("crm", "connected");
  return NextResponse.redirect(back);
}
