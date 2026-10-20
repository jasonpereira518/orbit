"use server";

/**
 * The companies and schools the user is aiming at.
 *
 * Separate from `src/actions/events.ts` because these are not about an event: they are
 * standing facts about the user that the event surfaces READ. Keeping them here is what lets
 * the settings page own them without importing the events surface's auth rules.
 */
import { revalidatePath } from "next/cache";
import {
  addTargetCompany,
  listSchools,
  listTargetCompanies,
  removeTargetCompany,
  setSchools,
  type TargetCompanyRow,
  type TargetPriority,
} from "@/lib/events/target-companies";
import { z } from "zod";
import { defineAction, failResult } from "@/lib/input/action";

export const getTargetCompanies = defineAction(
  {},
  async (userId): Promise<TargetCompanyRow[]> => {
    return listTargetCompanies(userId);
  }
);

export const getSchools = defineAction(
  {},
  async (userId): Promise<string[]> => {
    return listSchools(userId);
  }
);

export const saveTargetCompany = defineAction(
  { schema: z.tuple([z.string(), z.union([z.literal(1), z.literal(2), z.literal(3)]).optional()]), invalid: failResult },
  async (userId, name: string, priority: TargetPriority = 2): Promise<{ ok: boolean; error?: string }> => {
    const result = await addTargetCompany(userId, name, priority);
    revalidatePath("/settings");
    // The events surface ranks on this, so a change there has to be visible immediately.
    revalidatePath("/events");
    return result;
  }
);

export const deleteTargetCompany = defineAction(
  { schema: z.tuple([z.string()]) },
  async (userId, id: string): Promise<void> => {
    await removeTargetCompany(userId, id);
    revalidatePath("/settings");
    revalidatePath("/events");
  }
);

export const saveSchools = defineAction(
  { schema: z.tuple([z.array(z.string())]) },
  async (userId, schools: string[]): Promise<void> => {
    await setSchools(userId, schools);
    revalidatePath("/settings");
    revalidatePath("/events");
  }
);
