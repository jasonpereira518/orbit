"use server";

import { revalidatePath } from "next/cache";
import { isCrmConnectorId, crmAuthorizeUrl } from "@/lib/crm/connect";
import { crmStatusFor, disconnectCrm, runCrmSyncNow } from "@/lib/crm/manage";
import type { CrmStatus, CrmSyncNowResult } from "@/lib/crm/types";
import { isOAuthConfigured } from "@/lib/connectors/oauth";
import { isPaywallError, requireEntitlement } from "@/lib/entitlements";
import { asActionResult, UserFacingError, type ActionResult } from "@/lib/errors";
import { requireLeadsUser } from "@/lib/plan-guards";

/*
 * Every action starts with `requireLeadsUser()`: while Leads is coming soon this refuses
 * everyone, a direct POST included. Connecting and syncing are the paid half and check the
 * `crm` entitlement inside `asActionResult`, so the refusal reaches the person as words;
 * disconnecting never checks the plan.
 */

type ConnectStart = { url: string };
type Disconnected = { disconnected: true };

const NOT_AVAILABLE = "That CRM isn’t available yet";
const UPGRADE = "HubSpot sync is on Orbit Pro and Lifetime — upgrade to connect it";

async function requireCrm(userId: string): Promise<void> {
  try {
    await requireEntitlement(userId, "crm");
  } catch (err) {
    if (isPaywallError(err)) throw new UserFacingError(UPGRADE);
    throw err;
  }
}

export async function loadCrmStatusAction(): Promise<CrmStatus> {
  const userId = await requireLeadsUser();
  return crmStatusFor(userId);
}

export async function startCrmConnectAction(connectorId: string): Promise<ActionResult<ConnectStart>> {
  const userId = await requireLeadsUser();
  return asActionResult(async () => {
    await requireCrm(userId);
    if (!isCrmConnectorId(connectorId)) throw new UserFacingError(NOT_AVAILABLE);
    if (!isOAuthConfigured(connectorId)) throw new UserFacingError("HubSpot isn’t set up on this server yet");
    return { url: crmAuthorizeUrl(userId, connectorId, "/leads") };
  });
}

export async function syncCrmNowAction(connectorId: string): Promise<ActionResult<CrmSyncNowResult>> {
  const userId = await requireLeadsUser();
  return asActionResult(async () => {
    await requireCrm(userId);
    if (!isCrmConnectorId(connectorId)) throw new UserFacingError(NOT_AVAILABLE);
    const result = await runCrmSyncNow(userId, connectorId);
    revalidatePath("/leads");
    revalidatePath("/contacts");
    return result;
  });
}

export async function disconnectCrmAction(connectorId: string): Promise<ActionResult<Disconnected>> {
  const userId = await requireLeadsUser();
  return asActionResult(async () => {
    if (!isCrmConnectorId(connectorId)) throw new UserFacingError(NOT_AVAILABLE);
    await disconnectCrm(userId, connectorId);
    revalidatePath("/leads");
    revalidatePath("/contacts");
    return { disconnected: true as const };
  });
}
