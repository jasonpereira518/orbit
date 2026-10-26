"use server";

/**
 * Committing or dismissing a proposed action from a chat answer.
 *
 * Mirrors the two rules at the top of `src/lib/mcp/server.ts`: an agent composes, a human
 * sends; nothing sends, nothing approves a draft, without a click. The model proposed this
 * when the answer was written (@/lib/tools/chat-proposals) — the input was validated then,
 * against the ids the model was actually shown, and is taken from the STORED row here, never
 * re-read from the client. `commitProposedAction` takes no
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
import { UserFacingError } from "@/lib/errors";
import type { StoredProposedAction } from "@/lib/chat-proposed-actions";
import { revalidatePathIfRequestScoped } from "@/lib/reminder-paths";
import { chatWriteNamed, parseWriteInput, runUndo, type UndoStep } from "@/lib/tools/chat-writes";

type ClaimOk = { ok: true; actions: StoredProposedAction[]; index: number; action: StoredProposedAction };
type ClaimFail = { ok: false; reason: "not_found" | "already_done" | "already_dismissed" | "already_undone" | "conflict" };

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
  nextStatus: "committing" | "dismissed" | "undoing",
  /** The state the action must be in to be claimed: `done` for an undo, `proposed` otherwise. */
  from: "proposed" | "done" = "proposed"
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
  if (from === "proposed") {
    if (current.status === "done") return { ok: false, reason: "already_done" };
    if (current.status === "dismissed") return { ok: false, reason: "already_dismissed" };
  }
  if (current.status === "undone") return { ok: false, reason: "already_undone" };
  if (current.status !== from) return { ok: false, reason: "conflict" };

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
  already_undone: "Already undone.",
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
    // A chat write (@/lib/tools/chat-writes), committed through its own catalog entry from
    // the stored input — re-validated against that entry's schema, never trusted as stored.
    const write = chatWriteNamed(args.tool);
    const input = write ? parseWriteInput(write, args.input) : null;
    if (!write || !input) throw new UserFacingError("That change can’t be made any more");
    const outcome = await write.commit(userId, input, { messageId, actionId });
    for (const path of new Set([outcome.href, "/", "/reminders", "/contacts"].filter((p): p is string => Boolean(p)))) {
      revalidatePathIfRequestScoped(path);
    }
    await settle(userId, messageId, claimed.actions, claimed.index, {
      status: "done",
      resultId: outcome.resultId,
      href: outcome.href,
      undo: outcome.undo,
    });
    return { ok: true, resultId: outcome.resultId };
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

/**
 * Reverse a committed chat write, from the inverse its commit stored (`undo`). Claimed
 * `done → undoing` by the same compare-and-swap as a commit, so a double click undoes once;
 * a failed undo goes back to `done` and the card still offers it.
 */
export async function undoProposedAction(messageId: string, actionId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const userId = await requireUserForSurface("page.chat");
  const claimed = await claim(userId, messageId, actionId, "undoing", "done");
  if (!claimed.ok) return { ok: false, reason: REASON_COPY[claimed.reason] };
  const step = claimed.action.undo as UndoStep | null | undefined;
  if (!step) {
    await settle(userId, messageId, claimed.actions, claimed.index, { status: "done" });
    return { ok: false, reason: "That can’t be undone from here." };
  }
  try {
    await runUndo(userId, step);
    for (const path of new Set([claimed.action.href, "/", "/reminders", "/contacts"].filter((p): p is string => Boolean(p)))) {
      revalidatePathIfRequestScoped(path);
    }
    await settle(userId, messageId, claimed.actions, claimed.index, { status: "undone" });
    return { ok: true };
  } catch (err) {
    await settle(userId, messageId, claimed.actions, claimed.index, { status: "done" });
    return { ok: false, reason: err instanceof Error ? err.message : "Couldn’t undo that — try again?" };
  }
}
