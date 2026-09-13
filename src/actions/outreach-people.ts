"use server";

import { revalidatePath } from "next/cache";
import { asActionResult, type ActionResult } from "@/lib/errors";
import { getCreditBalance } from "@/lib/outreach/credits/ledger";
import { cancelDiscoveryRun, getLatestRun, startDiscoveryRun, type RunSummary } from "@/lib/outreach/discovery/run";
import { requireOutreachNextUser } from "@/lib/outreach/gate";
import { kickOutreachWorker } from "@/lib/outreach/jobs/kick";
import { setFundingPreference } from "@/lib/outreach/keys";
import {
  excludePeople,
  listPeople,
  researchOnePerson,
  resolveDuplicate,
  restorePeople,
  selectPeople,
  type PeopleCounts,
  type PeopleFilter,
  type PersonRow,
} from "@/lib/outreach/people";
import type { OutreachFundingSource } from "@/lib/outreach/types";

export async function startRunAction(input: {
  campaignId: string;
  funding: OutreachFundingSource;
  researchBudget: number;
}): Promise<ActionResult<{ runId: string; researchBudget: number; demo: boolean }>> {
  return asActionResult(async () => {
    const userId = await requireOutreachNextUser();
    const result = await startDiscoveryRun(userId, input);
    await setFundingPreference(userId, input.funding);
    kickOutreachWorker();
    revalidatePath(`/outreach/${input.campaignId}/people`);
    return result;
  });
}

export async function cancelRunAction(campaignId: string, runId: string): Promise<ActionResult<{ cancelled: boolean }>> {
  return asActionResult(async () => {
    const userId = await requireOutreachNextUser();
    const cancelled = await cancelDiscoveryRun(userId, runId);
    revalidatePath(`/outreach/${campaignId}/people`);
    return { cancelled };
  });
}

export async function getRunAction(campaignId: string): Promise<RunSummary | null> {
  const userId = await requireOutreachNextUser();
  return getLatestRun(userId, campaignId);
}

export async function listPeopleAction(input: {
  campaignId: string;
  filter?: PeopleFilter;
  offset?: number;
  limit?: number;
}): Promise<{ rows: PersonRow[]; nextOffset: number | null; total: number; counts: PeopleCounts; criteriaVersion: number }> {
  const userId = await requireOutreachNextUser();
  return listPeople(userId, input.campaignId, input);
}

export async function selectPeopleAction(
  campaignId: string,
  input:
    | { scope: "ids"; ids: string[]; selected: boolean }
    | { scope: "filter"; filter: PeopleFilter; exceptIds: string[]; selected: boolean }
): Promise<ActionResult<{ changed: number }>> {
  return asActionResult(async () => {
    const userId = await requireOutreachNextUser();
    return selectPeople(userId, campaignId, input);
  });
}

export async function excludePeopleAction(campaignId: string, ids: string[], reason: string | null): Promise<ActionResult<{ changed: number }>> {
  return asActionResult(async () => {
    const userId = await requireOutreachNextUser();
    return excludePeople(userId, campaignId, ids, reason);
  });
}

export async function restorePeopleAction(campaignId: string, ids: string[]): Promise<ActionResult<{ changed: number }>> {
  return asActionResult(async () => {
    const userId = await requireOutreachNextUser();
    return restorePeople(userId, campaignId, ids);
  });
}

export async function resolveDuplicateAction(prospectId: string, decision: "distinct" | "merged"): Promise<ActionResult<null>> {
  return asActionResult(async () => {
    const userId = await requireOutreachNextUser();
    await resolveDuplicate(userId, prospectId, decision);
    return null;
  });
}

export async function researchPersonAction(prospectId: string, funding: OutreachFundingSource): Promise<ActionResult<{ attemptId: string }>> {
  return asActionResult(async () => {
    const userId = await requireOutreachNextUser();
    const result = await researchOnePerson(userId, prospectId, funding);
    kickOutreachWorker();
    return result;
  });
}

export async function getCreditsAction(): Promise<{ total: number; monthlyAvailable: number; lifetimeAvailable: number; periodEnd: string }> {
  const userId = await requireOutreachNextUser();
  const balance = await getCreditBalance(userId);
  return {
    total: balance.total,
    monthlyAvailable: balance.monthlyAvailable,
    lifetimeAvailable: balance.lifetimeAvailable,
    periodEnd: balance.periodEnd.toISOString(),
  };
}
