"use server";

/**
 * The companies and schools the user is aiming at.
 *
 * Separate from `src/actions/events.ts` because these are not about an event: they are
 * standing facts about the user that the event surfaces READ. Keeping them here is what lets
 * the settings page own them without importing the events surface's auth rules.
 */
import { revalidatePath } from "next/cache";
import { requireUserId } from "@/lib/auth";
import {
  addTargetCompany,
  listSchools,
  listTargetCompanies,
  removeTargetCompany,
  setSchools,
  type TargetCompanyRow,
  type TargetPriority,
} from "@/lib/events/target-companies";

export async function getTargetCompanies(): Promise<TargetCompanyRow[]> {
  const userId = await requireUserId();
  return listTargetCompanies(userId);
}

export async function getSchools(): Promise<string[]> {
  const userId = await requireUserId();
  return listSchools(userId);
}

export async function saveTargetCompany(
  name: string,
  priority: TargetPriority = 2
): Promise<{ ok: boolean; error?: string }> {
  const userId = await requireUserId();
  const result = await addTargetCompany(userId, name, priority);
  revalidatePath("/settings");
  // The events surface ranks on this, so a change there has to be visible immediately.
  revalidatePath("/events");
  return result;
}

export async function deleteTargetCompany(id: string): Promise<void> {
  const userId = await requireUserId();
  await removeTargetCompany(userId, id);
  revalidatePath("/settings");
  revalidatePath("/events");
}

export async function saveSchools(schools: string[]): Promise<void> {
  const userId = await requireUserId();
  await setSchools(userId, schools);
  revalidatePath("/settings");
  revalidatePath("/events");
}
