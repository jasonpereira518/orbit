"use server";

/**
 * Work history on one contact's page, and after the contact form saves a LinkedIn URL.
 *
 * Every export here must be async — one non-async export in a `"use server"` file kills
 * every export in it, and `tsc` will not tell you.
 */

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { requireUserId } from "@/lib/auth";
import { kickEmbeddingBackfill } from "@/lib/embedding-backfill";
import { generateAndStoreContactBrief } from "@/lib/contact-brief";
import {
  kickWorkHistoryResearch,
  researchContactWorkHistory,
  type WorkHistoryOutcome,
} from "@/lib/work-history-research";

/**
 * "Find work history" on a contact's Experience section: one web search, waited on, so the
 * section can say what happened. `force` because the person asked — a recent search is not
 * a reason to refuse a second one they clicked for.
 */
export async function findContactWorkHistory(
  contactId: string
): Promise<{ outcome: WorkHistoryOutcome }> {
  const userId = await requireUserId();
  const outcome = await researchContactWorkHistory(userId, contactId, { force: true });
  if (outcome === "saved") {
    after(async () => {
      await kickEmbeddingBackfill(userId).catch(() => null);
      await generateAndStoreContactBrief(userId, contactId).catch(() => null);
    });
    revalidatePath(`/contacts/${contactId}`);
  }
  return { outcome };
}

/**
 * Queue a web search for a contact the form just saved with a LinkedIn URL. Returns at
 * once — the search runs in its own function and lands on the profile when it is done.
 * The route re-reads the contact under this user, so a foreign id finds nothing.
 */
export async function queueContactWorkHistory(contactId: string): Promise<void> {
  const userId = await requireUserId();
  await kickWorkHistoryResearch(userId, [contactId]);
}
