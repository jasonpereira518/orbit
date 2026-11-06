"use server";

import { revalidatePath } from "next/cache";
import { asActionResult, UserFacingError } from "@/lib/errors";
import { requireUserForReleasedSurface } from "@/lib/plan-guards";
import { saveResearchedPersonForUser } from "@/lib/web-research";

/** "Save to Orbit" on a /find brief. The work is `saveResearchedPersonForUser`. */
export async function saveResearchedPerson(key: string) {
  return asActionResult(async () => {
    const userId = await requireUserForReleasedSurface("page.find");
    const saved = await saveResearchedPersonForUser(userId, key);
    if (!saved) throw new UserFacingError("That brief has expired — search again to save them");
    if (saved.profileWritten) revalidatePath(`/contacts/${saved.contactId}`);
    return { contactId: saved.contactId, outcome: saved.outcome };
  });
}
