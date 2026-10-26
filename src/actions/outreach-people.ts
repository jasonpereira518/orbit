"use server";

import { revalidatePath } from "next/cache";
import { asActionResult } from "@/lib/errors";
import { requireOutreachUser } from "@/lib/plan-guards";
import {
  addProspectsForUser,
  attachBriefForUser,
  removeProspectForUser,
  setProspectEmailForUser,
  skipCandidateForUser,
} from "@/lib/outreach-people";
import { findWarmPaths } from "@/lib/warm-paths-server";
import { orgKeysFor, type WarmPath } from "@/lib/warm-paths";

const MAX_WARM_PATH_COMPANIES = 20;

function revalidateCampaign(campaignId: string) {
  revalidatePath(`/outreach/${campaignId}`);
}

export async function addProspects(campaignId: string, people: unknown[]) {
  return asActionResult(async () => {
    const userId = await requireOutreachUser();
    const result = await addProspectsForUser(userId, campaignId, people);
    revalidateCampaign(campaignId);
    return result;
  });
}

export async function skipCandidate(campaignId: string, person: unknown) {
  return asActionResult(async () => {
    const userId = await requireOutreachUser();
    await skipCandidateForUser(userId, campaignId, person);
    revalidateCampaign(campaignId);
  });
}

export async function removeProspect(prospectId: string) {
  return asActionResult(async () => {
    const userId = await requireOutreachUser();
    revalidateCampaign(await removeProspectForUser(userId, prospectId));
  });
}

export async function setProspectEmail(prospectId: string, email: string | null) {
  return asActionResult(async () => {
    const userId = await requireOutreachUser();
    revalidateCampaign(await setProspectEmailForUser(userId, prospectId, email));
  });
}

export async function attachBrief(prospectId: string, researchKey: string) {
  return asActionResult(async () => {
    const userId = await requireOutreachUser();
    revalidateCampaign(await attachBriefForUser(userId, prospectId, researchKey));
  });
}

/** Who in the user's network connects to each company, keyed by the normalised company name. */
export async function warmPathsForCompanies(companies: string[]) {
  return asActionResult(async (): Promise<Record<string, WarmPath[]>> => {
    const userId = await requireOutreachUser();
    const names = Array.isArray(companies) ? companies.filter((c) => typeof c === "string") : [];
    const paths = await findWarmPaths(userId, orgKeysFor(names.slice(0, MAX_WARM_PATH_COMPANIES)));
    return Object.fromEntries(paths);
  });
}
