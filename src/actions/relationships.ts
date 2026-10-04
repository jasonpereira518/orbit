"use server";

import { revalidatePath } from "next/cache";
import { requireUserId } from "@/lib/auth";
import { RunStillActiveError, undoRelationshipRun } from "@/lib/relationship-engine/apply";
import { dismissOpenThread, dismissRunFlag, promoteOpenThread, promoteRunFlag, type PromoteOutcome } from "@/lib/relationship-engine/promote";
import { loadLatestRunSummary, type RunSummary } from "@/lib/relationship-engine/summary";
import { revalidateReminderPaths } from "@/lib/reminder-paths";

type Refusal = { error: string };

/** Typed, so `"error" in res` narrows on the client — see `refusal` in actions/imports.ts. */
function refusal(message: string): Refusal {
  return { error: message };
}

function promoteReply(made: PromoteOutcome, alreadyMade: string): { ok: true } | Refusal {
  if (!made) return refusal("That reminder is no longer available");
  return "alreadyMade" in made ? refusal(alreadyMade) : { ok: true };
}

export async function getLatestRelationshipRun(): Promise<RunSummary | null> {
  const userId = await requireUserId();
  return loadLatestRunSummary(userId);
}

export async function undoRelationshipRunAction(runId: string): Promise<{ remindersDismissed: number; actionItemsRemoved: number } | Refusal> {
  const userId = await requireUserId();
  try {
    const out = await undoRelationshipRun(userId, runId);
    revalidateReminderPaths();
    revalidatePath("/imports");
    return out;
  } catch (err) {
    if (err instanceof RunStillActiveError) return refusal(err.message);
    if (err instanceof Error && err.message === "Run not found") return refusal("That analysis is gone — refresh and try again");
    throw err;
  }
}

export async function remindRunFlag(runId: string, key: string): Promise<{ ok: true } | Refusal> {
  const userId = await requireUserId();
  const made = await promoteRunFlag(userId, runId, key);
  revalidateReminderPaths();
  return promoteReply(made, "That reminder was already made");
}

export async function dismissRunFlagAction(runId: string, key: string): Promise<{ ok: true } | Refusal> {
  const userId = await requireUserId();
  await dismissRunFlag(userId, runId, key);
  return { ok: true };
}

export async function remindOpenThread(contactId: string, key: string): Promise<{ ok: true } | Refusal> {
  const userId = await requireUserId();
  const made = await promoteOpenThread(userId, contactId, key);
  revalidateReminderPaths();
  revalidatePath(`/contacts/${contactId}`);
  return promoteReply(made, "That thread already has a reminder");
}

export async function dismissOpenThreadAction(contactId: string, key: string): Promise<{ ok: true } | Refusal> {
  const userId = await requireUserId();
  await dismissOpenThread(userId, contactId, key);
  revalidatePath(`/contacts/${contactId}`);
  return { ok: true };
}
