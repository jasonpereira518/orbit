/**
 * Auto-apply: the chat makes its small, reversible changes itself, when the person allows it.
 *
 * Off by default (`user_settings.chat_auto_apply`). When on, a proposal the answer loop stores
 * (@/lib/tools/chat-proposals) may be committed in the same request instead of waiting for a
 * click — but only when `shouldAutoApply` says every condition holds: the write's tier is
 * `auto`, it touches nothing Orbit uses to tell people apart, it touches at most a handful of
 * records, the turn has not already applied its share, and nothing in the turn looked like an
 * injection or needed scrubbing. Anything else stays a card to confirm.
 *
 * The commit is the catalog's own (`ChatWrite.commit`), from the proposal's validated input,
 * and stores the same inverse a confirmed card does — so an applied change is a done card with
 * Undo, exactly like one the person clicked. Every one is recorded as a `chat_auto_apply`
 * security event.
 */
import { getDb } from "@/db";
import { userSettings } from "@/db/schema";
import { detectInjectionSignals, guardModelOutput, recordAiSecurityEvent } from "@/lib/ai-security";
import type { StoredProposedAction } from "@/lib/chat-proposed-actions";
import { revalidatePathIfRequestScoped } from "@/lib/reminder-paths";
import { chatWriteNamed, parseWriteInput, runUndo, touchesIdentity, type UndoStep } from "@/lib/tools/chat-writes";

/** Changes one turn may apply itself; the rest are proposed. */
export const AUTO_APPLY_PER_TURN = 5;
/** Records one applied change may touch (attendees marked, tags added count one each). */
export const AUTO_APPLY_MAX_RECORDS = 5;

export async function saveChatAutoApplyFor(userId: string, enabled: boolean): Promise<void> {
  const db = await getDb();
  const value = enabled ? 1 : 0;
  await db
    .insert(userSettings)
    .values({ userId, chatAutoApply: value })
    .onConflictDoUpdate({ target: userSettings.userId, set: { chatAutoApply: value, updatedAt: new Date() } });
}

export type AutoApplyFacts = {
  enabled: boolean;
  tier: "auto" | "confirm" | undefined;
  destructive: boolean;
  identity: boolean;
  records: number;
  appliedThisTurn: number;
  /** Why the turn may not apply anything, when something in it looked wrong. */
  taintedBy: string | null;
};

/** The rule, pure. Every condition must hold; the default is to ask. */
export function shouldAutoApply(f: AutoApplyFacts): boolean {
  return (
    f.enabled &&
    f.tier === "auto" &&
    !f.destructive &&
    !f.identity &&
    f.records <= AUTO_APPLY_MAX_RECORDS &&
    f.appliedThisTurn < AUTO_APPLY_PER_TURN &&
    f.taintedBy === null
  );
}

/**
 * One turn's auto-apply state. `enabled` is the person's setting; `inspect` and `inspectOutput`
 * taint the turn when the text it read or wrote matches an injection shape or needs scrubbing,
 * and a tainted turn applies nothing more.
 */
export function createAutoApplyGate(userId: string, enabled: boolean) {
  let taintedBy: string | null = null;
  let applied = 0;
  const taint = (reason: string) => {
    taintedBy ??= reason;
  };
  return {
    enabled,
    get taintedBy() {
      return taintedBy;
    },
    get applied() {
      return applied;
    },
    /** Text the model read this turn: the prompt, or a lookup's result. */
    inspect(source: string, text: string | null | undefined, ownFenceNonce?: string) {
      if (!enabled || !text || taintedBy) return;
      // The prompt's own fence lines carry its nonce, which nothing in the data can know; they
      // are dropped so they do not read as forged ones. A forged fence still taints the turn.
      if (ownFenceNonce && /^[0-9a-f]{12}$/.test(ownFenceNonce)) {
        const own = new RegExp(`^\\s*(?:<<<)?[A-Z][A-Z_]*_${ownFenceNonce}\\s*$`, "gm");
        text = text.replace(own, "");
      }
      // `detectInjectionSignals` reads the first 20,000 characters; a prompt is longer, so
      // every slice is read (overlapping, so a phrase on a boundary is not split).
      for (let i = 0; i < text.length; i += 19_000) {
        if (detectInjectionSignals(text.slice(i, i + 20_000)).length) return taint(`injection_signal:${source}`);
      }
    },
    /** The answer written so far: anything `guardModelOutput` would scrub taints the turn. */
    inspectOutput(text: string) {
      if (enabled && guardModelOutput(text).findings.length) taint("output_scrubbed");
    },
    /** Facts for `shouldAutoApply` about one stored proposal. */
    facts(action: StoredProposedAction): AutoApplyFacts {
      const write = action.args.kind === "tool" ? chatWriteNamed(action.args.tool) : undefined;
      const input = action.args.kind === "tool" ? action.args.input : {};
      const records = write
        ? Object.values(write.refs(input)).reduce((n, ids) => n + (ids?.length ?? 0), 0) +
          (Array.isArray(input.tags) ? Math.max(0, input.tags.length - 1) : 0)
        : Number.POSITIVE_INFINITY;
      return {
        enabled,
        // The card's own tier: it can depend on the input (`tierFor`), and the stored one is
        // what the person saw. A write that opens a dialog is never applied without them.
        tier: write?.opensDialog ? "confirm" : (action.tier ?? write?.tier),
        destructive: Boolean(write?.destructive),
        identity: write ? touchesIdentity(write, input) : true,
        records,
        appliedThisTurn: applied,
        taintedBy,
      };
    },
    /**
     * Commit `action` now if the rule allows. Returns the card as it should be stored: done
     * with its undo when applied, unchanged when not (or when the commit failed — a proposal
     * the person can still confirm is better than an error in the answer).
     */
    async maybeApply(action: StoredProposedAction, turnId: string): Promise<StoredProposedAction> {
      if (!shouldAutoApply(this.facts(action)) || action.args.kind !== "tool") return action;
      const write = chatWriteNamed(action.args.tool);
      const input = write ? parseWriteInput(write, action.args.input) : null;
      if (!write || !input) return action;
      applied++;
      try {
        const outcome = await write.commit(userId, input, { messageId: turnId, actionId: action.id });
        for (const path of new Set([outcome.href, "/", "/reminders", "/contacts"].filter((p): p is string => Boolean(p)))) {
          revalidatePathIfRequestScoped(path);
        }
        void recordAiSecurityEvent({
          kind: "chat_auto_apply",
          userId,
          surface: "chat",
          detail: { tool: write.name, actionId: action.id },
        });
        return {
          ...action,
          status: "done",
          resultId: outcome.resultId,
          href: outcome.href,
          undo: outcome.undo,
          autoApplied: true,
        };
      } catch {
        applied--;
        return action;
      }
    },
  };
}

export type AutoApplyGate = ReturnType<typeof createAutoApplyGate>;

/**
 * Undo every change a turn applied itself, newest first — for an answer that failed or was
 * stopped before it was saved, which would leave no card to undo them from. Best effort: one
 * that cannot be undone (it changed since) is left as it is.
 */
export async function rollBackApplied(userId: string, cards: readonly StoredProposedAction[]): Promise<number> {
  let undone = 0;
  for (const card of [...cards].reverse()) {
    if (!card.autoApplied || card.status !== "done" || !card.undo) continue;
    try {
      await runUndo(userId, card.undo as UndoStep);
      undone++;
    } catch {
      // Left applied; nothing more can be done without a card.
    }
  }
  return undone;
}
