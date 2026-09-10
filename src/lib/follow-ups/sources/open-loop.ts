import { daysBetween, startOfDay } from "../time";
import type { InteractionSnapshot, SignalCandidate, SignalSource } from "../types";

const MIN_DAYS = 7;
const MAX_DAYS = 120;

/**
 * Whether a message plausibly contains an unanswered ask.
 *
 * Deliberately shallow. This is a cheap gate that decides which conversations are worth
 * the phase-2 judge's attention, not a judgement in itself — a false positive costs one
 * shortlist slot, and the judge drops it.
 */
export function looksLikeOpenAsk(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (t.includes("?")) return true;
  return /\b(let me know|could you|would you|can you|any chance|thoughts on|when you get a chance|waiting on|following up|circle back)\b/i.test(
    t
  );
}

/**
 * Whether the conversation has any usable direction data at all.
 *
 * `interactions.direction` is nullable and, per the schema comment, was never persisted
 * by earlier imports and cannot be reconstructed. A thread of all-NULL directions is a
 * THIRD state — not inbound, not outbound — and guessing either way is wrong.
 */
function hasDirectionData(rows: InteractionSnapshot[]): boolean {
  return rows.some((r) => r.direction !== null);
}

export const openLoopSource: SignalSource = {
  kind: "open_loop",
  cadence: "daily",
  detect(ctx) {
    const out: SignalCandidate[] = [];

    for (const c of ctx.contacts) {
      const rows = ctx.interactionsByContact.get(c.id) ?? [];
      if (rows.length === 0) continue;

      const latest = rows[0];
      const days = daysBetween(latest.interactionDate, ctx.now);
      if (days === null || days < MIN_DAYS || days > MAX_DAYS) continue;

      if (hasDirectionData(rows)) {
        // The precise path: they spoke last, and it reads like an ask.
        if (latest.direction !== "in") continue;
        if (!looksLikeOpenAsk(latest.text)) continue;
        out.push({
          kind: "open_loop",
          contactId: c.id,
          dueOn: startOfDay(ctx.now),
          evidence: `They wrote last ${days} days ago and it reads like an open ask`,
        });
        continue;
      }

      // Fallback for legacy imports with no direction anywhere. Extracted action items
      // are the only evidence of an open loop that survives without a sender, and they
      // are a weaker signal — a question mark alone is not enough here, because we
      // cannot tell whose question it was.
      const openItems = rows.flatMap((r) => r.actionItems).filter(Boolean);
      if (openItems.length === 0) continue;
      out.push({
        kind: "open_loop",
        contactId: c.id,
        dueOn: startOfDay(ctx.now),
        evidence: `An unresolved item from ${days} days ago: "${openItems[0]}"`,
      });
    }

    return out;
  },
};
