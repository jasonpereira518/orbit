/**
 * Scoring, the five hard filters, fusion, and weight clamping. No DB, no network.
 *
 * Run: npx tsx scripts/smoke-follow-up-scoring.ts
 */
import {
  contactWeight,
  fuse,
  isSuppressed,
  recencyFit,
  refutedByRecentContact,
  scoreCandidates,
  userWeight,
  WEIGHT_MAX,
  WEIGHT_MIN,
  type Suppression,
  type WeightRow,
} from "../src/lib/follow-ups/score";
import { SIGNAL_TRIGGER } from "../src/lib/follow-ups/registry";
import type { ContactSnapshot, SignalCandidate } from "../src/lib/follow-ups/types";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const NOW = new Date("2026-09-09T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const ago = (d: number) => new Date(NOW.getTime() - d * DAY);

function contact(over: Partial<ContactSnapshot> = {}): ContactSnapshot {
  return {
    id: "c1",
    fullName: "Priya Raman",
    preferredName: null,
    title: null,
    company: null,
    closenessTier: "mid",
    priorityLevel: 0,
    relationshipScore: 2,
    constellationPin: null,
    dateMet: ago(400),
    firstInteractionAt: ago(400),
    lastInteractionAt: ago(200),
    nextFollowUpAt: null,
    ...over,
  };
}

function candidate(over: Partial<SignalCandidate> = {}): SignalCandidate {
  return { kind: "dormant", contactId: "c1", evidence: "quiet", dueOn: NOW, ...over };
}

function input(over: Partial<Parameters<typeof scoreCandidates>[0]> = {}) {
  const c = contact();
  return {
    now: NOW,
    candidates: [candidate()],
    contactsById: new Map([[c.id, c]]),
    suppressions: [] as Suppression[],
    weightsByKind: new Map<string, WeightRow>(),
    contactsWithPendingReminder: new Set<string>(),
    contactsWithPendingSuggestion: new Set<string>(),
    ...over,
  };
}

console.log("\ncontactWeight");
{
  check(
    "an outer, unprioritized contact sits at the floor",
    Math.abs(contactWeight(contact({ closenessTier: "outer" })) - 0.8) < 1e-9
  );
  check("inner tier lifts it", Math.abs(contactWeight(contact({ closenessTier: "inner" })) - 1.1) < 1e-9);
  check(
    "priority is capped at 3 so it cannot dominate",
    Math.abs(contactWeight(contact({ closenessTier: "inner", priorityLevel: 9 })) - 1.4) < 1e-9
  );
}

console.log("\nrecencyFit");
{
  check("date-triggered kinds ignore idleness", recencyFit("birthday", 0) === 1);
  check("a fresh staleness signal is discounted", Math.abs(recencyFit("dormant", 0) - 0.7) < 1e-9);
  check(
    "it saturates rather than growing without bound",
    Math.abs(recencyFit("dormant", 10_000) - recencyFit("dormant", 180)) < 1e-9
  );
}

console.log("\nuserWeight");
{
  check("an unseen kind is neutral", userWeight(undefined, 0.2) === 1);
  const young: WeightRow = { kind: "dormant", weight: 1, shown: 4, accepted: 0, dismissed: 4 };
  check("a kind shown only 4 times stays pinned at 1.0", userWeight(young, 0.2) === 1);
  const boundary: WeightRow = { kind: "dormant", weight: 1, shown: 5, accepted: 0, dismissed: 5 };
  const boundaryResult = userWeight(boundary, 0.2);
  check("at the boundary (shown: 5), a kind is unpinned and computed", boundaryResult !== 1);
  check("the computed weight for shown: 5 with 0 accepts is damped", Math.abs(boundaryResult - 5 / 7) < 1e-9);
  const hated: WeightRow = { kind: "dormant", weight: 1, shown: 40, accepted: 0, dismissed: 40 };
  check("a consistently dismissed kind is damped", userWeight(hated, 0.5) < 0.5);
  check("but never below the floor", userWeight(hated, 0.5) >= WEIGHT_MIN);
  const loved: WeightRow = { kind: "birthday", weight: 1, shown: 40, accepted: 40, dismissed: 0 };
  check("a consistently accepted kind is boosted but capped", userWeight(loved, 0.05) === WEIGHT_MAX);
}

console.log("\nfuse");
{
  check("one signal fuses to itself", Math.abs(fuse([80]) - 80) < 1e-9);
  check("a second signal adds 15% of it", Math.abs(fuse([80, 40]) - 86) < 1e-9);
  check("fusion cannot exceed 1.5x the strongest", Math.abs(fuse([80, 80, 80, 80, 80, 80]) - 120) < 1e-9);
  check("no signals is zero", fuse([]) === 0);
}

console.log("\nfilter 1 — recent contact refutes staleness");
{
  check("dormant is refuted 3 days after contact", refutedByRecentContact("dormant", 3));
  check("open_loop is refuted 3 days after contact", refutedByRecentContact("open_loop", 3));
  check("post_event is refuted 3 days after contact", refutedByRecentContact("post_event", 3));
  check("never_contacted is refuted 3 days after contact", refutedByRecentContact("never_contacted", 3));
  check("thread_quiet is refuted 3 days after contact", refutedByRecentContact("thread_quiet", 3));

  check("a birthday survives recent contact", !refutedByRecentContact("birthday", 1));
  check("a commitment survives recent contact", !refutedByRecentContact("commitment_due", 1));
  check("a scheduled follow-up survives recent contact", !refutedByRecentContact("scheduled_follow_up", 1));
  check("a work anniversary survives recent contact", !refutedByRecentContact("work_anniversary", 1));
  check("a met anniversary survives recent contact", !refutedByRecentContact("met_anniversary", 1));

  check("exactly 7 days is outside the window", !refutedByRecentContact("dormant", 7));
  check("never having spoken is not recent contact", !refutedByRecentContact("dormant", null));

  // Regression loop: verify staleness/date classification for all signal kinds.
  check(
    "SIGNAL_TRIGGER registry covers exactly 13 kinds",
    Object.keys(SIGNAL_TRIGGER).length === 13
  );
  for (const kind of Object.keys(SIGNAL_TRIGGER) as Array<keyof typeof SIGNAL_TRIGGER>) {
    const trigger = SIGNAL_TRIGGER[kind];
    if (trigger === "staleness") {
      check(
        `${kind} (staleness trigger) is refuted by recent contact`,
        refutedByRecentContact(kind, 3) === true
      );
    } else if (trigger === "date") {
      check(
        `${kind} (date trigger) survives recent contact`,
        refutedByRecentContact(kind, 3) === false
      );
    }
  }

  // End to end through scoreCandidates.
  const fresh = contact({ lastInteractionAt: ago(2) });
  const out = scoreCandidates(input({ contactsById: new Map([[fresh.id, fresh]]) }));
  check("scoreCandidates drops a refuted staleness signal", out.length === 0);

  const bday = scoreCandidates(
    input({
      contactsById: new Map([[fresh.id, fresh]]),
      candidates: [candidate({ kind: "birthday", evidence: "turns 40 Thursday" })],
    })
  );
  check("scoreCandidates keeps a date signal after recent contact", bday.length === 1);
}

console.log("\nfilter 2 — suppressions");
{
  const future = new Date(NOW.getTime() + 30 * DAY);
  check("a live contact+kind suppression matches", isSuppressed("dormant", "c1", [{ contactId: "c1", kind: "dormant", until: future }], NOW));
  check("an expired one does not", !isSuppressed("dormant", "c1", [{ contactId: "c1", kind: "dormant", until: ago(1) }], NOW));
  check("a null `until` is a permanent mute", isSuppressed("dormant", "c1", [{ contactId: "c1", kind: null, until: null }], NOW));
  check("a kind-wide mute matches any contact", isSuppressed("dormant", "whoever", [{ contactId: null, kind: "dormant", until: null }], NOW));
  check("it does not match a different kind", !isSuppressed("birthday", "c1", [{ contactId: null, kind: "dormant", until: null }], NOW));
  check("it does not match a different contact", !isSuppressed("dormant", "c2", [{ contactId: "c1", kind: "dormant", until: null }], NOW));
}

console.log("\nfilters 3-5");
{
  const pinnedOut = contact({ constellationPin: "out" });
  check(
    "a contact pinned off the constellation never surfaces",
    scoreCandidates(input({ contactsById: new Map([[pinnedOut.id, pinnedOut]]) })).length === 0
  );
  check(
    "an existing pending reminder blocks a suggestion",
    scoreCandidates(input({ contactsWithPendingReminder: new Set(["c1"]) })).length === 0
  );
  check(
    "an existing pending suggestion blocks a second",
    scoreCandidates(input({ contactsWithPendingSuggestion: new Set(["c1"]) })).length === 0
  );
  check(
    "a candidate for an unknown contact is skipped",
    scoreCandidates(input({ candidates: [candidate({ contactId: "ghost" })] })).length === 0
  );
}

console.log("\nfusion and ordering through scoreCandidates");
{
  const c = contact();
  const two = scoreCandidates(
    input({
      contactsById: new Map([[c.id, c]]),
      candidates: [
        candidate({ kind: "dormant", evidence: "quiet 200 days" }),
        candidate({ kind: "birthday", evidence: "turns 40 Thursday", dueOn: new Date(NOW.getTime() + 2 * DAY) }),
      ],
    })
  );
  check("two signals on one contact produce ONE row", two.length === 1);
  check("both signals are recorded", two[0].signals.length === 2);
  check("the stronger signal becomes primary", two[0].primaryKind === "birthday");
  check("the winning signal owns the surfacing date", two[0].dueOn.getTime() === NOW.getTime() + 2 * DAY);
  check("signals are stored strongest-first", two[0].signals[0].kind === "birthday");

  const a = contact({ id: "a", closenessTier: "inner", priorityLevel: 3 });
  const b = contact({ id: "b", closenessTier: "outer", priorityLevel: 0 });
  const ranked = scoreCandidates(
    input({
      contactsById: new Map([[a.id, a], [b.id, b]]),
      candidates: [candidate({ contactId: "a" }), candidate({ contactId: "b" })],
    })
  );
  check("the closer, higher-priority contact ranks first", ranked[0].contactId === "a");

  const many = Array.from({ length: 40 }, (_, i) => contact({ id: `m${i}` }));
  const capped = scoreCandidates(
    input({
      contactsById: new Map(many.map((m) => [m.id, m])),
      candidates: many.map((m) => candidate({ contactId: m.id })),
    })
  );
  check("the shortlist is cut to 12", capped.length === 12);
}

console.log("\nAll follow-up scoring checks passed.\n");
