"use server";

/**
 * Committing or dismissing a proposed action from a chat answer.
 *
 * Mirrors the two rules at the top of `src/lib/mcp/server.ts`: an agent composes, a human
 * sends; nothing sends, nothing approves a draft, without a click. The model proposed this
 * when the answer was written (`validateProposedActions`, @/lib/chat-proposed-actions) — the
 * arguments were validated then, against the ids the model was actually shown, and are taken
 * from the STORED row here, never re-read from the client. `commitProposedAction` takes no
 * argument beyond the two ids that address the proposal.
 *
 * Claiming is a single compare-and-swap UPDATE: the whole `proposed_actions` column is
 * compared against what was just read and only replaced if nothing has changed it since,
 * which is what makes a double click (or two tabs) commit exactly once without a transaction
 * — neon-http has none, so every multi-row-implying change here is one statement.
 */
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { chatMessages } from "@/db/schema";
import { requireUserForSurface } from "@/lib/plan-guards";
import { createReminderForUser, scheduleContactFollowUpForUser } from "@/lib/reminder-writes";
import { logNoteInteractionForUser } from "@/lib/contact-writes";
import type { StoredProposedAction } from "@/lib/chat-proposed-actions";
import { revalidatePathIfRequestScoped } from "@/lib/reminder-paths";

type ClaimOk = { ok: true; actions: StoredProposedAction[]; index: number; action: StoredProposedAction };
type ClaimFail = { ok: false; reason: "not_found" | "already_done" | "already_dismissed" | "conflict" };

/**
 * Reads the message's `proposed_actions`, finds the one named, and — only if it is still
 * `proposed` — flips it to `claiming` in one UPDATE guarded by the exact JSON the read just
 * saw. A concurrent claim (a second click, a second tab) loses this compare, gets zero rows
 * back, and is reported as a conflict rather than committing twice.
 */
async function claim(
  userId: string,
  messageId: string,
  actionId: string,
  nextStatus: "committing" | "dismissed"
): Promise<ClaimOk | ClaimFail> {
  const db = await getDb();
  const row = await db.query.chatMessages.findFirst({
    where: and(eq(chatMessages.id, messageId), eq(chatMessages.userId, userId), eq(chatMessages.role, "assistant")),
    columns: { proposedActions: true },
  });
  if (!row) return { ok: false, reason: "not_found" };
  const actions = row.proposedActions ?? [];
  const index = actions.findIndex((a) => a.id === actionId);
  if (index === -1) return { ok: false, reason: "not_found" };
  const current = actions[index]!;
  if (current.status === "done") return { ok: false, reason: "already_done" };
  if (current.status === "dismissed") return { ok: false, reason: "already_dismissed" };
  if (current.status !== "proposed") return { ok: false, reason: "conflict" };

  const before = JSON.stringify(actions);
  const claimed = actions.slice();
  claimed[index] = { ...current, status: nextStatus };

  const updated = await db
    .update(chatMessages)
    .set({ proposedActions: claimed })
    .where(
      and(
        eq(chatMessages.id, messageId),
        eq(chatMessages.userId, userId),
        sql`${chatMessages.proposedActions} = ${before}::jsonb`
      )
    )
    .returning(); // bare: a field selector breaks over the Db union
  if (!updated.length) return { ok: false, reason: "conflict" };
  return { ok: true, actions: claimed, index, action: claimed[index]! };
}

/** Writes the array back with one entry settled, by the same CAS the claim used to set it. */
async function settle(
  userId: string,
  messageId: string,
  claimedActions: StoredProposedAction[],
  index: number,
  next: Partial<StoredProposedAction>
): Promise<void> {
  const db = await getDb();
  const before = JSON.stringify(claimedActions);
  const after = claimedActions.slice();
  after[index] = { ...after[index]!, ...next };
  await db
    .update(chatMessages)
    .set({ proposedActions: after })
    .where(
      and(
        eq(chatMessages.id, messageId),
        eq(chatMessages.userId, userId),
        sql`${chatMessages.proposedActions} = ${before}::jsonb`
      )
    );
  // Best-effort: if this lost a race (should not happen — nothing else touches a `committing`
  // row), the action is left `committing` rather than corrupted, and is visible as such.
}

const REASON_COPY: Record<ClaimFail["reason"], string> = {
  not_found: "That action could not be found.",
  already_done: "Already added.",
  already_dismissed: "Already dismissed.",
  conflict: "Someone else just acted on this — refresh to see the current state.",
};

export type CommitResult =
  | { ok: true; resultId: string | null }
  | { ok: false; reason: string };

/**
 * Turn one proposed action into a real write. The only arguments are the two ids that name
 * it — everything else (the contact, the text, the date) comes from the row the model wrote
 * when the answer was created, re-validated here exactly as `chat-versions.ts`'s slot resolve
 * re-validates a version target, never taken from whatever the client happens to send.
 */
export async function commitProposedAction(messageId: string, actionId: string): Promise<CommitResult> {
  const userId = await requireUserForSurface("page.chat");
  const claimed = await claim(userId, messageId, actionId, "committing");
  if (!claimed.ok) return { ok: false, reason: REASON_COPY[claimed.reason] };

  const { args } = claimed.action;
  try {
    let resultId: string | null = null;
    if (args.kind === "log_interaction") {
      // `skipRevalidate`: the lib function's own `revalidatePath` calls are unguarded and
      // throw outside a request (a script exercising this action directly); this action
      // does its own revalidation right after, through the safe wrapper.
      const { row } = await logNoteInteractionForUser(
        userId,
        {
          contactId: args.contactId,
          rawNotes: args.text,
          source: "chat_proposed",
          externalId: `chat:${messageId}:${actionId}`,
          direction: "out",
        },
        { skipRevalidate: true }
      );
      resultId = row.id;
      revalidatePathIfRequestScoped(`/contacts/${args.contactId}`);
      revalidatePathIfRequestScoped("/");
      revalidatePathIfRequestScoped("/graph");
    } else if (args.kind === "create_reminder") {
      const row = await createReminderForUser(userId, {
        contactId: args.contactId ?? undefined,
        title: args.title,
        description: args.description ?? undefined,
        dueDate: args.dueDate ?? undefined,
        reminderType: "manual",
      });
      resultId = row?.id ?? null;
      revalidatePathIfRequestScoped("/reminders");
    } else {
      const result = await scheduleContactFollowUpForUser(userId, args.contactId, args.days);
      resultId = result.reminder?.id ?? null;
      revalidatePathIfRequestScoped(`/contacts/${args.contactId}`);
    }

    await settle(userId, messageId, claimed.actions, claimed.index, { status: "done", resultId });
    return { ok: true, resultId };
  } catch (err) {
    // Release the claim so a retry is possible — a transient failure (the contact was
    // deleted between propose and click, a DB hiccup) must not permanently strand the card.
    await settle(userId, messageId, claimed.actions, claimed.index, { status: "proposed" });
    return { ok: false, reason: err instanceof Error ? err.message : "Couldn’t do that — try again?" };
  }
}

export async function dismissProposedAction(messageId: string, actionId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const userId = await requireUserForSurface("page.chat");
  const claimed = await claim(userId, messageId, actionId, "dismissed");
  if (!claimed.ok) return { ok: false, reason: REASON_COPY[claimed.reason] };
  return { ok: true };
}
