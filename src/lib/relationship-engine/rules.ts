/**
 * What a validated digest is allowed to write. Pure — the whole autonomy policy is here.
 *
 * Messages are mostly historical. A two-year-old "let's grab coffee next week" must never
 * become an overdue reminder today, so only two things earn a reminder: a stated date still
 * ahead, and an undated commitment or implied follow-up from a recent message. A stated
 * date that JUST passed, and that the model is sure of, is offered as a flag (the Drive
 * import's precedent, src/lib/imports/drive-reminder-rules.ts). Everything else unresolved
 * becomes an open thread: visible, promotable with one click, never a nag.
 */
import { createHash } from "node:crypto";
import type { RelationshipOpenThread, RelationshipRunFlag } from "@/db/schema";
import { FLAG_MIN_CONFIDENCE } from "@/lib/imports/drive-reminder-rules";
import { followUpDaysFor, windowDueDate } from "@/lib/note-batches";
import type {
  DigestWritePlan,
  PlannedActionItem,
  PlannedReminder,
  ValidatedDigest,
} from "@/lib/relationship-engine/types";

export const RECENT_DAYS = 45;
export const FLAG_LOOKBACK_DAYS = 14;
export const REMINDERS_PER_CONTACT = 3;
export const REMINDERS_PER_RUN = 25;

const DAY_MS = 86_400_000;

export type RulesContext = {
  contactId: string;
  contactFirstName: string;
  now: Date;
  closeness: number | null;
  cadenceDays: number | null;
  existingThreads: RelationshipOpenThread[];
  remindersLeftInRun: number;
};

export function openThreadKey(interactionId: string, text: string): string {
  return createHash("sha256").update(`${interactionId}|${text.trim().toLowerCase()}`).digest("hex").slice(0, 16);
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function atUtcNoon(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12));
}

export function planDigestWrites(v: ValidatedDigest, ctx: RulesContext): DigestWritePlan {
  const today = startOfUtcDay(ctx.now);
  const tomorrow = atUtcNoon(new Date(today.getTime() + DAY_MS));
  const recentCutoff = new Date(today.getTime() - RECENT_DAYS * DAY_MS);
  const flagCutoff = new Date(today.getTime() - FLAG_LOOKBACK_DAYS * DAY_MS);

  type Candidate = PlannedActionItem & { reminder: PlannedReminder; messageAt: Date };
  const candidates: Candidate[] = [];
  const newThreads: RelationshipOpenThread[] = [];
  const flags: RelationshipRunFlag[] = [];

  const toThread = (text: string, owedBy: "me" | "them" | null, at: Date, interactionId: string, excerpt: string) => {
    newThreads.push({ key: openThreadKey(interactionId, text), text, owedBy, sinceIso: at.toISOString().slice(0, 10), interactionId, excerpt });
  };

  for (const d of v.dated) {
    if (d.dueDate >= today) {
      const due = d.owedBy === "them" ? atUtcNoon(new Date(d.dueDate.getTime() + DAY_MS)) : d.dueDate;
      const title = d.owedBy === "them" ? `Check in with ${ctx.contactFirstName}: ${d.text}` : d.text;
      candidates.push({
        text: d.text,
        owedBy: d.owedBy,
        interactionId: d.interactionId,
        messageAt: d.messageAt,
        reminder: {
          title, dueDate: due, rawDatePhrase: d.rawDatePhrase, dateBasis: d.dateBasis, origin: "explicit",
          actionKind: d.owedBy === "them" ? "follow_up" : d.actionKind, confidence: d.confidence, excerpt: d.excerpt, interactionId: d.interactionId,
        },
      });
    } else if (d.dueDate >= flagCutoff && d.confidence >= FLAG_MIN_CONFIDENCE) {
      flags.push({
        key: openThreadKey(d.interactionId, d.text), contactId: ctx.contactId, title: d.text,
        dueDateIso: d.dueDate.toISOString().slice(0, 10), sourceExcerpt: d.excerpt, interactionId: d.interactionId,
      });
    } else {
      toThread(d.text, d.owedBy, d.messageAt, d.interactionId, d.excerpt);
    }
  }

  for (const u of v.undated) {
    if (u.messageAt >= recentCutoff) {
      const days = followUpDaysFor(ctx.closeness, u.withinDays, ctx.cadenceDays);
      let due = atUtcNoon(windowDueDate(u.messageAt, days));
      if (due < tomorrow) due = tomorrow;
      candidates.push({
        text: u.text,
        owedBy: u.owedBy,
        interactionId: u.interactionId,
        messageAt: u.messageAt,
        reminder: {
          title: u.owedBy === "them" ? `Check in with ${ctx.contactFirstName}: ${u.text}` : u.text,
          dueDate: due, rawDatePhrase: null, dateBasis: "window", origin: u.origin,
          actionKind: "follow_up", confidence: u.confidence, excerpt: u.excerpt, interactionId: u.interactionId,
        },
      });
    } else {
      toThread(u.text, u.owedBy, u.messageAt, u.interactionId, u.excerpt);
    }
  }

  // Caps: soonest first; overflow becomes open threads, never silently dropped.
  candidates.sort((a, b) => a.reminder.dueDate.getTime() - b.reminder.dueDate.getTime());
  const allowed = Math.max(0, Math.min(REMINDERS_PER_CONTACT, ctx.remindersLeftInRun));
  const kept = candidates.slice(0, allowed);
  for (const c of candidates.slice(allowed)) {
    toThread(c.text, c.owedBy, c.messageAt, c.interactionId, c.reminder.excerpt);
  }

  // Thread list: existing − closed + new (deduped by key).
  const closed = new Set(v.closedKeys.filter((k) => !k.startsWith("ai:")));
  const threads = ctx.existingThreads.filter((t) => !closed.has(t.key));
  const have = new Set(threads.map((t) => t.key));
  let added = 0;
  for (const t of newThreads) {
    if (have.has(t.key)) continue;
    have.add(t.key);
    threads.push(t);
    added += 1;
  }

  const seenFacts = new Set<string>();
  const facts = v.facts
    .filter((f) => {
      const k = f.trim().toLowerCase();
      if (!k || seenFacts.has(k)) return false;
      seenFacts.add(k);
      return true;
    })
    .map((f) => f.trim());

  return {
    actionItems: kept.map(({ messageAt: _m, ...item }) => item),
    openThreads: threads,
    newOpenThreads: added,
    flags,
    closeActionItemIds: v.closedKeys.filter((k) => k.startsWith("ai:")).map((k) => k.slice(3)),
    facts,
    remindersPlanned: kept.length,
  };
}
