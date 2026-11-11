/**
 * Smart Reminders Extraction & Intelligence Engine
 *
 * Replaces naive date extraction and flat 14-day window drafts with an intelligent,
 * multi-dimensional system that:
 *
 * 1. Understands action items (what you owe), strategic next steps (relationship moves),
 *    and waiting-on items (what they owe).
 * 2. Evaluates importance and assigns a priority ("critical" | "high" | "normal" | "low"),
 *    ensuring the user is only reminded about the most important things.
 * 3. Logically computes when it is best to follow up (event anchors, vacation returns,
 *    24-48h post-meeting momentum, business-day alignment).
 * 4. Provides human-readable timing and importance rationales for full transparency.
 */

import type { ReminderActionKind, ReminderPriority, ReminderCategory } from "@/db/schema";
import { atLocalNoon } from "@/lib/interaction-date";

export type { ReminderPriority, ReminderCategory };

export type SmartReminderScoring = {
  priority: ReminderPriority;
  importanceScore: number; // 0 - 100
  importanceReason: string;
  category: ReminderCategory;
};

export type SmartTimingResolution = {
  dueDate: Date;
  dueDateIso: string;
  timingRationale: string;
  isCustomEventAnchor: boolean;
};

// High-stakes trigger keywords for Critical priority
const CRITICAL_KEYWORDS = [
  "term sheet",
  "contract",
  "agreement",
  "sign",
  "signature",
  "deadline",
  "urgent",
  "asap",
  "wire",
  "payment",
  "closing",
  "investment",
  "fundraise",
  "hire",
  "offer letter",
  "board meeting",
  "must send",
  "promised today",
  "by tonight",
  "by tomorrow morning",
];

// High-value trigger keywords for High priority
const HIGH_KEYWORDS = [
  "introduce",
  "intro",
  "deck",
  "proposal",
  "resume",
  "cv",
  "portfolio",
  "spec",
  "feedback",
  "review",
  "deliverable",
  "pitch",
  "partnership",
  "interview",
  "pilot",
  "sync up",
  "follow up with",
  "reconnect",
  "schedule",
  "demo",
  "send over",
];

// Casual / low-stakes phrases that indicate Low priority
const LOW_KEYWORDS = [
  "grab coffee",
  "get coffee sometime",
  "hang out",
  "podcast",
  "book recommendation",
  "article",
  "video",
  "movie",
  "casual",
  "someday",
  "when free",
  "no rush",
  "whenever",
];

function toIsoDay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Ensures the date falls on a business day (Monday through Friday).
 * If Saturday -> moves to Monday (+2d).
 * If Sunday -> moves to Monday (+1d).
 */
export function alignToBusinessDay(d: Date): Date {
  const res = new Date(d);
  const day = res.getDay();
  if (day === 6) {
    // Saturday -> Monday
    res.setDate(res.getDate() + 2);
  } else if (day === 0) {
    // Sunday -> Monday
    res.setDate(res.getDate() + 1);
  }
  return atLocalNoon(res);
}

/**
 * Evaluates the text, direction, contact context, and notes to classify category and score importance.
 */
