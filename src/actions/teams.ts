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

// Same pattern as `isUuid` in `src/lib/chat-send.ts:20`, copied rather than imported: that
// module pulls in `outreach-quality` and `chat-draft`, unrelated to a team action's bundle.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

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
    // A Server Function answers a direct POST, so `input` is whatever the caller sent, not
    // necessarily the typed shape — `input?.` rather than `input.` so a missing or malformed
    // body is "sharing off" instead of a thrown TypeError.
    const joined = await joinTeam(userId, { shareNetwork: input?.shareNetwork === true });
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
    if (!changed) throw new UserFacingError("Join your team first");
    revalidatePath("/leads");
    return { enabled: on === true };
  });
}

export async function setContactTeamSharedAction(contactId: string, shared: boolean): Promise<ActionResult<ContactTeamSharedResult>> {
  const userId = await requireLeadsUser();
  return asActionResult(async () => {
    // A forged `contactId` (not even a UUID) must not reach the DB or `revalidatePath`
    // before it is refused — same message either way, so a caller can't use it to probe
    // which ids exist.
    if (!isUuid(contactId)) throw new UserFacingError("That contact isn’t yours to change");
    const changed = await setContactTeamShared(userId, contactId, shared === true);
    if (!changed) throw new UserFacingError("That contact isn’t yours to change");
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
