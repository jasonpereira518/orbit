# Cold-start closeness — open questions after implementation

**Date:** 2026-08-21
**Branch:** `claude/orbit-cold-start-1edbae` (27 commits from `f8fe260`)
**Spec:** [2026-08-21-cold-start-closeness-design.md](2026-08-21-cold-start-closeness-design.md)

The plan is fully implemented and every review finding is addressed. This file records what a
whole-branch review left open, so the decisions do not die with the scratch workspace.

## Two product decisions

### 1. Unmeasured guesses out-rank measured-quiet contacts at scale

The most significant open question on the branch, and it is architectural rather than a bug.

On a realistic mailbox sync — 1,800 never-contacted imports plus 200 contacts with real email
history — only **10 of the top 100 by closeness are people you have actually emailed**. The
emailed cohort's median rank is **1,587 of 2,000**: 60 of them sit in ring 1 while 1,493
never-contacted strangers sit in ring 3.

Rings 4 and 5 stay correctly reserved (44 contacts, all emailed), so the inner constellation is
honest. But the mid-field is dominated by people the user has never contacted.

The cause: a contact with measured-but-quiet behaviour scores below an unmeasured guess, because
the prior's floor is `PRIOR_MIN = 0.30` while a genuinely quiet contact's evidenced score can fall
below that. This is pre-existing — measured identically before the final fix wave (2 of the top
100, median 1,262) — and it is the mirror image of the demotion bug that wave fixed.

**The decision:** whether "we know you rarely talk to this person" should be allowed to rank below
"we know nothing about this person." Lowering `PRIOR_MIN` would fix it and re-flatten the cold
orbit; the real answer is probably that quiet-but-measured needs its own treatment rather than
competing on the same axis.

### 2. A second `stated_closeness` leak in the AI-capture path

`src/actions/capture.ts:476-477` (merge) and `:495-498` (create) write
`statedCloseness: input.relationshipScore`, where the review UI defaults that field to
`parsed.relationship_score_suggestion || 2` (`src/components/chat/bulk-notes-panel.tsx:443`) and
always submits it.

So capturing a note about an already-imported contact stamps `stated_closeness` from an **AI
guess** — or a bare `2` — which marks them rated and makes them permanently ineligible for triage.

This is the same shape as the contact-form leak that was fixed (finding I2), and it is weaker: the
value is visible on a review card the user accepts, so it is not entirely silent. It was out of
scope for the final fix wave and was not introduced by it.

**The decision:** whether an AI-suggested closeness score counts as a user rating. If it does not,
capture should send `statedCloseness` only when the user actually moved the control, exactly as
`contact-form.tsx` now does via its `strengthRated` flag.

## Three engineering residuals

**`raw === evidenced` is exact only when goals are active.** `src/lib/closeness.ts:381-384`. With
no active goals, `knownWeight` and `applicableWeight` are not the same double, so
`knownWeightShare` reads `1.0000000000000002` and `raw − evidenced` is `1.11e-16`. The harness
asserts at `1e-9` and passes; the docstring says "exactly". Deterministic, so ties still tie.
Fix by short-circuiting when `knownWeight === applicableWeight`, or soften the docstring.

**A deliberate 2/5 is awkward to enter through the contact form.** `contact-form.tsx:410` sets
`strengthRated` only on a value-changing input event, and the field already renders `2` for an
unrated contact — so retyping "2" is suppressed by React's change dedupe and the user must move the
value away and back. Combined with `resolveStatedStrength` ignoring `relationshipScore === 2`,
"not close" is the one rating the form makes hard to record.

**`knowsBehaviour` requires `lastInteractionAt` non-null as well as an interaction row**
(`src/lib/closeness.ts:332`). A contact with interaction rows but a null stamp would count
interaction evidence while recency and cadence fall back to the prior, which could put
`evidence === 1` alongside `knownWeightShare < 1` and break the §13 invariant. No current write
path produces that shape — `contactInsertValues` always stamps — so this is theoretical, but it is
the kind of shape a future migration or backfill could introduce.

## Not verified by machine

Findings I1 (the wizard's `triage` step whitelist) and I2 (the contact-form rating leak) are
runtime-behaviour fixes verified by reading write paths, not by driving the UI. The `strengthRated`
state machine in particular has UI-event semantics that static reading cannot settle. **Worth a
manual pass through the wizard and the contact form before shipping.**

## Deferred minors, judged shippable

Triaged by the whole-branch review as safe to ship: `setup-db.ts` row-shape duplication; smoke §10's
first check having no regression power on its own; the `Infinity` assertions in §11/§12 not being
true regression tests; the undocumented `coverage === 0` convention; `closeness-cohort.ts`'s file
size and mixed concerns in `buildCohortResult`; `windowCalendarEvents`' inline literals; the
`wizard-triage.tsx` retry unmount guard; the "Recommended" badge's missing heading association; and
the pre-existing `ai_suggestions.related_contact_ids` missing FK.
