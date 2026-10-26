"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUserProfile } from "@/lib/auth";
import { asActionResult } from "@/lib/errors";
import {
  draftCampaignMessagesForUser,
  editDraftForUser,
  sendCampaignMessagesForUser,
} from "@/lib/outreach-messages";
import { requireOutreachUser } from "@/lib/plan-guards";

function revalidateCampaign(campaignId: string) {
  revalidatePath(`/outreach/${campaignId}`);
}

export async function draftMessages(campaignId: string, prospectIds: string[]) {
  return asActionResult(async () => {
    const userId = await requireOutreachUser();
    const result = await draftCampaignMessagesForUser(userId, campaignId, Array.isArray(prospectIds) ? prospectIds : []);
    revalidateCampaign(campaignId);
    return result;
  });
}

export async function editDraft(messageId: string, input: { subject: string | null; body: string }) {
  return asActionResult(async () => {
    const userId = await requireOutreachUser();
    revalidateCampaign(await editDraftForUser(userId, messageId, input ?? { subject: null, body: "" }));
  });
}

export async function sendMessages(campaignId: string, messageIds: string[]) {
  return asActionResult(async () => {
    const userId = await requireOutreachUser();
    // Captured here: the outbox drain has no request to ask Clerk for the sender's name.
    const profile = await getCurrentUserProfile().catch(() => null);
    const result = await sendCampaignMessagesForUser(userId, campaignId, messageIds, {
      fromName: profile?.name?.trim() || null,
    });
    revalidateCampaign(campaignId);
    return result;
  });
}
