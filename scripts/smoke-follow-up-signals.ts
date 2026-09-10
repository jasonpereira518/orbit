/**
 * Every follow-up signal source, against fixture contexts. No DB, no network.
 *
 * Sources are pure functions over a preloaded SignalContext precisely so this file can
 * exist: thirteen detectors, zero database.
 *
 * Run: npx tsx scripts/smoke-follow-up-signals.ts
 */
import { DAILY_SOURCES } from "../src/lib/follow-ups/sources";
import { commitmentDueSource } from "../src/lib/follow-ups/sources/commitment-due";
import { dormantSource } from "../src/lib/follow-ups/sources/dormant";
import { neverContactedSource } from "../src/lib/follow-ups/sources/never-contacted";
import { looksLikeOpenAsk, openLoopSource } from "../src/lib/follow-ups/sources/open-loop";
import { postEventSource } from "../src/lib/follow-ups/sources/post-event";
import { scheduledFollowUpSource } from "../src/lib/follow-ups/sources/scheduled-follow-up";
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

  // Boundary pairs pin the comparison operator exactly: an off-by-one here means
  // nagging someone a day early, or staying silent a day past the documented threshold.
  const innerBoundary = dormantSource.detect(
    ctx({
      contacts: [
        contact({ id: "inner29", closenessTier: "inner", lastInteractionAt: ago(29) }),
        contact({ id: "inner30", closenessTier: "inner", lastInteractionAt: ago(30) }),
      ],
    })
  );
  check(
    "inner tier: idle 29 days does not fire (threshold 30)",
    !innerBoundary.some((c) => c.contactId === "inner29")
  );
  check(
    "inner tier: idle 30 days fires (threshold 30)",
    innerBoundary.some((c) => c.contactId === "inner30")
  );

  const midBoundary = dormantSource.detect(
    ctx({
      contacts: [
        contact({ id: "mid89", closenessTier: "mid", lastInteractionAt: ago(89) }),
        contact({ id: "mid90", closenessTier: "mid", lastInteractionAt: ago(90) }),
      ],
    })
  );
  check(
    "mid tier: idle 89 days does not fire (threshold 90)",
    !midBoundary.some((c) => c.contactId === "mid89")
  );
  check(
    "mid tier: idle 90 days fires (threshold 90)",
    midBoundary.some((c) => c.contactId === "mid90")
  );

  const outerBoundary = dormantSource.detect(
    ctx({
      contacts: [
        contact({ id: "outer179", closenessTier: "outer", lastInteractionAt: ago(179) }),
        contact({ id: "outer180", closenessTier: "outer", lastInteractionAt: ago(180) }),
      ],
    })
  );
  check(
    "outer tier: idle 179 days does not fire (threshold 180)",
    !outerBoundary.some((c) => c.contactId === "outer179")
  );
  check(
    "outer tier: idle 180 days fires (threshold 180)",
    outerBoundary.some((c) => c.contactId === "outer180")
  );

  // A single idle=100 fixture only proved the fallback wasn't `outer` (180): it clears
  // both `inner` (30) and `mid` (90), so it would also pass if the fallback were wrongly
  // `inner`. This pair straddles the mid threshold to pin the fallback to exactly `mid`.
  const unknownBelowMid = contact({ id: "unkBelowMid", closenessTier: null, lastInteractionAt: ago(60) });
  check(
    "unclassified tier: idle 60 does not fire (falls back to mid threshold 90, not inner 30)",
    dormantSource.detect(ctx({ contacts: [unknownBelowMid] })).length === 0
  );

  const unknownAboveMid = contact({ id: "unkAboveMid", closenessTier: null, lastInteractionAt: ago(95) });
  check(
    "unclassified tier: idle 95 fires (falls back to mid threshold 90, not outer 180)",
    dormantSource.detect(ctx({ contacts: [unknownAboveMid] })).length === 1
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

  // Boundary pairs on both ends of the quiet window.
  const quiet13 = new Map([["q", [msg({ contactId: "q", interactionDate: ago(13) }), msg({ contactId: "q", interactionDate: ago(20) })]]]);
  check(
    "thread quiet 13 days does not fire (lower bound 14)",
    threadQuietSource.detect(ctx({ contacts: [c], interactionsByContact: quiet13 })).length === 0
  );

  const quiet14 = new Map([["q", [msg({ contactId: "q", interactionDate: ago(14) }), msg({ contactId: "q", interactionDate: ago(20) })]]]);
  check(
    "thread quiet 14 days fires (lower bound 14)",
    threadQuietSource.detect(ctx({ contacts: [c], interactionsByContact: quiet14 })).length === 1
  );

  const quiet90 = new Map([["q", [msg({ contactId: "q", interactionDate: ago(90) }), msg({ contactId: "q", interactionDate: ago(95) })]]]);
  check(
    "thread quiet 90 days fires (upper bound 90)",
    threadQuietSource.detect(ctx({ contacts: [c], interactionsByContact: quiet90 })).length === 1
  );

  const quiet91 = new Map([["q", [msg({ contactId: "q", interactionDate: ago(91) }), msg({ contactId: "q", interactionDate: ago(95) })]]]);
  check(
    "thread quiet 91 days does not fire (upper bound 90)",
    threadQuietSource.detect(ctx({ contacts: [c], interactionsByContact: quiet91 })).length === 0
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

  const saved13 = contact({ id: "sv13", lastInteractionAt: null, dateMet: ago(13) });
  check(
    "saved 13 days ago does not fire (grace period 14)",
    neverContactedSource.detect(ctx({ contacts: [saved13] })).length === 0
  );

  const saved14 = contact({ id: "sv14", lastInteractionAt: null, dateMet: ago(14) });
  check(
    "saved 14 days ago fires (grace period 14)",
    neverContactedSource.detect(ctx({ contacts: [saved14] })).length === 1
  );
}

console.log("\nregistry");
{
  const kinds = DAILY_SOURCES.map((s) => s.kind);
  check("no duplicate kinds in DAILY_SOURCES", new Set(kinds).size === kinds.length);
  check("every source is a pure detect function", DAILY_SOURCES.every((s) => typeof s.detect === "function"));
}

console.log("\ncommitment_due");
{
  const c = contact({ id: "cd" });
  const due = ctx({
    contacts: [c],
    dueCommitments: [{ contactId: "cd", title: "Send the deck", dueDate: ago(1) }],
  });
  const found = commitmentDueSource.detect(due);
  check("a commitment past its date fires", found.length === 1);
  check("the evidence quotes the commitment", found[0].evidence.includes("Send the deck"));

  const future = ctx({
    contacts: [c],
    dueCommitments: [{ contactId: "cd", title: "Send the deck", dueDate: new Date(NOW.getTime() + DAY) }],
  });
  check("a commitment due tomorrow does not fire today", commitmentDueSource.detect(future).length === 0);

  // A commitment whose contact was deleted must not produce an orphan suggestion.
  const orphan = ctx({
    contacts: [],
    dueCommitments: [{ contactId: "gone", title: "x", dueDate: ago(1) }],
  });
  check("a commitment for an unknown contact is skipped", commitmentDueSource.detect(orphan).length === 0);
}

console.log("\nscheduled_follow_up");
{
  const dueToday = contact({ id: "sf", nextFollowUpAt: ago(0) });
  check("a follow-up dated today fires", scheduledFollowUpSource.detect(ctx({ contacts: [dueToday] })).length === 1);

  const later = contact({ id: "sf2", nextFollowUpAt: new Date(NOW.getTime() + 5 * DAY) });
  check("a follow-up five days out does not fire", scheduledFollowUpSource.detect(ctx({ contacts: [later] })).length === 0);

  const none = contact({ id: "sf3", nextFollowUpAt: null });
  check("no scheduled date means no signal", scheduledFollowUpSource.detect(ctx({ contacts: [none] })).length === 0);
}

console.log("\npost_event");
{
  const intro = contact({ id: "pe", firstInteractionAt: ago(10), lastInteractionAt: ago(10), dateMet: ago(10) });
  check("a 10-day-old intro with nothing since fires", postEventSource.detect(ctx({ contacts: [intro] })).length === 1);

  const followed = contact({ id: "pe2", firstInteractionAt: ago(10), lastInteractionAt: ago(2), dateMet: ago(10) });
  check("an intro already followed up does not fire", postEventSource.detect(ctx({ contacts: [followed] })).length === 0);

  const tooFresh = contact({ id: "pe3", firstInteractionAt: ago(2), lastInteractionAt: ago(2), dateMet: ago(2) });
  check("a 2-day-old intro is still inside the window", postEventSource.detect(ctx({ contacts: [tooFresh] })).length === 0);

  // Trigger B: the events path the old heuristic had no access to.
  const attendee = contact({ id: "ev", firstInteractionAt: ago(300), lastInteractionAt: ago(300), dateMet: ago(300) });
  const events = new Map([
    ["ev", [{ contactId: "ev", eventId: "e1", title: "SaaS Summit", startsAt: ago(6) }]],
  ]);
  const found = postEventSource.detect(ctx({ contacts: [attendee], eventsByContact: events }));
  check("shared event attendance fires", found.length === 1);
  check("the evidence names the event", found[0].evidence.includes("SaaS Summit"));

  const spokenSince = contact({ id: "ev2", firstInteractionAt: ago(300), lastInteractionAt: ago(1), dateMet: ago(300) });
  const events2 = new Map([
    ["ev2", [{ contactId: "ev2", eventId: "e2", title: "SaaS Summit", startsAt: ago(6) }]],
  ]);
  check(
    "having spoken since the event suppresses it",
    postEventSource.detect(ctx({ contacts: [spokenSince], eventsByContact: events2 })).length === 0
  );
}

console.log("\nopen_loop");
{
  const c = contact({ id: "ol" });

  const inboundQuestion = new Map([
    ["ol", [msg({ contactId: "ol", direction: "in", text: "Any chance you could intro me to Dana?", interactionDate: ago(12) })]],
  ]);
  const found = openLoopSource.detect(ctx({ contacts: [c], interactionsByContact: inboundQuestion }));
  check("an inbound ask 12 days old fires", found.length === 1);

  const outbound = new Map([
    ["ol", [msg({ contactId: "ol", direction: "out", text: "Any chance you could intro me to Dana?", interactionDate: ago(12) })]],
  ]);
  check(
    "the same text sent BY the user is not an open loop",
    openLoopSource.detect(ctx({ contacts: [c], interactionsByContact: outbound })).length === 0
  );

  const chitchat = new Map([
    ["ol", [msg({ contactId: "ol", direction: "in", text: "great seeing you", interactionDate: ago(12) })]],
  ]);
  check(
    "an inbound message with no ask does not fire",
    openLoopSource.detect(ctx({ contacts: [c], interactionsByContact: chitchat })).length === 0
  );

  const tooRecent = new Map([
    ["ol", [msg({ contactId: "ol", direction: "in", text: "can you send that over?", interactionDate: ago(2) })]],
  ]);
  check(
    "an ask from 2 days ago is inside the grace window",
    openLoopSource.detect(ctx({ contacts: [c], interactionsByContact: tooRecent })).length === 0
  );

  // The legacy-import case. This is the one that must not guess.
  const legacyNoItems = new Map([
    ["ol", [msg({ contactId: "ol", direction: null, text: "can you send that over?", interactionDate: ago(12) })]],
  ]);
  check(
    "all-null directions with no action items does NOT fire on a question mark alone",
    openLoopSource.detect(ctx({ contacts: [c], interactionsByContact: legacyNoItems })).length === 0
  );

  const legacyWithItems = new Map([
    ["ol", [msg({ contactId: "ol", direction: null, text: "we talked", actionItems: ["Send Priya the deck"], interactionDate: ago(12) })]],
  ]);
  const legacyFound = openLoopSource.detect(ctx({ contacts: [c], interactionsByContact: legacyWithItems }));
  check("all-null directions WITH an action item fires", legacyFound.length === 1);
  check("the fallback evidence quotes the item", legacyFound[0].evidence.includes("Send Priya the deck"));

  // A thread with SOME direction data uses the precise path, not the fallback.
  const mixed = new Map([
    ["ol", [
      msg({ contactId: "ol", direction: "out", text: "here you go", interactionDate: ago(12) }),
      msg({ contactId: "ol", direction: null, text: "?", actionItems: ["x"], interactionDate: ago(40) }),
    ]],
  ]);
  check(
    "a partially-directioned thread uses the precise path and stays silent",
    openLoopSource.detect(ctx({ contacts: [c], interactionsByContact: mixed })).length === 0
  );
}

console.log("\nlooksLikeOpenAsk");
{
  check("a question mark counts", looksLikeOpenAsk("thoughts?"));
  check("a soft ask phrase counts", looksLikeOpenAsk("let me know when you have a minute"));
  check("a statement does not", !looksLikeOpenAsk("Congrats on the launch"));
  check("empty text does not", !looksLikeOpenAsk("   "));
}

console.log("\nAll follow-up signal checks passed.\n");
