"use server";

import { revalidatePath } from "next/cache";
import { asActionResult, UserFacingError, type ActionResult } from "@/lib/errors";
import { parseTargetInput, type ParsedTarget } from "@/lib/leads/target-input";
import type { WarmPathLookup } from "@/lib/leads/warm-path";
import { findWarmPaths } from "@/lib/leads/warm-path-query";
import { requireLeadsUser } from "@/lib/plan-guards";
import {
  eligibleTeamForUser,
  getViewerTeam,
  joinTeam,
  leaveTeam,
  listTeamMembers,
  setContactTeamShared,
  setTeamSharing,
  type TeamEligibility,
  type TeamMemberRow,
} from "@/lib/teams";

/*
 * Every action starts with `requireLeadsUser()`: Server Functions answer a direct POST, so
 * this — not the nav — is the boundary, and while Leads is coming soon it refuses everyone.
 * `UserFacingError`s come back as data through `asActionResult`; a throw would digest.
 */

type JoinTeamInput = { shareNetwork: boolean };
type JoinTeamResult = { teamId: string; memberCount: number };
type LeaveTeamResult = { left: true };
type TeamSharingResult = { enabled: boolean };
type ContactTeamSharedResult = { shared: boolean };
type WarmLeadLookupResult = { parsed: ParsedTarget; lookup: WarmPathLookup };

export async function getTeamEligibility(): Promise<TeamEligibility> {
  const userId = await requireLeadsUser();
  return eligibleTeamForUser(userId);
}

export async function joinTeamAction(input: JoinTeamInput): Promise<ActionResult<JoinTeamResult>> {
  const userId = await requireLeadsUser();
  return asActionResult(async () => {
    const joined = await joinTeam(userId, { shareNetwork: input.shareNetwork === true });
    revalidatePath("/leads");
    return joined;
  });
}

export async function leaveTeamAction(): Promise<ActionResult<LeaveTeamResult>> {
  const userId = await requireLeadsUser();
  return asActionResult(async () => {
    await leaveTeam(userId);
    revalidatePath("/leads");
    return { left: true as const };
  });
}

export async function setTeamSharingAction(on: boolean): Promise<ActionResult<TeamSharingResult>> {
  const userId = await requireLeadsUser();
  return asActionResult(async () => {
    const changed = await setTeamSharing(userId, on === true);
    if (!changed) throw new UserFacingError("Join your team first.");
    revalidatePath("/leads");
    return { enabled: on === true };
  });
}

export async function setContactTeamSharedAction(contactId: string, shared: boolean): Promise<ActionResult<ContactTeamSharedResult>> {
  const userId = await requireLeadsUser();
  return asActionResult(async () => {
    const changed = await setContactTeamShared(userId, String(contactId), shared === true);
    if (!changed) throw new UserFacingError("That contact isn't yours to change.");
    revalidatePath(`/contacts/${contactId}`);
    revalidatePath("/leads");
    return { shared: shared === true };
  });
}

export async function listTeamMembersAction(): Promise<TeamMemberRow[]> {
  const userId = await requireLeadsUser();
  const membership = await getViewerTeam(userId);
  return membership ? listTeamMembers(membership.teamId) : [];
}

export async function lookupWarmLead(raw: string): Promise<WarmLeadLookupResult> {
  const userId = await requireLeadsUser();
  const parsed = parseTargetInput(String(raw ?? "").slice(0, 300));
  const lookup = await findWarmPaths(userId, parsed);
  return { parsed, lookup };
}
