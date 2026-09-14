"use server";

import { revalidatePath } from "next/cache";
import { requireUserId } from "@/lib/auth";
import { asActionResult, type ActionResult } from "@/lib/errors";
import { requireOutreachNextUser } from "@/lib/outreach/gate";
import { clearBraveKey, saveBraveKey, verifySavedApolloKey } from "@/lib/outreach/keys";
import { loadResearchSettings, type ResearchSettings } from "@/lib/outreach/settings";

export type { ResearchSettings } from "@/lib/outreach/settings";

/** Read-only; `{ enabled: false }` for anyone who couldn't use the section, so Settings omits it. */
export async function getResearchSettings(): Promise<ResearchSettings> {
  const userId = await requireUserId();
  return loadResearchSettings(userId);
}

export async function saveBraveKeyAction(key: string): Promise<ActionResult<{ status: "valid" | "unverified" }>> {
  return asActionResult(async () => {
    const userId = await requireOutreachNextUser();
    const result = await saveBraveKey(userId, key);
    revalidatePath("/settings");
    return result;
  });
}

export async function clearBraveKeyAction(): Promise<ActionResult<null>> {
  return asActionResult(async () => {
    const userId = await requireOutreachNextUser();
    await clearBraveKey(userId);
    revalidatePath("/settings");
    return null;
  });
}

export async function verifyApolloKeyAction(): Promise<
  ActionResult<{ status: "valid" | "invalid" | "unverified" | "missing" }>
> {
  return asActionResult(async () => {
    const userId = await requireOutreachNextUser();
    return { status: await verifySavedApolloKey(userId) };
  });
}
