"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { parseInput } from "@/lib/action";
import { UserFacingError } from "@/lib/errors";
import { requireRecruitersUser } from "@/lib/plan-guards";
import { RECRUITER_STAGES, type RecruiterStage } from "@/lib/recruiter-stages";
import { setCompanyHiddenForUser, setCompanyStageForUser } from "@/lib/recruiting-companies";

/**
 * Corrections to the Recruiting board. Each re-asserts the plan itself — a layout does not run
 * for an action POST — and takes the company by its key, never an id: the board has no rows of
 * its own to point at, only what the person's mail said.
 */

const companyKeySchema = z.string().min(1).max(120);
const stageInputSchema = z.object({ key: companyKeySchema, stage: z.enum(RECRUITER_STAGES) });
const hiddenInputSchema = z.object({ key: companyKeySchema, hidden: z.boolean() });

/** Set a company's stage by hand. Older mail can't move it; newer mail can. */
export async function setCompanyStage(key: string, stage: RecruiterStage): Promise<void> {
  const userId = await requireRecruitersUser("action.recruiting");
  const parsed = parseInput(stageInputSchema, { key, stage }, "recruiting.set-company-stage");
  if (!parsed.ok) throw new UserFacingError(parsed.error);
  await setCompanyStageForUser(userId, parsed.value.key, parsed.value.stage);
  revalidatePath("/recruiters");
}

/** "Not a job" (hidden) or "Put it back". New mail never undoes it. */
export async function setCompanyHidden(key: string, hidden: boolean): Promise<void> {
  const userId = await requireRecruitersUser("action.recruiting");
  const parsed = parseInput(hiddenInputSchema, { key, hidden }, "recruiting.set-company-hidden");
  if (!parsed.ok) throw new UserFacingError(parsed.error);
  await setCompanyHiddenForUser(userId, parsed.value.key, parsed.value.hidden);
  revalidatePath("/recruiters");
}
