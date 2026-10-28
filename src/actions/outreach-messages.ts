"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUserProfile } from "@/lib/auth";
import { asActionResult } from "@/lib/errors";
import {
  confirmLinkedInSentForUser,
  copyLinkedInMessageForUser,
  draftCampaignMessagesForUser,
  draftFollowUpForUser,
  editDraftForUser,
  markMessageWentOutForUser,
  requireMessageForUser,
  sendCampaignMessagesForUser,
} from "@/lib/outreach-messages";
import { checkCampaignRepliesForUser } from "@/lib/outreach-replies";
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

/** Write the one follow-up for a person who hasn't answered a week after the first message. */
export async function draftFollowUp(messageId: string) {
  return asActionResult(async () => {
    const userId = await requireOutreachUser();
    const { campaign } = await requireMessageForUser(userId, messageId);
    const result = await draftFollowUpForUser(userId, messageId);
    revalidateCampaign(campaign.id);
    return result;
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

// The two LinkedIn steps return nothing to revalidate with, so they look up the campaign first
// (which is also the ownership check) and revalidate after the write.
export async function copyLinkedIn(messageId: string) {
  return asActionResult(async () => {
    const userId = await requireOutreachUser();
    const { campaign } = await requireMessageForUser(userId, messageId);
    const note = await copyLinkedInMessageForUser(userId, messageId);
    revalidateCampaign(campaign.id);
    return note;
  });
}

export async function confirmLinkedInSent(messageId: string) {
  return asActionResult(async () => {
    const userId = await requireOutreachUser();
    const { campaign } = await requireMessageForUser(userId, messageId);
    await confirmLinkedInSentForUser(userId, messageId);
    revalidateCampaign(campaign.id);
  });
}

/** The user found a may-have-sent email in their Sent folder: it went out. Sends nothing. */
export async function markWentOut(messageId: string) {
  return asActionResult(async () => {
    const userId = await requireOutreachUser();
    revalidateCampaign(await markMessageWentOutForUser(userId, messageId));
  });
}

/** Look in the user's own mailbox for replies to this campaign's emails (once per ten minutes). */
export async function checkReplies(campaignId: string) {
  return asActionResult(async () => {
    const userId = await requireOutreachUser();
    const result = await checkCampaignRepliesForUser(userId, campaignId);
    if (result.replied) revalidateCampaign(campaignId);
    return result;
  });
}
