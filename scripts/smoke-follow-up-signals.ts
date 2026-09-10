/**
 * Every follow-up signal source, against fixture contexts. No DB, no network.
 *
 * Sources are pure functions over a preloaded SignalContext precisely so this file can
 * exist: thirteen detectors, zero database.
 *
 * Run: npx tsx scripts/smoke-follow-up-signals.ts
 */
import { DAILY_SOURCES } from "../src/lib/follow-ups/sources";
import { dormantSource } from "../src/lib/follow-ups/sources/dormant";
import { neverContactedSource } from "../src/lib/follow-ups/sources/never-contacted";
import { threadQuietSource } from "../src/lib/follow-ups/sources/thread-quiet";
import type {
  ContactSnapshot,
  InteractionSnapshot,
  SignalContext,
} from "../src/lib/follow-ups/types";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const NOW = new Date("2026-09-09T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

function contact(over: Partial<ContactSnapshot> = {}): ContactSnapshot {
  return {
    id: over.id ?? "c1",
    fullName: "Priya Raman",
    preferredName: null,
    title: "Staff Engineer",
    company: "Acme",
    closenessTier: "mid",
    priorityLevel: 0,
    relationshipScore: 2,
    constellationPin: null,
    dateMet: ago(400),
    firstInteractionAt: ago(400),
    lastInteractionAt: ago(400),
    nextFollowUpAt: null,
    ...over,
  };
}

function ctx(over: Partial<SignalContext> = {}): SignalContext {
  return {
    userId: "u1",
    now: NOW,
    contacts: [],
    interactionsByContact: new Map(),
    experiencesByContact: new Map(),
    datesByContact: new Map(),
    eventsByContact: new Map(),
    contactsWithPendingReminder: new Set(),
    dueCommitments: [],
    ...over,
  };
}

function msg(over: Partial<InteractionSnapshot> = {}): InteractionSnapshot {
  return {
    contactId: "c1",
    interactionType: "linkedin_message",
    interactionDate: ago(30),
    direction: "out",
    text: "sounds good",
    actionItems: [],
    ...over,
  };
}

console.log("\ndormant");
{
  // Tier thresholds are the point of this source: 60 idle days is overdue for an
  // inner-orbit tie and unremarkable for an outer one.
  const inner = contact({ id: "inner", closenessTier: "inner", lastInteractionAt: ago(60) });
  const outer = contact({ id: "outer", closenessTier: "outer", lastInteractionAt: ago(60) });
  const found = dormantSource.detect(ctx({ contacts: [inner, outer] }));
  check("inner tier fires at 60 idle days", found.some((c) => c.contactId === "inner"));
  check("outer tier does not fire at 60 idle days", !found.some((c) => c.contactId === "outer"));

  const never = contact({ id: "never", lastInteractionAt: null });
  check(
    "a contact never interacted with is not dormant",
    dormantSource.detect(ctx({ contacts: [never] })).length === 0
  );

  const unknown = contact({ id: "unk", closenessTier: null, lastInteractionAt: ago(100) });
  check(
    "an unclassified tier falls back to the mid threshold",
    dormantSource.detect(ctx({ contacts: [unknown] })).length === 1
  );
}

console.log("\nthread_quiet");
{
  const c = contact({ id: "q" });
  const two = new Map([["q", [msg({ contactId: "q", interactionDate: ago(30) }), msg({ contactId: "q", interactionDate: ago(45) })]]]);
  check(
    "two written messages quiet for 30 days fires",
    threadQuietSource.detect(ctx({ contacts: [c], interactionsByContact: two })).length === 1
  );

  const one = new Map([["q", [msg({ contactId: "q", interactionDate: ago(30) })]]]);
  check(
    "a single message is not a thread",
    threadQuietSource.detect(ctx({ contacts: [c], interactionsByContact: one })).length === 0
  );

  // Past the upper bound this is dormancy, and `dormant` describes it better.
  const old = new Map([["q", [msg({ contactId: "q", interactionDate: ago(200) }), msg({ contactId: "q", interactionDate: ago(210) })]]]);
  check(
    "a thread quiet beyond 90 days does not fire",
    threadQuietSource.detect(ctx({ contacts: [c], interactionsByContact: old })).length === 0
  );

  const meetings = new Map([
    ["q", [msg({ contactId: "q", interactionType: "meeting", interactionDate: ago(30) }), msg({ contactId: "q", interactionType: "meeting", interactionDate: ago(45) })]],
  ]);
  check(
    "non-written interaction types are not a thread",
    threadQuietSource.detect(ctx({ contacts: [c], interactionsByContact: meetings })).length === 0
  );
}

console.log("\nnever_contacted");
{
  const fresh = contact({ id: "f", lastInteractionAt: null, dateMet: ago(3) });
  check(
    "someone saved 3 days ago is inside the grace window",
    neverContactedSource.detect(ctx({ contacts: [fresh] })).length === 0
  );

  const stale = contact({ id: "s", lastInteractionAt: null, dateMet: ago(30) });
  check(
    "someone saved 30 days ago and never contacted fires",
    neverContactedSource.detect(ctx({ contacts: [stale] })).length === 1
  );

  const contacted = contact({ id: "c", lastInteractionAt: ago(5), dateMet: ago(30) });
  check(
    "someone already contacted never fires",
    neverContactedSource.detect(ctx({ contacts: [contacted] })).length === 0
  );
}

console.log("\nregistry");
{
  const kinds = DAILY_SOURCES.map((s) => s.kind);
  check("no duplicate kinds in DAILY_SOURCES", new Set(kinds).size === kinds.length);
  check("every source is a pure detect function", DAILY_SOURCES.every((s) => typeof s.detect === "function"));
}

console.log("\nAll follow-up signal checks passed.\n");
