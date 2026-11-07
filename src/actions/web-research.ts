"use server";

import { revalidatePath } from "next/cache";
import { requireUserId } from "@/lib/auth";
import { asActionResult, UserFacingError } from "@/lib/errors";
import { loadPeopleToMeet, type PersonToMeet } from "@/lib/people-to-meet";
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

/**
 * The dashboard's "People to meet" (at most 2), loaded client-side after the page renders: a
 * weekly web search can take 20s. `[]` whenever the card should stay empty — the gates live
 * in `loadPeopleToMeet`, not here, because this card is free on every plan.
 */
export async function getPeopleToMeet(): Promise<PersonToMeet[]> {
  return loadPeopleToMeet(await requireUserId());
}