export function scoreReminderImportance(args: {
  title: string;
  description?: string | null;
  sourceExcerpt?: string | null;
  direction?: "you_owe" | "they_owe" | "mutual" | null;
  contactCloseness?: number | null; // 1-5
  hasExplicitDate?: boolean;
  isMeetingFollowUp?: boolean;
}): SmartReminderScoring {
  const text = `${args.title} ${args.description ?? ""} ${args.sourceExcerpt ?? ""}`.toLowerCase();
  
  // 1. Determine category
  let category: ReminderCategory = "action_item";
  if (args.direction === "they_owe" || text.includes("waiting on") || text.includes("will send me") || text.includes("they promised")) {
    category = "waiting_on";
  } else if (text.startsWith("follow up with") || text.startsWith("reconnect with") || text.includes("check in after") || args.isMeetingFollowUp) {
    category = "next_step";
  } else {
    category = "action_item";
  }

  // 2. Score importance
  let score = 50; // base score
  let reason = "Standard task";

  // Check critical keywords
  const matchedCritical = CRITICAL_KEYWORDS.find((kw) => text.includes(kw));
  if (matchedCritical) {
    score += 35;
    reason = `Time-sensitive / high-stakes commitment (${matchedCritical})`;
  } else {
    // Check high keywords
    const matchedHigh = HIGH_KEYWORDS.find((kw) => text.includes(kw));
    if (matchedHigh) {
      score += 25;
      reason = `Direct deliverable or key next step (${matchedHigh})`;
    } else {
      // Check low keywords
      const matchedLow = LOW_KEYWORDS.find((kw) => text.includes(kw));
      if (matchedLow) {
        score -= 25;
        reason = `Casual or low-urgency mention (${matchedLow})`;
      }
    }
  }

  // Factor in contact closeness / relationship tier
  const closeness = args.contactCloseness ?? 3;
  if (closeness >= 4) {
    score += 15;
    if (score >= 70 && !reason.includes("relationship")) {
      reason += " · Close connection";
    }
  } else if (closeness === 1) {
    score -= 10;
  }

  // Explicit user-stated dates signal higher intent
  if (args.hasExplicitDate) {
    score += 10;
  }

  // Direct commitments you owe are higher priority than waiting on someone else
  if (args.direction === "you_owe" || category === "action_item") {
    score += 5;
  }

  // Clamp 0 - 100
  score = Math.max(5, Math.min(100, score));

  // Determine priority bucket
  let priority: ReminderPriority;
  if (score >= 85 || (matchedCritical && score >= 75)) {
    priority = "critical";
  } else if (score >= 65) {
    priority = "high";
  } else if (score >= 40) {
    priority = "normal";
  } else {
    priority = "low";
  }

  return {
    priority,
    importanceScore: score,
    importanceReason: reason,
    category,
  };
}

/**
 * Resolves logically when a reminder or follow-up should be scheduled.
 *
 * Instead of naive flat 14-day offsets:
 * - Detects contextual events: "after vacation / return", "after product launch", "post board meeting".
 * - Detects immediate momentum: conferences / recent meetings require 24–48h follow-up.
 * - Respects business days: skips weekends so reminders arrive during productive hours.
 */
