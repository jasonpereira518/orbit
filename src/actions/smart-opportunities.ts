"use server";

/**
 * Server actions for Smart Opportunities: cross-network synthesis
 * drawing together notes & ideas from different people with user goals & progress.
 */
import { revalidatePath } from "next/cache";
import { type SmartOpportunity, type SmartOpportunityStatus } from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import {
  listSmartOpportunitiesForUser,
  synthesizeAndPersistSmartOpportunities,
  updateSmartOpportunityStatusForUser,
} from "@/lib/smart-opportunities-engine";
import { asActionResult } from "@/lib/errors";

function revalidateOpportunityPaths() {
  revalidatePath("/dashboard");
  revalidatePath("/contacts");
}

export async function listSmartOpportunities(options?: {
  status?: SmartOpportunityStatus;
  goalId?: string;
  contactId?: string;
  limit?: number;
}): Promise<SmartOpportunity[]> {
  const userId = await requireUserId();
  return listSmartOpportunitiesForUser(userId, options);
}

export async function generateSmartOpportunitiesAction(options?: { preferAi?: boolean }) {
  return asActionResult(async () => {
    const userId = await requireUserId();
    const result = await synthesizeAndPersistSmartOpportunities(userId, options);
    revalidateOpportunityPaths();
    return result;
  });
}

export async function setSmartOpportunityStatus(
  id: string,
  status: SmartOpportunityStatus
) {
  return asActionResult(async () => {
    const userId = await requireUserId();
    const updated = await updateSmartOpportunityStatusForUser(userId, id, status);
    revalidateOpportunityPaths();
    return updated;
  });
}

export async function dismissSmartOpportunity(id: string) {
  return setSmartOpportunityStatus(id, "dismissed");
}

export async function acceptSmartOpportunity(id: string) {
  return setSmartOpportunityStatus(id, "accepted");
}

export async function listSmartOpportunitiesForContact(contactId: string): Promise<SmartOpportunity[]> {
  const userId = await requireUserId();
  return listSmartOpportunitiesForUser(userId, { contactId });
}
