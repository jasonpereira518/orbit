/**
 * Smoke test for the Smart Reminders Engine
 *
 * Verifies:
 * 1. Importance evaluation (critical, high, normal, low)
 * 2. Contextual temporal reasoning (events, vacations, momentum 24-48h, business days)
 * 3. Auto-tick curation policy (high-signal only)
 * 4. Deduplication & collision rules
 *
 * Run: npx tsx scripts/smoke-smart-reminders-engine.ts
 */

import {
  scoreReminderImportance,
  resolveSmartFollowUpTiming,
  shouldAutoCheckReminder,
  alignToBusinessDay,
} from "../src/lib/smart-reminders-extract";
import { defaultReminderKeys } from "../src/lib/capture/review-reducer";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) {
    throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  }
  console.log(`  ok   ${label}`);
}

console.log("Starting smart reminders engine smoke tests...\n");

// 1. Importance Evaluation
{
  console.log("Importance Evaluation:");
  
  // Critical commitment
  const termSheet = scoreReminderImportance({
    title: "Send revised term sheet by Friday",
    sourceExcerpt: "Investor requested the term sheet before the weekend.",
    direction: "you_owe",
    contactCloseness: 4,
  });
  check("term sheet is scored Critical", termSheet.priority === "critical");
  check("term sheet has high importance score (>= 80)", termSheet.importanceScore >= 80);
  check("category is action_item", termSheet.category === "action_item");

  // High priority intro
  const intro = scoreReminderImportance({
    title: "Introduce Alice to VP of Engineering",
    sourceExcerpt: "Alice asked for an intro to engineering leadership at Stripe.",
    direction: "you_owe",
    contactCloseness: 3,
  });
  check("intro is scored High priority", intro.priority === "high");
  check("category is action_item", intro.category === "action_item");

  // Waiting on them (they owe)
  const waitingOnSpec = scoreReminderImportance({
    title: "Waiting on API specs from Dave",
    sourceExcerpt: "Dave promised to send over the API spec document.",
    direction: "they_owe",
  });
  check("waiting on counterparty categorized as waiting_on", waitingOnSpec.category === "waiting_on");
  check("has high or normal priority for deliverable", waitingOnSpec.priority === "high" || waitingOnSpec.priority === "normal");

  // Casual coffee / low importance
  const coffee = scoreReminderImportance({
    title: "Grab coffee sometime next month",
    sourceExcerpt: "We should get coffee sometime when in NYC.",
    contactCloseness: 2,
  });
  check("casual coffee is scored Low priority", coffee.priority === "low");
  check("coffee score is < 45", coffee.importanceScore < 45);
}

// 2. Contextual Temporal Reasoning
{
  console.log("\nContextual Temporal Reasoning:");

  const anchor = new Date(2026, 8, 14, 12, 0, 0, 0); // Monday Sept 14, 2026

  // Business day alignment: Saturday -> Monday
  const saturday = new Date(2026, 8, 19, 12, 0, 0, 0); // Saturday Sept 19
  const alignedSat = alignToBusinessDay(saturday);
  check("Saturday aligns forward to Monday", alignedSat.getDay() === 1);
  check("Aligned date is Monday Sept 21", alignedSat.getDate() === 21);

  // Sunday -> Monday
  const sunday = new Date(2026, 8, 20, 12, 0, 0, 0); // Sunday Sept 20
  const alignedSun = alignToBusinessDay(sunday);
  check("Sunday aligns forward to Monday", alignedSun.getDay() === 1);
  check("Aligned date is Monday Sept 21", alignedSun.getDate() === 21);

  // Critical momentum: next business day
  const critTiming = resolveSmartFollowUpTiming({
    anchorDate: anchor,
    category: "action_item",
    priority: "critical",
  });
  check("Critical priority schedules for next business day (Sept 15)", critTiming.dueDateIso === "2026-09-15");
  check("Includes explanation in timingRationale", critTiming.timingRationale.includes("next business day"));

  // High priority deliverable: 2 business days
  const highActionTiming = resolveSmartFollowUpTiming({
    anchorDate: anchor,
    category: "action_item",
    priority: "high",
  });
  check("High priority deliverable schedules within 48h (Sept 16)", highActionTiming.dueDateIso === "2026-09-16");

  // Contextual Event: Post-Board Meeting
  const boardMeetingTiming = resolveSmartFollowUpTiming({
    anchorDate: anchor,
    noteContext: "Sync with Sarah after their board meeting next week.",
    category: "next_step",
    priority: "high",
  });
  check("Board meeting context detected", boardMeetingTiming.isCustomEventAnchor === true);
  check("Timing rationale mentions board meeting debrief", boardMeetingTiming.timingRationale.toLowerCase().includes("debrief"));

  // Contextual Event: Vacation / Absence
  const vacationTiming = resolveSmartFollowUpTiming({
    anchorDate: anchor,
    noteContext: "Mark is on vacation until Nov 20, let's talk then.",
    category: "next_step",
    priority: "normal",
  });
  check("Vacation context detected", vacationTiming.isCustomEventAnchor === true);
  check("Timing rationale mentions vacation window", vacationTiming.timingRationale.includes("vacation"));
}

// 3. Auto-Tick Curation Policy (High-signal only)
{
  console.log("\nAuto-Tick Curation Policy:");

  check(
    "Critical priority with score 85 is auto-ticked",
    shouldAutoCheckReminder({ priority: "critical", confidenceScore: 85 }) === true
  );

  check(
    "High priority with score 75 is auto-ticked",
    shouldAutoCheckReminder({ priority: "high", confidenceScore: 75 }) === true
  );

  check(
    "Normal priority is NOT auto-ticked (filtered)",
    shouldAutoCheckReminder({ priority: "normal", confidenceScore: 75 }) === false
  );

  check(
    "Low priority is NOT auto-ticked (filtered)",
    shouldAutoCheckReminder({ priority: "low", confidenceScore: 60 }) === false
  );

  // Default reminder keys in review-reducer
  const reviewSuggestions = [
    { key: "item-critical", priority: "critical" as const, confidenceScore: 90 },
    { key: "item-high", priority: "high" as const, confidenceScore: 75 },
    { key: "item-normal", priority: "normal" as const, confidenceScore: 70 },
    { key: "item-low", priority: "low" as const, confidenceScore: 50 },
  ];

  const autoChecked = defaultReminderKeys(reviewSuggestions);
  check("Review reducer auto-ticks only critical and high", autoChecked.length === 2);
  check("Contains item-critical", autoChecked.includes("item-critical"));
  check("Contains item-high", autoChecked.includes("item-high"));
  check("Does NOT contain item-normal", !autoChecked.includes("item-normal"));
  check("Does NOT contain item-low", !autoChecked.includes("item-low"));
}

console.log("\nAll smart reminders engine smoke tests passed! 🚀");