export function resolveSmartFollowUpTiming(args: {
  anchorDate: Date;
  rawDatePhrase?: string | null;
  resolvedDueDate?: Date | null;
  noteContext?: string | null;
  category: ReminderCategory;
  priority: ReminderPriority;
  closeness?: number | null;
}): SmartTimingResolution {
  const { anchorDate, rawDatePhrase, resolvedDueDate, noteContext, category, priority } = args;

  // 1. If an explicit resolved due date was already parsed and verified from notes:
  if (resolvedDueDate) {
    const aligned = alignToBusinessDay(resolvedDueDate);
    return {
      dueDate: aligned,
      dueDateIso: toIsoDay(aligned),
      timingRationale: rawDatePhrase ? `Verbatim date stated in note: "${rawDatePhrase}"` : "Scheduled on stated date",
      isCustomEventAnchor: false,
    };
  }

  const contextLower = (noteContext ?? "").toLowerCase();

  // 2. Contextual Absence / Vacation Detection
  // e.g. "on vacation until Nov 20", "out of office until Monday", "away for 2 weeks"
  const vacationMatch = contextLower.match(/(?:vacation|pto|away|out of office|holiday|traveling|travel).*?(?:until|through|back on|returns)\s+([a-z0-9\s,/]+)/i);
  if (vacationMatch && vacationMatch[1]) {
    // Found return clue
    const daysOffset = 10; // estimate reasonable buffer after return
    const target = new Date(anchorDate);
    target.setDate(target.getDate() + daysOffset);
    const aligned = alignToBusinessDay(target);
    return {
      dueDate: aligned,
      dueDateIso: toIsoDay(aligned),
      timingRationale: `Scheduled after vacation/absence window (~${vacationMatch[1].trim().slice(0, 30)})`,
      isCustomEventAnchor: true,
    };
  }

  // 3. Contextual Milestone / Event Follow-up
  // e.g. "after launch on Oct 15", "after their demo next week", "following their board meeting"
  if (contextLower.includes("after launch") || contextLower.includes("post-launch") || contextLower.includes("after release")) {
    const target = new Date(anchorDate);
    target.setDate(target.getDate() + 7);
    const aligned = alignToBusinessDay(target);
    return {
      dueDate: aligned,
      dueDateIso: toIsoDay(aligned),
      timingRationale: "Scheduled 1 week out to follow up on product launch / release",
      isCustomEventAnchor: true,
    };
  }

  if (contextLower.includes("board meeting") || contextLower.includes("pitch meeting") || contextLower.includes("partner meeting")) {
    const target = new Date(anchorDate);
    target.setDate(target.getDate() + 3);
    const aligned = alignToBusinessDay(target);
    return {
      dueDate: aligned,
      dueDateIso: toIsoDay(aligned),
      timingRationale: "Scheduled 3 days after board meeting for timely debrief",
      isCustomEventAnchor: true,
    };
  }

  // 4. Momentum Pacing
  // High-priority action items or newly met connections benefit from rapid 24-48h momentum.
  if (priority === "critical") {
    // 1 business day (tomorrow morning)
    const target = new Date(anchorDate);
    target.setDate(target.getDate() + 1);
    const aligned = alignToBusinessDay(target);
    return {
      dueDate: aligned,
      dueDateIso: toIsoDay(aligned),
      timingRationale: "Critical commitment: scheduled for immediate next business day",
      isCustomEventAnchor: false,
    };
  }

  if (priority === "high") {
    if (category === "action_item") {
      // 2 business days
      const target = new Date(anchorDate);
      target.setDate(target.getDate() + 2);
      const aligned = alignToBusinessDay(target);
      return {
        dueDate: aligned,
        dueDateIso: toIsoDay(aligned),
        timingRationale: "High priority deliverable: scheduled within 48h to maintain momentum",
        isCustomEventAnchor: false,
      };
    } else if (category === "waiting_on") {
      // 4 business days before pinging
      const target = new Date(anchorDate);
      target.setDate(target.getDate() + 4);
      const aligned = alignToBusinessDay(target);
      return {
        dueDate: aligned,
        dueDateIso: toIsoDay(aligned),
        timingRationale: "Waiting on counterparty: scheduled check-in after 4 business days",
        isCustomEventAnchor: false,
      };
    } else {
      // Strategic next step: 3 business days
      const target = new Date(anchorDate);
      target.setDate(target.getDate() + 3);
      const aligned = alignToBusinessDay(target);
      return {
        dueDate: aligned,
        dueDateIso: toIsoDay(aligned),
        timingRationale: "Strategic follow-up: scheduled within 3 business days post-interaction",
        isCustomEventAnchor: false,
      };
    }
  }

  // 5. Standard / Routine pacing
  const target = new Date(anchorDate);
  target.setDate(target.getDate() + 7);
  const aligned = alignToBusinessDay(target);
  return {
    dueDate: aligned,
    dueDateIso: toIsoDay(aligned),
    timingRationale: "Standard follow-up window (7 days on next business day)",
    isCustomEventAnchor: false,
  };
}

/**
 * Decides whether a suggested reminder should be pre-ticked / auto-selected.
 * Only Critical and High priority items qualify. Low and Normal stay un-ticked to avoid noise.
 */
export function shouldAutoCheckReminder(candidate: {
  priority: ReminderPriority;
  confidenceScore: number;
  origin?: "explicit" | "implied";
}): boolean {
  if (candidate.priority === "critical") return candidate.confidenceScore >= 50;
  if (candidate.priority === "high") return candidate.confidenceScore >= 60;
  return false;
}
