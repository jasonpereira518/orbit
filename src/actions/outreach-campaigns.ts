"use server";

import { revalidatePath } from "next/cache";
import { completeJson } from "@/lib/ai";
import { asActionResult, type ActionResult } from "@/lib/errors";
import { createCampaignV2, saveCriteria, suggestCriteria, updateCampaignBrief } from "@/lib/outreach/campaigns";
import { requireOutreachNextUser } from "@/lib/outreach/gate";
import { kickOutreachWorker } from "@/lib/outreach/jobs/kick";
import type { OutreachChannel, OutreachCriteria } from "@/lib/outreach/types";

export async function createCampaignAction(input: {
  name?: string;
  purpose: string;
  desiredOutcome: string;
  notes?: string;
  channel: OutreachChannel;
  senderIntro?: string;
  saveIntroAsDefault?: boolean;
}): Promise<ActionResult<{ id: string }>> {
  return asActionResult(async () => {
    const userId = await requireOutreachNextUser();
    const result = await createCampaignV2(userId, {
      name: input.name,
      brief: { purpose: input.purpose, desiredOutcome: input.desiredOutcome, notes: input.notes || undefined },
      channel: input.channel,
      senderIntro: input.senderIntro,
      saveIntroAsDefault: input.saveIntroAsDefault,
    });
    revalidatePath("/outreach");
    return result;
  });
}

export async function updateBriefAction(
  campaignId: string,
  input: { name?: string; purpose: string; desiredOutcome: string; notes?: string; senderIntro?: string }
): Promise<ActionResult<null>> {
  return asActionResult(async () => {
    const userId = await requireOutreachNextUser();
    await updateCampaignBrief(userId, campaignId, {
      name: input.name,
      brief: { purpose: input.purpose, desiredOutcome: input.desiredOutcome, notes: input.notes || undefined },
      senderIntro: input.senderIntro,
    });
    revalidatePath(`/outreach/${campaignId}/audience`);
    return null;
  });
}

export async function suggestCriteriaAction(
  campaignId: string
): Promise<ActionResult<{ criteria: OutreachCriteria; source: "ai" | "fallback" }>> {
  return asActionResult(async () => {
    const userId = await requireOutreachNextUser();
    return suggestCriteria(userId, campaignId, completeJson);
  });
}

export async function saveCriteriaAction(
  campaignId: string,
  criteria: OutreachCriteria
): Promise<ActionResult<{ criteriaVersion: number; rerankQueued: boolean }>> {
  return asActionResult(async () => {
    const userId = await requireOutreachNextUser();
    const result = await saveCriteria(userId, campaignId, criteria);
    if (result.rerankQueued) kickOutreachWorker();
    revalidatePath(`/outreach/${campaignId}/audience`);
    revalidatePath(`/outreach/${campaignId}/people`);
    return result;
  });
}
