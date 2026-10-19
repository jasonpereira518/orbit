# Launch Phase 4 — Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every section-C polish finding and the low-severity leftovers from the 2026-09-15 audit, so capture, search, touch targets, copy, setup docs and data hygiene say and do true things.
**Architecture:** Mostly pure helpers extracted next to the code that needs them (capture review math in `src/lib/capture/review-reducer.ts` and `src/lib/note-batches.ts`, search tiers in a new `src/lib/contact-search-rank.ts`), each pinned by a tsx smoke, with thin wiring edits in components, actions and the daily cron. One batched schema bump at the end carries the two data migrations (calendar feed tokens hashed in place, AI-derived interactions tagged).
**Tech Stack:** Next.js 16 App Router, TypeScript, Drizzle over Neon (neon-http) / PGlite, Clerk, Stripe, tsx smoke scripts
**Spec:** docs/production-readiness-audit-2026-09-15.md (items: C1, C2, C3, C5, C6, C7, C8, and the low-severity leftovers: calendar feed token at rest, interest-list IP logging, parse-profile model-output logging, save-time auto-merge, AI-derived timeline interactions, abandoned meeting transcripts and expired scan handoffs)
**Roadmap:** docs/superpowers/plans/2026-09-15-launch-readiness-roadmap.md

## Global Constraints

- Branch: create `claude/launch-<phase>` off `origin/main` in a fresh worktree; run `npm ci` in it (worktrees share no node_modules). Commit after every task; commit messages end with the line `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- Next.js 16 has breaking changes versus common training data: before using any Next API (route handlers, `proxy.ts`, `after()`, server actions, config), read the matching guide under `node_modules/next/dist/docs/`.
- Tests are tsx smoke scripts `scripts/smoke-<name>.ts`, each an executable spec that prints `ok`/`FAIL` lines and exits nonzero on failure. Pure scripts touch no database. Database scripts MUST start with `import "./smoke/_env";` (deletes DATABASE_URL, uses a throwaway PGlite dir) and wrap main in `run()` from that module. EVERY new smoke script must be added to `MANIFEST` in `scripts/run-smoke.ts` with tier `"pure"` or `"pglite"` or the whole suite refuses to run. Run one: `npx tsx scripts/smoke-<name>.ts`. Run all: `npm test`.
- Every task ends green on: the task's smoke script, `npm run typecheck`, `npm run lint` (baseline is 0 errors; any error is yours), and `npx tsx scripts/smoke-toast-copy.ts` when user-facing copy changed.
- tsx scripts must exit explicitly (`run()` or `process.exit(0)`); PGlite keeps the loop alive. Never import `next/server` into a low-level `src/lib/*` module that scripts import — the import alone hangs every script.
- A `"use server"` module may export ONLY async functions; a const/type export silently breaks every export in it. Put shared constants/types in `src/lib/*-types.ts`.
- A client component must not import anything that reaches `@/db` (build fails with a node:fs chunk error). Pure metadata goes in a DB-free module.
- User-facing errors: throw `new UserFacingError("…")` for copy you want shown; across a server-action boundary return it as data via `asActionResult`; catch sites use `friendlyError(err, fallback)` from `src/lib/errors.ts`, never `err.message`. Toast/copy voice (enforced by `scripts/smoke-toast-copy.ts`): curly apostrophes (’), "Couldn’t" not "Could not", never the word "failed", no trailing period, " — " as the one connector.
- Drizzle: use bare `.returning()` (partial returning does not typecheck across the driver union); read `db.execute()` results with `rowsOf<T>()` from `@/db`; `db.transaction` does not exist on neon-http — use `runAtomicWrite` (src/db/index.ts) or accept sequential idempotent writes; a column interpolated into a `sql```` template inside `.select()` loses its table prefix.
- Schema changes: table in `src/db/schema.ts`; `CREATE TABLE IF NOT EXISTS` in the `DDL` template in `src/db/index.ts` (the template has ZERO `--` comments, no backticks, no `;` inside comments — explanations go on the Drizzle table); new columns ALSO go in the `alters` list; new tables go in `EXPECTED_TABLES` in `scripts/setup-db.ts`; bump `export const SCHEMA_VERSION` with a changelog comment line; then `npx tsx scripts/smoke-schema-ddl.ts --update` and `npm run db:setup` (read the printed table list). NEVER hardcode the new version in the plan: compute it at execution time as one more than the highest value claimed by any remote branch:
  `git fetch -q --all && for b in $(git for-each-ref --format='%(refname:short)' refs/remotes/origin); do git show "${b}:src/db/index.ts" 2>/dev/null | grep -oE 'export const SCHEMA_VERSION = [0-9]+'; done | grep -oE '[0-9]+$' | sort -n | tail -1`
  (56 is already claimed by three open branches as of 2026-09-15.) Re-run the scan immediately before pushing. Never put backticks in comments inside the `alters`/`SCALE_DDL` arrays.
- Tailwind compiles utility classes it finds in comments: never write an arbitrary-value class (e.g. `w-[123px]`) in a code comment.
- UI changes are verified in the browser: start the `orbit-web` configuration from `.claude/launch.json` (port 3001, demo mode on local PGlite when no Clerk keys are set). Controlled React inputs must be driven with real keystrokes, not DOM value writes.
- Do not add dependencies unless a task explicitly says so and gives the exact package and version.
- Scope: implement only the audit items assigned to this plan. Do not refactor neighbours.

Plan-specific constraints:

- **Phase 0 must be merged before this branch is cut** (roadmap: Phase 4 runs "any time after Phase 0"). Task 11 (recruiter copy) additionally checks Phase 0's A8 fix is in the code and stops if it is not.
- **At most one schema bump, and it is Task 17, the last task.** Tasks 15 and 16 change code that the Task 17 migration makes consistent for rows that already exist; the three ship in one PR, so no deployed build ever runs one without the others.
- **Shared files other phases also touch:** `scripts/run-smoke.ts` (every phase adds smokes), `src/app/api/imports/process-stalled/route.ts` (Phase 3b alerting), `src/components/settings/ai-settings.tsx` (Phase 0 A9 key validation), `src/lib/recruiters.ts` / `src/components/recruiters/*` (Phase 0 and Phase 2 A8). Before opening the PR: `git fetch origin && git merge origin/main`, resolve, re-run `npm test`, and re-run the SCHEMA_VERSION scan.
- **Never run `scripts/eval-retrieval.ts`** from this worktree: it loads `.env.local` without the smoke preamble and would write to the shared Neon database.
- **PGlite has one writer.** Stop the `orbit-web` dev server before running any tsx command that writes to `.data/pglite` (the browser checks in Tasks 3 and 7 say when).
- **Line numbers are as of `origin/main` 33a213c.** Later tasks edit files earlier tasks already changed (`src/actions/contacts.ts` in Tasks 5, 6, 16; `src/lib/capture-job-runner.ts` in Tasks 3, 13; `scripts/run-smoke.ts` in most). When a quoted line has moved, find it by the quoted text, which is exact.
- Existing smokes that must stay green because these tasks touch their code: `smoke-date-commitments`, `smoke-note-batch`, `smoke-capture-jobs`, `smoke-capture-review-reducer`, `smoke-hybrid-search`, `smoke-contacts-page`, `smoke-page-budgets`, `smoke-scan-handoff`, `smoke-meeting-sessions`, `smoke-admin-actions`, `smoke-linkedin-timeline-backfill`, `smoke-constellation-signals`, `smoke-entitlements`, `smoke-recruiter-sharing`, `smoke-schema-upgrade`, `smoke-schema-ddl`. Each task names the ones it can break; `npm test` at the end of the plan runs them all.

---

### Task 1: The capture review quotes only skipped phrases that are in the note (C1, part a)

**Root cause (verified):** the "in a fortnight" in the audit was not a model hallucination. `SkippedNote` in `src/components/capture/suggested-reminders-review.tsx:170-173` prints the hard-coded example `("in a fortnight")` after *any* non-zero `relative` count. In the audit note the phrase that was really skipped is "by Friday" (the relative grammar in `src/lib/relative-date.ts` resolves `Friday` / `next Friday` / `on Friday` but not `by Friday`). `validateCommitments` already counts a phrase as `relative` only after it passed verbatim containment (`src/lib/date-commitment-extract.ts:252-258`); a phrase the model invented lands in `unverifiable`. So the fix is to carry the real, contained phrases through and quote those.

**Files:**
- Modify: `src/lib/date-commitment-extract.ts:42-55` (`RejectedCounts`, `emptyCommitmentResult`), `:130-132` (add a helper after `normalizeForMatch`), `:240` (rejected init), `:266-271` (relative rejection branch)
- Create: `src/lib/capture/skipped-note.ts`
- Modify: `src/components/capture/suggested-reminders-review.tsx:1-9` (imports), `:23` (prop type), `:159-189` (`SkippedNote`)
- Modify: `src/lib/note-batch-save.ts:128` (store counts only)
- Create: `scripts/smoke-capture-skipped-phrases.ts`
- Modify: `scripts/run-smoke.ts` (MANIFEST, pure section)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `RejectedCounts.relativePhrases?: string[]` (in `src/lib/date-commitment-extract.ts`); `skippedNoteText(skipped: RejectedCounts | null | undefined): string | null` (in `src/lib/capture/skipped-note.ts`). Task 3's smoke fixture uses `relativePhrases`.

- [ ] **Step 1: Write the failing test** — create `scripts/smoke-capture-skipped-phrases.ts`:

```ts
/**
 * The capture review's "Skipped …" line quotes only phrases that are really in the note.
 * It used to print a hard-coded example ("in a fortnight") whatever the note said. Fixture:
 * the note from the 2026-09-15 audit. Pure: no database, no network.
 * Run: npx tsx scripts/smoke-capture-skipped-phrases.ts
 */
import { validateCommitments, type RawCommitmentItem } from "../src/lib/date-commitment-extract";
import { skippedNoteText } from "../src/lib/capture/skipped-note";

const NOTE =
  "Founders dinner in Durham last night. Sat next to Priya Raman, who runs growth at Loom and used to be at Stripe with Tom. She's hiring a PM and offered to intro me to their head of partnerships. Also met Sarah Chen again (OpenAI) - she wants the retrieval write-up by Friday and mentioned her colleague Devon is working on evals. Devon didn't give a last name. Follow up with Priya next week about the PM role.";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

function item(over: Partial<RawCommitmentItem>): RawCommitmentItem {
  return {
    title: "x",
    detail: null,
    raw_date_phrase: "x",
    date: "",
    date_kind: "relative",
    year_stated: false,
    person_name: null,
    kind: null,
    confidence: 0.8,
    source_excerpt: "",
    ...over,
  };
}

// Tuesday 2026-09-15, 09:00 local — the audit's capture day.
const TODAY = new Date(2026, 8, 15, 9, 0, 0, 0);

const r = validateCommitments(
  [
    item({ title: "Follow up with Priya about the PM role", raw_date_phrase: "next week", person_name: "Priya Raman" }),
    item({ title: "Send Sarah the retrieval write-up", raw_date_phrase: "by Friday", person_name: "Sarah Chen" }),
    // What a model might invent: not in the note at all.
    item({ title: "Check in with Devon", raw_date_phrase: "in a fortnight", person_name: "Devon" }),
    // The same unrecognized phrase again, differently cased: reported once, as the note spells it.
    item({ title: "Retrieval write-up", raw_date_phrase: "BY FRIDAY", person_name: "Sarah Chen" }),
  ],
  NOTE,
  { today: TODAY, anchor: TODAY }
);

console.log("validateCommitments…");
check("'next week' resolves to one reminder", r.commitments.length === 1 && r.commitments[0].rawDatePhrase === "next week", JSON.stringify(r.commitments.map((c) => c.rawDatePhrase)));
check("both 'by Friday' items count as unrecognized", r.rejected.relative === 2, JSON.stringify(r.rejected));
check("the invented phrase counts as unverifiable", r.rejected.unverifiable === 1, JSON.stringify(r.rejected));
check(
  "unrecognized phrases are recorded once, spelled as the note spells them",
  JSON.stringify(r.rejected.relativePhrases) === JSON.stringify(["by Friday"]),
  JSON.stringify(r.rejected.relativePhrases)
);
check("the invented phrase is never recorded", !(r.rejected.relativePhrases ?? []).some((p) => /fortnight/i.test(p)));

console.log("\nskippedNoteText…");
const text = skippedNoteText(r.rejected);
check(
  "the summary quotes the real phrase",
  text === "Skipped 2 unrecognized phrases (“by Friday”), 1 unverified. Orbit only schedules dates it can verify or resolve with confidence.",
  String(text)
);
check("the summary never names a phrase the note does not contain", !/fortnight/i.test(text ?? ""));
check(
  "an older job with counts but no phrases gets no example",
  skippedNoteText({ relative: 1, unverifiable: 0, past: 0 }) ===
    "Skipped 1 unrecognized phrase. Orbit only schedules dates it can verify or resolve with confidence."
);
check("nothing skipped means no line", skippedNoteText({ relative: 0, unverifiable: 0, past: 0, relativePhrases: [] }) === null);
check("null means no line", skippedNoteText(null) === null);
check(
  "at most three phrases are quoted",
  (skippedNoteText({ relative: 4, unverifiable: 0, past: 0, relativePhrases: ["a", "b", "c", "d"] }) ?? "").split("“").length - 1 === 3
);

if (failures) {
  console.error(`\nsmoke-capture-skipped-phrases: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nsmoke-capture-skipped-phrases: ok");
process.exit(0);
```

- [ ] **Step 2: Register it and run it; expect failure**

Add to `MANIFEST` in `scripts/run-smoke.ts`, in the `// pure ---` block (for example directly after `"smoke-capture-review-reducer": "pure",`):

```ts
  "smoke-capture-skipped-phrases": "pure",
```

Run: `npx tsx scripts/smoke-capture-skipped-phrases.ts`
Expected: exits 1 with `Cannot find module '../src/lib/capture/skipped-note'` (ERR_MODULE_NOT_FOUND).

- [ ] **Step 3: Record the contained phrases in the validator**

In `src/lib/date-commitment-extract.ts`, replace lines 42-55 (`RejectedCounts` through `emptyCommitmentResult`) with:

```ts
export type RejectedCounts = {
  relative: number;
  unverifiable: number;
  past: number;
  /**
   * The unrecognized relative phrases themselves, spelled as the note spells them, deduped
   * case-insensitively, at most `MAX_REPORTED_PHRASES`. Only a phrase that passed the
   * verbatim-containment check can be counted as `relative`, so the review can quote these
   * without ever quoting the model. Optional: capture jobs stored before this field existed
   * carry counts only.
   */
  relativePhrases?: string[];
};

export type DatedCommitmentResult = {
  commitments: DatedCommitment[];
  rejected: RejectedCounts;
};

export function emptyCommitmentResult(): DatedCommitmentResult {
  return { commitments: [], rejected: { relative: 0, unverifiable: 0, past: 0, relativePhrases: [] } };
}
```

Directly after `normalizeForMatch` (currently lines 130-132), add:

```ts
const MAX_REPORTED_PHRASES = 5;

/** The phrase as the note spells it (case and spacing), or null when it is not there. */
function spellingInNote(notes: string, phrase: string): string | null {
  const words = phrase
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!words.length) return null;
  const match = notes.match(new RegExp(words.join("\\s+"), "i"));
  return match ? match[0] : null;
}
```

Replace line 240:

```ts
  const rejected: RejectedCounts = { relative: 0, unverifiable: 0, past: 0 };
```

with:

```ts
  const relativePhrases: string[] = [];
  const rejected: RejectedCounts = { relative: 0, unverifiable: 0, past: 0, relativePhrases };
```

Replace the relative rejection (currently lines 267-271):

```ts
      const rel = resolveRelativeDate(phrase, anchor);
      if (!rel) {
        rejected.relative += 1;
        continue;
      }
```

with:

```ts
      const rel = resolveRelativeDate(phrase, anchor);
      if (!rel) {
        rejected.relative += 1;
        // Step 1 above already proved the phrase is in the note; quote the note's spelling.
        const spelled = spellingInNote(notes, phrase);
        if (
          spelled &&
          relativePhrases.length < MAX_REPORTED_PHRASES &&
          !relativePhrases.some((p) => p.toLowerCase() === spelled.toLowerCase())
        ) {
          relativePhrases.push(spelled);
        }
        continue;
      }
```

- [ ] **Step 4: Create the shared, client-safe summary text** — `src/lib/capture/skipped-note.ts`:

```ts
/**
 * The line under the capture review's reminders that says what the date extractor threw
 * away. Pure and client-safe (a type import only), so the review component and
 * `scripts/smoke-capture-skipped-phrases.ts` share it.
 *
 * It quotes only `relativePhrases`, which `validateCommitments` records after proving each
 * phrase is in the note. It used to quote a fixed example, "in a fortnight", whatever the
 * note said — which read as Orbit inventing a phrase the user never wrote.
 */
import type { RejectedCounts } from "@/lib/date-commitment-extract";

const MAX_QUOTED = 3;

export function skippedNoteText(skipped: RejectedCounts | null | undefined): string | null {
  if (!skipped) return null;
  const parts: string[] = [];
  if (skipped.relative) {
    const quoted = (skipped.relativePhrases ?? [])
      .map((p) => p.trim())
      .filter(Boolean)
      .slice(0, MAX_QUOTED)
      .map((p) => `“${p}”`);
    const noun = skipped.relative === 1 ? "phrase" : "phrases";
    parts.push(`${skipped.relative} unrecognized ${noun}${quoted.length ? ` (${quoted.join(", ")})` : ""}`);
  }
  if (skipped.past) parts.push(`${skipped.past} past ${skipped.past === 1 ? "date" : "dates"}`);
  if (skipped.unverifiable) parts.push(`${skipped.unverifiable} unverified`);
  if (!parts.length) return null;
  return `Skipped ${parts.join(", ")}. Orbit only schedules dates it can verify or resolve with confidence.`;
}
```

- [ ] **Step 5: Use it in the review component**

In `src/components/capture/suggested-reminders-review.tsx`, add after line 9 (`import { cn } from "@/lib/utils";`):

```ts
import type { RejectedCounts } from "@/lib/date-commitment-extract";
import { skippedNoteText } from "@/lib/capture/skipped-note";
```

Replace line 23:

```ts
  skipped?: { relative: number; unverifiable: number; past: number } | null;
```

with:

```ts
  skipped?: RejectedCounts | null;
```

Replace the whole `SkippedNote` function (lines 159-189, keep its doc comment) with:

```tsx
/**
 * Surfaces what the extractor threw away, so it's visible that Orbit is being
 * deliberately careful rather than looking like it simply missed things.
 */
function SkippedNote({ skipped }: { skipped?: RejectedCounts | null }) {
  const text = skippedNoteText(skipped);
  if (!text) return null;
  return <p className="text-xs text-muted-foreground">{text}</p>;
}
```

- [ ] **Step 6: Keep the stored batch result to counts**

In `src/lib/note-batch-save.ts`, replace line 128:

```ts
  result.skipped = { ...input.skipped, duplicate: 0 };
```

with:

```ts
  // Counts only. The phrase list is review-screen copy that comes back from the client with
  // the save; the batch result has no use for it and should not store client strings.
  result.skipped = {
    relative: input.skipped.relative,
    unverifiable: input.skipped.unverifiable,
    past: input.skipped.past,
    duplicate: 0,
  };
```

- [ ] **Step 7: Run the tests; expect pass**

Run: `npx tsx scripts/smoke-capture-skipped-phrases.ts` — expected: every line `ok`, last line `smoke-capture-skipped-phrases: ok`, exit 0.
Run: `npx tsx scripts/smoke-date-commitments.ts` — expected: all `ok` (the counts it asserts are unchanged).
Run: `npx tsx scripts/smoke-note-batch.ts` — expected: all `ok`.

- [ ] **Step 8: Typecheck, lint, copy guard**

Run: `npm run typecheck && npm run lint && npx tsx scripts/smoke-toast-copy.ts`
Expected: tsc exits 0; eslint reports 0 errors; toast-copy prints its ok summary. (The browser check for this line is folded into Task 3, Step 9, which renders the same summary.)

- [ ] **Step 9: Commit**

```bash
git add src/lib/date-commitment-extract.ts src/lib/capture/skipped-note.ts src/components/capture/suggested-reminders-review.tsx src/lib/note-batch-save.ts scripts/smoke-capture-skipped-phrases.ts scripts/run-smoke.ts
git commit -m "$(cat <<'EOF'
Quote only skipped date phrases that are in the note

The capture review printed a hard-coded "in a fortnight" after any unrecognized
relative phrase. The validator now records the contained phrases (spelled as the
note spells them) and the review quotes those.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: One follow-up, not two — a dated commitment supersedes the default-window action item (C1, part b)

**Root cause (verified):** `saveNoteBatch` step 4 (`src/lib/note-batch-save.ts:337-346`) drops a `window` draft only when a dated draft for the same contact has a *substring*-equal title (`titlesCollide`, `src/lib/note-batches.ts:155-159`) **and** lies within ±3 days (`COLLISION_WINDOW_DAYS`, `withinCollisionWindow`, `:125`, `:161-163`). In the audit the dated reminder was "next week" (Mon Sep 21) and the action-item reminder was the default window, anchor + 14 days (Tue Sep 29): 8 days apart, and the titles differ by the words "next week". A symmetric ±7-day window would still miss the audit's own pair, so the rule is: a window draft (whose date Orbit picked, not the user) yields to a same-contact dated draft with a near-duplicate title whose date is **before the window date or at most 7 days after it**.

**Files:**
- Modify: `src/lib/note-batches.ts:125` (remove `COLLISION_WINDOW_DAYS`), `:161-163` (replace `withinCollisionWindow` with the new helpers)
- Modify: `src/lib/note-batch-save.ts:22-29` (imports), `:337-346` (step 4)
- Create: `scripts/smoke-reminder-dedupe.ts`
- Modify: `scripts/run-smoke.ts` (MANIFEST, pure section)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces (in `src/lib/note-batches.ts`): `SUPERSEDE_AFTER_DAYS = 7`; `titlesNearDuplicate(a: string, b: string): boolean`; `dropSupersededWindowDrafts<T extends { title: string; dueDate: Date; dateBasis: ReminderDateBasis | null }>(drafts: readonly T[], contactOf: (d: T) => string | null): T[]`. Task 3's planner calls `dropSupersededWindowDrafts`. `COLLISION_WINDOW_DAYS` and `withinCollisionWindow` are deleted (their only caller was step 4; verified with `grep -rn "withinCollisionWindow\|COLLISION_WINDOW_DAYS" src scripts`).

- [ ] **Step 1: Write the failing test** — create `scripts/smoke-reminder-dedupe.ts`:

```ts
/**
 * A window reminder (an action item or fallback follow-up, dated by Orbit's default) yields
 * to a dated commitment for the same person that says the same thing. Fixture: the
 * 2026-09-15 audit, where "Follow up with Priya next week about the PM role" became two
 * reminders, Sep 21 (from "next week") and Sep 29 (the action item). Pure.
 * Run: npx tsx scripts/smoke-reminder-dedupe.ts
 */
import { dropSupersededWindowDrafts, titlesNearDuplicate } from "../src/lib/note-batches";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

type Draft = { contact: string | null; title: string; dueDate: Date; dateBasis: "absolute" | "relative" | "vague" | "window" };
const noon = (month: number, day: number) => new Date(2026, month - 1, day, 12, 0, 0, 0);
const kept = (drafts: Draft[]) => dropSupersededWindowDrafts(drafts, (d) => d.contact).map((d) => d.title);

const priyaDated: Draft = { contact: "priya", title: "Follow up with Priya about the PM role", dueDate: noon(9, 21), dateBasis: "relative" };
const priyaAction: Draft = { contact: "priya", title: "Follow up with Priya next week about the PM role", dueDate: noon(9, 29), dateBasis: "window" };
const sarahAction: Draft = { contact: "sarah", title: "Send Sarah the retrieval write-up", dueDate: noon(9, 29), dateBasis: "window" };

console.log("titlesNearDuplicate…");
check("same follow-up, one mentions 'next week'", titlesNearDuplicate(priyaDated.title, priyaAction.title));
check("substring titles still collide", titlesNearDuplicate("Kickoff", "Book kickoff"));
check("different actions for one person do not", !titlesNearDuplicate("Follow up with Priya", "Send Priya the deck"));
check("unrelated titles do not", !titlesNearDuplicate("Send Sarah the retrieval write-up", "Intro to Devon, Sarah's colleague"));
check("empty titles never collide", !titlesNearDuplicate("", "the"));

console.log("\ndropSupersededWindowDrafts…");
check(
  "the audit pair keeps only the dated reminder",
  JSON.stringify(kept([priyaDated, priyaAction, sarahAction])) === JSON.stringify([priyaDated.title, sarahAction.title]),
  JSON.stringify(kept([priyaDated, priyaAction, sarahAction]))
);
check(
  "another person's window draft is untouched",
  kept([priyaDated, { ...priyaAction, contact: "sarah" }]).length === 2
);
check(
  "a dated commitment exactly 7 days after the window still supersedes it",
  kept([{ ...priyaDated, dueDate: noon(10, 6) }, priyaAction]).length === 1
);
check(
  "one 8 days after does not",
  kept([{ ...priyaDated, dueDate: noon(10, 7) }, priyaAction]).length === 2
);
check(
  "two window drafts never supersede each other",
  kept([priyaAction, { ...priyaAction, title: "Follow up with Priya about the PM role" }]).length === 2
);
check(
  "the old rule's case still holds (Kickoff Sep 16 vs Book kickoff window Sep 15)",
  JSON.stringify(
    kept([
      { contact: "dev", title: "Kickoff", dueDate: noon(9, 16), dateBasis: "absolute" },
      { contact: "dev", title: "Book kickoff", dueDate: noon(9, 15), dateBasis: "window" },
    ])
  ) === JSON.stringify(["Kickoff"])
);

if (failures) {
  console.error(`\nsmoke-reminder-dedupe: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nsmoke-reminder-dedupe: ok");
process.exit(0);
```

- [ ] **Step 2: Register it and run it; expect failure**

Add to the pure block of `MANIFEST` in `scripts/run-smoke.ts`:

```ts
  "smoke-reminder-dedupe": "pure",
```

Run: `npx tsx scripts/smoke-reminder-dedupe.ts`
Expected: exits 1 with `SyntaxError: The requested module '../src/lib/note-batches' does not provide an export named 'dropSupersededWindowDrafts'`.

- [ ] **Step 3: Implement the helpers**

In `src/lib/note-batches.ts`, delete line 125:

```ts
export const COLLISION_WINDOW_DAYS = 3;
```

Replace `withinCollisionWindow` (lines 161-163):

```ts
export function withinCollisionWindow(a: Date, b: Date, days = COLLISION_WINDOW_DAYS) {
  return Math.abs(a.getTime() - b.getTime()) <= days * 86_400_000;
}
```

with:

```ts
/**
 * Words that say when or to whom, not what. "Follow up with Priya next week about the PM
 * role" and "Follow up with Priya about the PM role" are one task; the difference is timing.
 */
const TITLE_NOISE = new Set([
  "a", "an", "the", "to", "with", "about", "for", "on", "of", "and", "re", "at", "in", "by", "up",
  "my", "me", "her", "his", "him", "their", "them", "she", "he", "they", "it",
  "next", "this", "week", "weeks", "month", "today", "tomorrow", "soon", "later",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
]);

function titleWords(s: string): Set<string> {
  return new Set(
    normalizeTitle(s)
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 1 && !TITLE_NOISE.has(w))
  );
}

/**
 * The same thing to do, worded differently: substring-equal (the old `titlesCollide`
 * rule), or at least 80% of the shorter title's content words appear in the longer one.
 */
export function titlesNearDuplicate(a: string, b: string): boolean {
  if (titlesCollide(a, b)) return true;
  const wa = titleWords(a);
  const wb = titleWords(b);
  if (!wa.size || !wb.size) return false;
  const [small, large] = wa.size <= wb.size ? [wa, wb] : [wb, wa];
  let shared = 0;
  for (const w of small) if (large.has(w)) shared += 1;
  return shared / small.size >= 0.8;
}

/** How far after a window reminder's default date a dated commitment may land and still replace it. */
export const SUPERSEDE_AFTER_DAYS = 7;

/**
 * The save's collision rule, shared with the review's reminder count. A `window` draft (an
 * action item or the fallback follow-up) carries a date Orbit chose, not one the user said,
 * so it yields to a dated draft for the same contact with a near-duplicate title whose date
 * is earlier than the window date or at most `SUPERSEDE_AFTER_DAYS` after it. The audit's
 * pair — Sep 21 from "next week" against the Sep 29 default — is 8 days EARLIER, which is
 * why this is not a symmetric window. Dated drafts are never dropped here.
 */
export function dropSupersededWindowDrafts<
  T extends { title: string; dueDate: Date; dateBasis: ReminderDateBasis | null }
>(drafts: readonly T[], contactOf: (d: T) => string | null): T[] {
  const limitMs = SUPERSEDE_AFTER_DAYS * 86_400_000;
  return drafts.filter((d) => {
    if (d.dateBasis !== "window") return true;
    return !drafts.some(
      (other) =>
        other !== d &&
        other.dateBasis !== "window" &&
        contactOf(other) === contactOf(d) &&
        titlesNearDuplicate(other.title, d.title) &&
        other.dueDate.getTime() - d.dueDate.getTime() <= limitMs
    );
  });
}
```

(`ReminderDateBasis` is already imported at line 6.)

- [ ] **Step 4: Use it in the save**

In `src/lib/note-batch-save.ts`, replace the import block at lines 22-29:

```ts
import {
  DEFAULT_FOLLOW_UP_WINDOW_DAYS,
  emptyNoteBatchResult,
  noteInteractionExternalId,
  titlesCollide,
  windowDueDate,
  withinCollisionWindow,
} from "@/lib/note-batches";
```

with:

```ts
import {
  DEFAULT_FOLLOW_UP_WINDOW_DAYS,
  dropSupersededWindowDrafts,
  emptyNoteBatchResult,
  noteInteractionExternalId,
  titlesCollide,
  windowDueDate,
} from "@/lib/note-batches";
```

Replace step 4 (lines 337-346):

```ts
    // 4. Collision rule. Action-item drafts push their own `window` reminders (step 1a
    //    above); this drops one when it collides with a dated commitment for the same
    //    contact so the two don't produce duplicate-looking reminders.
    const kept = drafts.filter((d) => {
      if (d.dateBasis !== "window") return true;
      return !drafts.some(
        (other) => other !== d && other.dateBasis !== "window" && other.contactId === d.contactId &&
          titlesCollide(other.title, d.title) && withinCollisionWindow(other.dueDate, d.dueDate)
      );
    });
```

with:

```ts
    // 4. Collision rule. Action-item and fallback drafts carry a `window` date Orbit chose;
    //    one yields to a dated commitment for the same contact that says the same thing
    //    (see `dropSupersededWindowDrafts`), so one follow-up never becomes two reminders.
    //    The review's Save button counts with the same function (`planReminders`).
    const kept = dropSupersededWindowDrafts(drafts, (d) => d.contactId);
```

- [ ] **Step 5: Run the tests; expect pass**

Run: `npx tsx scripts/smoke-reminder-dedupe.ts` — expected: all `ok`, exit 0.
Run: `npx tsx scripts/smoke-note-batch.ts` — expected: all `ok` (its "four pending reminders" and "collision: no window reminder titled Book kickoff" cases hold under the new rule).

- [ ] **Step 6: Typecheck and lint**

Run: `npm run typecheck && npm run lint` — expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/note-batches.ts src/lib/note-batch-save.ts scripts/smoke-reminder-dedupe.ts scripts/run-smoke.ts
git commit -m "$(cat <<'EOF'
Let a dated follow-up replace the default-window action item

"Follow up with Priya next week" produced two reminders (Sep 21 and Sep 29).
Window drafts now yield to a same-contact dated draft with a near-duplicate
title dated before the window or up to a week after it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: The Save button counts every reminder the save will write (C1, part c)

**Root cause (verified):** `CaptureSummary` (`src/components/capture/capture-summary.tsx:84-93`) counts only ticked dated suggestions plus meeting extras. `saveNoteBatch` also writes one window reminder per new action item (step 1a) and a fallback follow-up per person with no other draft (step 3), so "Save 3 contacts + 1 reminder" wrote 4. Fix: a pure planner that mirrors the save's drafts (using Task 2's collision rule), shared per-person facts with the runner, and a pglite smoke proving planner count == reminders written.

**Files:**
- Modify: `src/lib/note-batches.ts` (append planner after `dropSupersededWindowDrafts`)
- Modify: `src/lib/capture/review-reducer.ts:6-13` (imports), append after line 153
- Modify: `src/lib/capture-job-runner.ts:27-28`, `:37` (imports), `:236-247` (participant facts)
- Modify: `src/components/capture/capture-summary.tsx:20`, `:84-98`, `:170`
- Create: `scripts/smoke-capture-reminder-count.ts`; Modify: `scripts/run-smoke.ts` (pglite section)

**Interfaces:**
- Consumes: `dropSupersededWindowDrafts` (Task 2), `RejectedCounts.relativePhrases` (Task 1, fixture only).
- Produces: in `note-batches.ts` — `PlannedReminder = { kind: "action_item" | "dated" | "follow_up"; contactKey: string | null; title: string; dueDate: Date; dateBasis: ReminderDateBasis }`, `ReminderPlanParticipant = { name: string | null; actionItems: readonly string[]; createReminder: boolean; followUpDays: number | null; followUpTitle: string | null }`, `ReminderPlanCommitment = { title: string; dueDateIso: string; dateBasis: ReminderDateBasis; personName: string | null }`, `planReminders(input: { anchorIso: string; participants: readonly ReminderPlanParticipant[]; commitments: readonly ReminderPlanCommitment[] }): PlannedReminder[]`. In `review-reducer.ts` — `reminderFactsFor(item: BulkNotePersonPreview, decision: CaptureDecision): ReminderPlanParticipant & { closeness: number }`, `plannedCaptureReminders(result: Pick<CaptureJobResult, "items" | "anchorIso">, decisions: CaptureDecisions | null | undefined, commitments: readonly ReminderPlanCommitment[]): PlannedReminder[]`, `saveButtonLabel(c: { meeting: boolean; contacts: number; reminders: number }): string`. Task 13 edits the same `buildSaveInput` block after this task.

- [ ] **Step 1: Write the failing test** — `scripts/smoke-capture-reminder-count.ts`:

```ts
/**
 * The capture summary's Save button counts every reminder the save writes — action items
 * and fallback follow-ups included — and the save writes exactly that many. Fixture: the
 * 2026-09-15 audit note, whose button said "1 reminder" before a save that wrote 4.
 * Run: npx tsx scripts/smoke-capture-reminder-count.ts
 */
import "./smoke/_env";
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke-capture-reminder-count";
process.env.CLERK_SECRET_KEY ||= "sk_test_smoke-capture-reminder-count";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { captureJobs, contacts, ignoredPeople, noteBatches, reminders, userSettings } from "../src/db/schema";
import { createCaptureJob, getCaptureJobById, recordCaptureDecisionRow } from "../src/lib/capture-jobs";
import { runCaptureJobById } from "../src/lib/capture-job-runner";
import { defaultReminderKeys, plannedCaptureReminders, saveButtonLabel } from "../src/lib/capture/review-reducer";
import type { CaptureParseResult } from "../src/lib/capture/types";
import { hashSourceNote } from "../src/lib/suggested-reminder-utils";
import { ensureUserSettings } from "../src/lib/user-settings";
import { run } from "./smoke/_env";

const USER = "smoke-capture-reminder-count-user";
const NOTE =
  "Founders dinner in Durham last night. Sat next to Priya Raman, who runs growth at Loom and used to be at Stripe with Tom. She's hiring a PM and offered to intro me to their head of partnerships. Also met Sarah Chen again (OpenAI) - she wants the retrieval write-up by Friday and mentioned her colleague Devon is working on evals. Devon didn't give a last name. Follow up with Priya next week about the PM role.";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

type Parsed = CaptureParseResult["items"][number]["parsed"];
function person(name: string, over: Partial<Parsed> = {}): Parsed {
  return {
    name, company: null, role: null, presence: "participant", location: null, email: null, linkedin_url: null,
    met_at: "Founders dinner in Durham", topics: [], action_items: [], follow_up_recommendation: null, follow_up_days: null,
    relationship_score_suggestion: 3, relevance: null, tags: [], summary: null, key_facts: [], opportunities: [],
    shared_interests: [], suggested_next_message: null, confidence: 0.9, interaction_date: "2026-09-14", low_confidence_fields: [],
    ...over,
  };
}

function fakeParse(corpus: string): CaptureParseResult {
  const card = (key: string, parsed: Parsed) => ({ key, notes: NOTE, parsed, duplicates: [], suggestedMergeId: null, sharedNoteTexts: [], interactionDate: "2026-09-14", interactionType: "meeting_note" });
  return {
    items: [
      card("0-Priya Raman", person("Priya Raman", { company: "Loom", role: "Head of Growth", action_items: ["Follow up with Priya next week about the PM role"], follow_up_recommendation: "Follow up about the PM role" })),
      card("1-Sarah Chen", person("Sarah Chen", { company: "OpenAI", action_items: ["Send Sarah the retrieval write-up"] })),
      card("2-Devon", person("Devon", { relationship_score_suggestion: 2 })),
    ],
    sharedNotes: [],
    interactionDate: "2026-09-14",
    interactionType: "meeting_note",
    anchorIso: "2026-09-15",
    anchorBasis: "note",
    hints: {},
    sourceText: corpus,
    sourceHash: hashSourceNote(corpus),
    suggestedReminders: [
      { key: "0-next week", title: "Follow up with Priya about the PM role", description: null, rawDatePhrase: "next week", dueDateIso: "2026-09-21", yearInferred: false, personName: "Priya Raman", actionKind: "follow_up", confidenceScore: 80, sourceExcerpt: "Follow up with Priya next week about the PM role.", dateBasis: "relative", anchorIso: "2026-09-15" },
    ],
    suggestionsSkipped: { relative: 1, unverifiable: 0, past: 0, relativePhrases: ["by Friday"] },
    mentions: [{ text: "Tom", context: "used to be at Stripe with Tom", nearPerson: "Priya Raman", contactId: null, confidence: 0, matchedBy: null }],
    mentionedOnly: [],
  };
}

const deps = { parse: async (_userId: string, corpus: string) => fakeParse(corpus), enrich: false };

run(async () => {
  const db = await getDb();
  await db.delete(captureJobs).where(eq(captureJobs.userId, USER));
  await db.delete(ignoredPeople).where(eq(ignoredPeople.userId, USER));
  await db.delete(reminders).where(eq(reminders.userId, USER));
  await db.delete(noteBatches).where(eq(noteBatches.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await ensureUserSettings(USER);

  const job = await createCaptureJob(USER, { sourceKind: "messy", status: "queued", inputText: NOTE });
  await runCaptureJobById(job.id, deps);
  const decidedAt = new Date().toISOString();
  await recordCaptureDecisionRow(USER, job.id, "0-Priya Raman", { decision: "accept", index: 0, mergeContactId: null, relationshipScore: 3, tagNames: [], decidedAt });
  await recordCaptureDecisionRow(USER, job.id, "1-Sarah Chen", { decision: "accept", index: 1, mergeContactId: null, relationshipScore: 3, tagNames: [], decidedAt });
  await recordCaptureDecisionRow(USER, job.id, "2-Devon", { decision: "accept", index: 2, mergeContactId: null, relationshipScore: 2, tagNames: [], decidedAt });

  const row = (await getCaptureJobById(job.id))!;
  const ticked = new Set(defaultReminderKeys(row.result!.suggestedReminders));
  const planned = plannedCaptureReminders(
    row.result!,
    row.decisions,
    row.result!.suggestedReminders.filter((s) => ticked.has(s.key)).map((s) => ({ title: s.title, dueDateIso: s.dueDateIso, dateBasis: s.dateBasis, personName: s.personName }))
  );
  console.log("Planned…");
  check("two reminders planned: Priya's dated follow-up and Sarah's action item", planned.length === 2, JSON.stringify(planned.map((p) => [p.kind, p.title])));
  check("Priya's duplicate action item is not planned", !planned.some((p) => p.title === "Follow up with Priya next week about the PM role"));
  check("the button says so", saveButtonLabel({ meeting: false, contacts: 3, reminders: planned.length }) === "Save 3 contacts + 2 reminders");
  check("label: singular and meeting forms", saveButtonLabel({ meeting: true, contacts: 1, reminders: 1 }) === "Save meeting + 1 contact + 1 reminder");
  check("label: nothing to count", saveButtonLabel({ meeting: false, contacts: 0, reminders: 0 }) === "Save");

  console.log("\nSaved…");
  await db.update(captureJobs).set({ status: "saving", claimToken: null }).where(eq(captureJobs.id, job.id));
  const saved = await runCaptureJobById(job.id, deps);
  check("the save lands", saved?.status === "saved", `${saved?.status} ${saved?.error}`);
  check("the save writes exactly what the button promised", saved?.result?.saved?.remindersCreated === planned.length, JSON.stringify(saved?.result?.saved));
  const rows = await db.query.reminders.findMany({ where: eq(reminders.userId, USER) });
  check(
    "the rows are the planned titles",
    JSON.stringify(rows.map((r) => r.title).sort()) === JSON.stringify(planned.map((p) => p.title).sort()),
    JSON.stringify(rows.map((r) => r.title))
  );
});
```

- [ ] **Step 2: Register and run; expect failure**

Add to the pglite block of `MANIFEST`: `"smoke-capture-reminder-count": "pglite",`
Run: `npx tsx scripts/smoke-capture-reminder-count.ts`
Expected: exits 1 with `does not provide an export named 'plannedCaptureReminders'`.

- [ ] **Step 3: Add the planner** — append to `src/lib/note-batches.ts`, after `dropSupersededWindowDrafts`:

```ts
export type PlannedReminder = {
  kind: "action_item" | "dated" | "follow_up";
  /** The person's lowercased name — contacts have no ids before the save. */
  contactKey: string | null;
  title: string;
  dueDate: Date;
  dateBasis: ReminderDateBasis;
};
export type ReminderPlanParticipant = {
  name: string | null;
  actionItems: readonly string[];
  createReminder: boolean;
  followUpDays: number | null;
  followUpTitle: string | null;
};
export type ReminderPlanCommitment = { title: string; dueDateIso: string; dateBasis: ReminderDateBasis; personName: string | null };

/** Mirrors `MAX_ACTION_ITEMS_PER_INTERACTION` in src/lib/action-items.ts, which reaches @/db and cannot be imported here. */
const PLAN_MAX_ACTION_ITEMS = 10;

function planNameKey(name: string | null | undefined): string | null {
  return name?.trim().toLowerCase() || null;
}
function planIsoNoon(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1, 12, 0, 0, 0);
}
function planDayKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Every reminder `saveNoteBatch` would write for a fresh batch, without a database: step 1a
 * (one window reminder per distinct action item), step 2 (dated commitments, bound to a
 * participant by name), step 3 (the fallback follow-up for a person with no other draft),
 * step 4 (`dropSupersededWindowDrafts`) and step 5's itemHash de-duplication. Meeting digest
 * items are not planned; callers add their tick count. `smoke-capture-reminder-count`
 * proves this equals what the save writes.
 */
export function planReminders(input: {
  anchorIso: string;
  participants: readonly ReminderPlanParticipant[];
  commitments: readonly ReminderPlanCommitment[];
}): PlannedReminder[] {
  const anchor = planIsoNoon(input.anchorIso);
  const names = new Set(input.participants.map((p) => planNameKey(p.name)).filter((k): k is string => Boolean(k)));
  const drafts: PlannedReminder[] = [];

  for (const p of input.participants) {
    const key = planNameKey(p.name);
    const seen = new Set<string>();
    for (const raw of p.actionItems) {
      const text = raw.replace(/^ +| +$/g, "");
      const lowered = text.toLowerCase();
      if (!text || seen.has(lowered)) continue;
      if (seen.size >= PLAN_MAX_ACTION_ITEMS) break;
      seen.add(lowered);
      drafts.push({ kind: "action_item", contactKey: key, title: text, dueDate: windowDueDate(anchor), dateBasis: "window" });
    }
  }
  for (const c of input.commitments) {
    const key = planNameKey(c.personName);
    drafts.push({ kind: "dated", contactKey: key && names.has(key) ? key : null, title: c.title, dueDate: planIsoNoon(c.dueDateIso), dateBasis: c.dateBasis });
  }
  for (const p of input.participants) {
    const key = planNameKey(p.name);
    if (!p.createReminder || !key || drafts.some((d) => d.contactKey === key)) continue;
    drafts.push({
      kind: "follow_up",
      contactKey: key,
      title: p.followUpTitle || `Follow up with ${p.name}`,
      dueDate: windowDueDate(anchor, p.followUpDays || DEFAULT_FOLLOW_UP_WINDOW_DAYS),
      dateBasis: "window",
    });
  }

  const hashes = new Set<string>();
  return dropSupersededWindowDrafts(drafts, (d) => d.contactKey).filter((d) => {
    if (d.kind === "action_item") return true;
    const hash = `${planDayKey(d.dueDate)}|${d.title.trim().toLowerCase()}`;
    if (hashes.has(hash)) return false;
    hashes.add(hash);
    return true;
  });
}
```

- [ ] **Step 4: Per-card facts, the job-level plan and the label** — in `src/lib/capture/review-reducer.ts`, after the existing type import block (lines 6-13) add:

```ts
import { clampCloseness } from "@/lib/capture/closeness";
import {
  followUpDaysFor,
  planReminders,
  shouldCreateFollowUp,
  type PlannedReminder,
  type ReminderPlanCommitment,
  type ReminderPlanParticipant,
} from "@/lib/note-batches";
```

Append at the end of the file:

```ts
/** The reminder-relevant facts of one accepted card, derived exactly as the save derives them. */
export function reminderFactsFor(
  item: BulkNotePersonPreview,
  decision: CaptureDecision
): ReminderPlanParticipant & { closeness: number } {
  const closeness = clampCloseness(decision.relationshipScore, clampCloseness(item.parsed.relationship_score_suggestion));
  return {
    name: decision.edits?.name?.trim() || item.parsed.name,
    actionItems: item.parsed.action_items,
    createReminder: shouldCreateFollowUp(closeness, item.parsed.relevance, Boolean(item.parsed.follow_up_recommendation)),
    followUpDays: followUpDaysFor(closeness, item.parsed.follow_up_days),
    followUpTitle: item.parsed.follow_up_recommendation,
    closeness,
  };
}

/** Every reminder a save of this job would write, given the dated suggestions still ticked. */
export function plannedCaptureReminders(
  result: Pick<CaptureJobResult, "items" | "anchorIso">,
  decisions: CaptureDecisions | null | undefined,
  commitments: readonly ReminderPlanCommitment[]
): PlannedReminder[] {
  return planReminders({
    anchorIso: result.anchorIso,
    participants: acceptedPeople(result.items, decisions).map(({ item, decision }) => reminderFactsFor(item, decision)),
    commitments,
  });
}

/** The summary's Save button: "Save meeting + 3 contacts + 2 reminders". */
export function saveButtonLabel(counts: { meeting: boolean; contacts: number; reminders: number }): string {
  const parts: string[] = [];
  if (counts.meeting) parts.push("meeting");
  if (counts.contacts) parts.push(`${counts.contacts} ${counts.contacts === 1 ? "contact" : "contacts"}`);
  if (counts.reminders) parts.push(`${counts.reminders} ${counts.reminders === 1 ? "reminder" : "reminders"}`);
  return parts.length ? `Save ${parts.join(" + ")}` : "Save";
}
```

- [ ] **Step 5: The runner uses the same facts** — in `src/lib/capture-job-runner.ts`: line 27 becomes `import { acceptedPeople, defaultReminderKeys, reminderFactsFor, setAsidePeople } from "@/lib/capture/review-reducer";`; delete line 28 (`import { clampCloseness } …`); line 37 becomes `import { captureSourceKinds } from "@/lib/note-batches";`. Replace lines 236-247 (from `const closeness = clampCloseness(` through the returned object's closing `};`) with:

```ts
    const facts = reminderFactsFor(item, decision);
    return {
      notes: item.notes,
      parsed,
      mergeContactId,
      createReminder: facts.createReminder,
      relationshipScore: facts.closeness,
      tagNames: decision.tagNames?.length ? decision.tagNames : parsed.tags,
      followUpDays: facts.followUpDays,
      interactionDate: item.interactionDate,
      interactionType: item.interactionType,
    };
```

- [ ] **Step 6: The summary counts with the planner** — in `src/components/capture/capture-summary.tsx`, line 20 becomes `import { acceptedPeople, countDecisions, defaultReminderKeys, peopleDecisions, plannedCaptureReminders, saveButtonLabel } from "@/lib/capture/review-reducer";`. Replace lines 84-95 (`const checkedDates …` through `const actionItemCount = …;`) with:

```tsx
  const checkedDates = suggestions.filter((s) => s.checked).length;
  // Everything the save will write, not just the ticked dates: each accepted person's action
  // items and fallback follow-up count too, after the save's own de-duplication. Meeting
  // digest items are counted by their ticks.
  const planned = useMemo(
    () =>
      plannedCaptureReminders(
        result,
        decisions,
        suggestions
          .filter((s) => s.checked)
          .map((s) => ({ title: s.title, dueDateIso: s.dueDateIso, dateBasis: s.dateBasis, personName: s.personNameOverride ?? s.personName }))
      ),
    [result, decisions, suggestions]
  );
  const reminderCount = planned.length + meetingExtraCount;
  const saveLabel = saveButtonLabel({ meeting: hasMeeting, contacts: accepted.length, reminders: reminderCount });
  const actionItemCount = planned.filter((p) => p.kind === "action_item").length;
```

At line 170 replace `{checkedDates + meetingExtraCount > 0 ? " and reminders" : ""}` with `{reminderCount > 0 ? " and reminders" : ""}`.

- [ ] **Step 7: Run the tests; expect pass**

Run each; expected all `ok`, exit 0: `npx tsx scripts/smoke-capture-reminder-count.ts`, `npx tsx scripts/smoke-capture-jobs.ts`, `npx tsx scripts/smoke-capture-review-reducer.ts`, `npx tsx scripts/smoke-note-batch.ts`.

- [ ] **Step 8: Typecheck, lint** — `npm run typecheck && npm run lint`: 0 errors (an unused-import warning on line 28 or 37 of the runner means Step 5 was incomplete).

- [ ] **Step 9: Browser check (covers Task 1 too)** — stop `orbit-web` if running. Seed a job: `DATABASE_URL="" npx tsx scripts/dev-seed-capture-job.ts` (prints `seeded capture job …`). Give it a skipped phrase:

```bash
DATABASE_URL="" npx tsx -e 'import("./src/db").then(async ({ getDb }) => { const { captureJobs } = await import("./src/db/schema"); const { eq } = await import("drizzle-orm"); const db = await getDb(); const [job] = await db.select().from(captureJobs).where(eq(captureJobs.userId, "demo-user")); await db.update(captureJobs).set({ result: { ...job.result!, suggestionsSkipped: { relative: 1, unverifiable: 0, past: 0, relativePhrases: ["next week"] } } }).where(eq(captureJobs.id, job.id)); process.exit(0); })'
```

Start `orbit-web`, open `/capture`, resume, press Keep on all three cards. Expected on the summary: the button reads `Save 3 contacts + 2 reminders` (Ada's action item + Grace's dated call; Alan gets no follow-up) and the skipped line reads `Skipped 1 unrecognized phrase (“next week”). Orbit only schedules…` — no "fortnight". Press Save; the saved view reports 2 reminders.

- [ ] **Step 10: Commit**

```bash
git add src/lib/note-batches.ts src/lib/capture/review-reducer.ts src/lib/capture-job-runner.ts src/components/capture/capture-summary.tsx scripts/smoke-capture-reminder-count.ts scripts/run-smoke.ts
git commit -m "$(cat <<'EOF'
Count every reminder a capture save will write on its Save button

The button counted ticked dates only; the save also writes action-item and
fallback follow-up reminders. A pure planner mirrors the save's drafts and a
pglite smoke proves the two agree.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: "Last touch today", not "Last touch in about 9 hours" (C1, last touch)

**Root cause (verified):** capture passes a date-only `interactionDate` (the anchor, e.g. `"2026-09-15"`, `src/lib/note-batch-save.ts:203`); `logInteractionForUser` turns any date-only string into local noon (`src/lib/contact-writes.ts:871-880`) and stamps it on the interaction and `contacts.lastInteractionAt`. Logged at 03:00, that is 9 hours ahead. The profile pill formats it with `formatDistanceToNow` (`src/components/contacts/contact-stat-pills.tsx:36-38`), which says "in about 9 hours". (The contacts list's own `lastTouchLabel` already floors negative days to "today".) Fix both ends: a same-day date-only value is stored as now, and the pill says "today" for a later-today timestamp (rows written before this fix).

**Files:**
- Modify: `src/lib/interaction-date.ts` (append `clampSameDayToNow`)
- Modify: `src/lib/relative-date.ts:12` (import), append `formatLastTouch`
- Modify: `src/lib/contact-writes.ts:867-880`
- Modify: `src/components/contacts/contact-stat-pills.tsx:1`, `:36-38`
- Create: `scripts/smoke-last-touch.ts`; Modify: `scripts/run-smoke.ts` (pure)

**Interfaces:**
- Produces: `clampSameDayToNow(dateOnly: string, atNoon: Date, now?: Date): Date` (interaction-date.ts); `formatLastTouch(at: Date, now?: Date): string` (relative-date.ts). Task 16 reuses nothing from here.

- [ ] **Step 1: Write the failing test** — `scripts/smoke-last-touch.ts`:

```ts
/**
 * A same-day interaction is never stored in the future, and a later-today "last touch"
 * reads "today". The audit saw "Last touch in about 9 hours" for a note logged at 3 a.m.
 * Pure. Run: npx tsx scripts/smoke-last-touch.ts
 */
import { clampSameDayToNow } from "../src/lib/interaction-date";
import { formatLastTouch } from "../src/lib/relative-date";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const at = (d: number, h: number) => new Date(2026, 8, d, h, 0, 0, 0);
const THREE_AM = at(15, 3);

console.log("clampSameDayToNow…");
check("today's noon, logged at 3am, is stored as now", clampSameDayToNow("2026-09-15", at(15, 12), THREE_AM).getTime() === THREE_AM.getTime());
check("today's noon, logged at 3pm, stays noon", clampSameDayToNow("2026-09-15", at(15, 12), at(15, 15)).getTime() === at(15, 12).getTime());
check("yesterday keeps its noon", clampSameDayToNow("2026-09-14", at(14, 12), THREE_AM).getTime() === at(14, 12).getTime());
check("a later day chosen on purpose keeps its noon", clampSameDayToNow("2026-09-16", at(16, 12), THREE_AM).getTime() === at(16, 12).getTime());

console.log("\nformatLastTouch…");
check("later today reads today", formatLastTouch(at(15, 12), THREE_AM) === "today", formatLastTouch(at(15, 12), THREE_AM));
check("earlier today keeps its distance", formatLastTouch(at(15, 1), THREE_AM) === "about 2 hours ago", formatLastTouch(at(15, 1), THREE_AM));
check("days ago", formatLastTouch(at(10, 12), THREE_AM) === "5 days ago", formatLastTouch(at(10, 12), THREE_AM));
check("another day ahead is not hidden", formatLastTouch(at(17, 12), THREE_AM) === "in 2 days", formatLastTouch(at(17, 12), THREE_AM));

if (failures) {
  console.error(`\nsmoke-last-touch: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nsmoke-last-touch: ok");
process.exit(0);
```

- [ ] **Step 2: Register and run; expect failure** — add `"smoke-last-touch": "pure",` to the pure block. Run `npx tsx scripts/smoke-last-touch.ts`; expected: exits 1, `does not provide an export named 'clampSameDayToNow'`.

- [ ] **Step 3: Implement** — append to `src/lib/interaction-date.ts`:

```ts
function localIsoDay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * A date-only interaction ("2026-09-15") is stored at local noon. Logged that same day
 * before noon, noon is still ahead, and the profile read "Last touch in about 9 hours". A
 * same-day date is clamped to now; any other day — past, or a later day someone chose on
 * purpose — keeps its noon.
 */
export function clampSameDayToNow(dateOnly: string, atNoon: Date, now: Date = new Date()): Date {
  if (dateOnly !== localIsoDay(now)) return atNoon;
  return atNoon.getTime() > now.getTime() ? new Date(now.getTime()) : atNoon;
}
```

In `src/lib/relative-date.ts`, after line 12 (`import { WEEKDAYS, atLocalNoon } from "@/lib/interaction-date";`) add `import { formatDistance } from "date-fns";` and append:

```ts
/**
 * "Last touch …" wording. A timestamp later today reads "today" rather than "in about 9
 * hours": date-only interactions were stored at noon before `clampSameDayToNow`, so old rows
 * still carry a noon that is ahead of the morning. Anything else is date-fns' own distance.
 */
export function formatLastTouch(at: Date, now: Date = new Date()): string {
  const sameDay =
    at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate();
  if (sameDay && at.getTime() > now.getTime()) return "today";
  return formatDistance(at, now, { addSuffix: true });
}
```

In `src/lib/contact-writes.ts` replace lines 867-880 (the dynamic import through `: null;`):

```ts
  const { parseInteractionDateFromNotes } = await import(
    "@/lib/interaction-date"
  );

  const parsedDate =
    input.interactionDate instanceof Date
      ? input.interactionDate
      : input.interactionDate
        ? new Date(
            input.interactionDate.length <= 10
              ? `${input.interactionDate}T12:00:00`
              : input.interactionDate
          )
        : null;
```

with:

```ts
  const { clampSameDayToNow, parseInteractionDateFromNotes } = await import(
    "@/lib/interaction-date"
  );

  // A date-only value is a day, stored at noon — except today, which must not be stored
  // in the future (see `clampSameDayToNow`).
  const parsedDate =
    input.interactionDate instanceof Date
      ? input.interactionDate
      : input.interactionDate
        ? input.interactionDate.length <= 10
          ? clampSameDayToNow(input.interactionDate, new Date(`${input.interactionDate}T12:00:00`))
          : new Date(input.interactionDate)
        : null;
```

In `src/components/contacts/contact-stat-pills.tsx` replace line 1 (`import { formatDistanceToNow } from "date-fns";`) with `import { formatLastTouch } from "@/lib/relative-date";` and lines 36-38 with:

```tsx
  const since = lastTouchAt ? formatLastTouch(new Date(lastTouchAt)) : null;
```

- [ ] **Step 4: Run the tests; expect pass** — `npx tsx scripts/smoke-last-touch.ts` (all `ok`), then `npx tsx scripts/smoke-note-batch.ts` and `npx tsx scripts/smoke-interaction-delete.ts` (all `ok`; their dates are in the past).

- [ ] **Step 5: Typecheck, lint** — `npm run typecheck && npm run lint`: 0 errors.

- [ ] **Step 6: Browser check** — start `orbit-web`, open any contact, use **Log interaction** with today's date and a note. Expected: the pill reads `Last touch today` (or `Last touch less than a minute ago`), never `in about … hours`.

- [ ] **Step 7: Commit**

```bash
git add src/lib/interaction-date.ts src/lib/relative-date.ts src/lib/contact-writes.ts src/components/contacts/contact-stat-pills.tsx scripts/smoke-last-touch.ts scripts/run-smoke.ts
git commit -m "$(cat <<'EOF'
Stop same-day interactions from reading as a future last touch

Date-only interactions logged before noon were stored at noon and shown as
"Last touch in about 9 hours". Same-day dates are now stored as now, and the
pill reads "today" for older rows that still carry a later-today noon.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Name matches rank first; notes-only mentions drop out of a name search (C2, part a: ask bar, graph, chat, pickers)

**Root cause (verified):** `search_tsv` includes `ai_summary` and `notes` at weight D (`src/db/index.ts:1471-1476`), so "Priya" matches Hassan Ali through a note mention. In `hybridSearchContacts` (`src/lib/hybrid-search.ts:555-616`) his fts-only hit fuses to ~1/62 — tied with a trigram-only prefix hit like "Priyanka" — and sits beside real name hits. The Cmd+K palette and pickers (`searchContactsForPicker`, `src/actions/contacts.ts:308-355`) sort matches alphabetically, so "Hassan" comes *first*. Fix: one name-tier definition (0 = a whole word of the name, 1 = a word of the name starts with the query, 2 = elsewhere) in JS and SQL; pickers order by it; hybrid search puts tiers 0-1 first and, for single-token queries where some name matched, drops rows whose only evidence is prose. A threshold on normalized RRF was rejected: the existing fusion smoke sits at exactly 0.5.

**Files:**
- Create: `src/lib/contact-search-rank.ts`
- Modify: `src/actions/contacts.ts:261-298` (move `searchCondition` out), `:327` and `:343-352` (picker)
- Modify: `src/lib/hybrid-search.ts:11` (import), `:581` (apply policy)
- Create: `scripts/smoke-contact-search-rank.ts`; Modify: `scripts/run-smoke.ts` (pglite)

**Interfaces:**
- Produces (`src/lib/contact-search-rank.ts`, imports only `drizzle-orm` and `@/db/schema`): `escapeLike(v: string): string`, `normalizeSearchQuery(q: string): string`, `nameMatchTier(fullName: string, preferredName: string | null | undefined, query: string): 0 | 1 | 2`, `nameMatchTierSql(query: string): SQL<number>`, `contactSearchCondition(q: string): SQL` (the moved `searchCondition`, unchanged), `applyNameMatchPolicy<T extends NamePolicyRow>(rows: T[], query: string): T[]`. Task 6 consumes `nameMatchTierSql` and `contactSearchCondition`.

- [ ] **Step 1: Write the failing test** — `scripts/smoke-contact-search-rank.ts`:

```ts
/**
 * Searching "Priya" ranks people named Priya first; someone whose notes merely mention her
 * is dropped from a name lookup but still found by a word that only their notes contain.
 * Fixture from the 2026-09-15 audit (Hassan Ali appeared beside exact-name hits).
 * Run: npx tsx scripts/smoke-contact-search-rank.ts
 */
import "./smoke/_env";

import { and, asc, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts } from "../src/db/schema";
import { hybridSearchContacts } from "../src/lib/hybrid-search";
import { contactSearchCondition, nameMatchTier, nameMatchTierSql } from "../src/lib/contact-search-rank";
import { run } from "./smoke/_env";

const U = "smoke-contact-search-rank-user";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

run(async () => {
  const db = await getDb();
  await db.delete(contacts).where(eq(contacts.userId, U));
  await db.insert(contacts).values([
    { userId: U, fullName: "Priya Raman", company: "Loom", title: "Head of Growth" },
    { userId: U, fullName: "Priyanka Das", company: "Figma" },
    { userId: U, fullName: "Hassan Ali", company: "Acme", notes: "Met through Priya at the Durham founders dinner." },
  ]);

  console.log("Tiers…");
  const tierRows = await db
    .select({ fullName: contacts.fullName, preferredName: contacts.preferredName, tier: nameMatchTierSql("Priya") })
    .from(contacts)
    .where(eq(contacts.userId, U));
  const tiers = Object.fromEntries(tierRows.map((r) => [r.fullName, Number(r.tier)]));
  check("SQL tiers: whole word 0, prefix 1, elsewhere 2", tiers["Priya Raman"] === 0 && tiers["Priyanka Das"] === 1 && tiers["Hassan Ali"] === 2, JSON.stringify(tiers));
  check("JS tiers agree with SQL", tierRows.every((r) => nameMatchTier(r.fullName, r.preferredName, "Priya") === Number(r.tier)));
  check("a full name is a whole-word match", nameMatchTier("Priya Raman", null, "  priya   raman ") === 0);
  check("LIKE metacharacters match literally", nameMatchTier("A_B Corp", null, "a%b") === 2);

  console.log("\nPicker order (name tier, then the alphabetical sort)…");
  const picked = await db
    .select({ fullName: contacts.fullName })
    .from(contacts)
    .where(and(eq(contacts.userId, U), contactSearchCondition("Priya")))
    .orderBy(asc(nameMatchTierSql("Priya")), asc(contacts.sortKey), asc(contacts.fullName), asc(contacts.id));
  check(
    "name hits first, the mention last",
    JSON.stringify(picked.map((r) => r.fullName)) === JSON.stringify(["Priya Raman", "Priyanka Das", "Hassan Ali"]),
    JSON.stringify(picked.map((r) => r.fullName))
  );

  console.log("\nHybrid search…");
  let hits = await hybridSearchContacts(U, { query: "Priya" });
  check(
    "only the two name matches, whole word first",
    JSON.stringify(hits.map((h) => h.fullName)) === JSON.stringify(["Priya Raman", "Priyanka Das"]),
    JSON.stringify(hits.map((h) => [h.fullName, h.matchedArms]))
  );
  hits = await hybridSearchContacts(U, { query: "Durham" });
  check("a word only the notes contain still finds the person", hits.some((h) => h.fullName === "Hassan Ali"), JSON.stringify(hits.map((h) => h.fullName)));
  hits = await hybridSearchContacts(U, { query: "Loom" });
  check("a company match is kept", hits[0]?.fullName === "Priya Raman", JSON.stringify(hits.map((h) => h.fullName)));
});
```

- [ ] **Step 2: Register and run; expect failure** — add `"smoke-contact-search-rank": "pglite",` to the pglite block. Run `npx tsx scripts/smoke-contact-search-rank.ts`; expected: exits 1, `Cannot find module '../src/lib/contact-search-rank'`.

- [ ] **Step 3: Create `src/lib/contact-search-rank.ts`**:

```ts
/**
 * How well a contact's NAME answers a search, in one place for SQL (list and picker
 * ordering) and JS (hybrid search). No `@/db` import: schema and drizzle only.
 *
 * Tier 0: the query is the whole name or a whole word of it ("priya" in "Priya Raman").
 * Tier 1: a word of the name starts with it ("priya" in "Priyanka Das").
 * Tier 2: it matched somewhere else — company, tags, notes.
 */
import { sql, type SQL } from "drizzle-orm";
import { contacts } from "@/db/schema";

export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export function normalizeSearchQuery(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, " ");
}

export function nameMatchTier(fullName: string, preferredName: string | null | undefined, query: string): 0 | 1 | 2 {
  const q = normalizeSearchQuery(query);
  if (!q) return 2;
  let tier: 0 | 1 | 2 = 2;
  for (const raw of [fullName, preferredName ?? ""]) {
    const n = raw.trim().toLowerCase();
    if (!n) continue;
    if (n === q || n.startsWith(`${q} `) || n.endsWith(` ${q}`) || n.includes(` ${q} `)) return 0;
    if (n.startsWith(q) || n.includes(` ${q}`)) tier = 1;
  }
  return tier;
}

/** The same tiers as a SQL expression. Must agree with `nameMatchTier` (the smoke checks). */
export function nameMatchTierSql(query: string): SQL<number> {
  const q = normalizeSearchQuery(query);
  const e = escapeLike(q);
  const name = sql`lower(btrim(${contacts.fullName}))`;
  const pref = sql`lower(btrim(coalesce(${contacts.preferredName}, '')))`;
  const whole = (col: SQL) =>
    sql`(${col} = ${q} or ${col} like ${`${e} %`} or ${col} like ${`% ${e}`} or ${col} like ${`% ${e} %`})`;
  const prefix = (col: SQL) => sql`(${col} like ${`${e}%`} or ${col} like ${`% ${e}%`})`;
  return sql<number>`(case when ${whole(name)} or ${whole(pref)} then 0 when ${prefix(name)} or ${prefix(pref)} then 1 else 2 end)`;
}

/**
 * Match a query against the stored search vector, fuzzily against names, and against tags.
 * Moved unchanged from `searchCondition` in src/actions/contacts.ts (a "use server" file
 * cannot export it), so the contacts list, the picker and the smoke share one condition.
 *
 * Four branches because they answer different questions. `search_tsv` is whole-word and
 * ranked, and covers everything on the contact row. The `%` prefix match is kept for the
 * partial-word case a user typing into a filter box expects. Trigram similarity finds a
 * name spelled one character off; it is index-backed via `contacts_name_trgm`, so it is
 * only added for queries long enough to produce meaningful trigrams. Tags live in their
 * own table, so they are an EXISTS. `search_tsv` is a bare identifier because Drizzle has
 * no tsvector column type; the query selects `from contacts` unaliased, so it resolves.
 */
export function contactSearchCondition(q: string) {
  const like = `${q.toLowerCase()}%`;
  const lowered = q.toLowerCase();
  const fuzzy =
    lowered.length >= 4
      ? sql` or lower(${contacts.fullName}) % ${lowered} or lower(coalesce(${contacts.company}, '')) % ${lowered}`
      : sql``;
  return sql`(
    contacts.search_tsv @@ websearch_to_tsquery('simple', ${q})
    or lower(${contacts.fullName}) like ${like}
    or lower(coalesce(${contacts.company}, '')) like ${like}
    or lower(coalesce(${contacts.email}, '')) like ${like}
    ${fuzzy}
    or exists (
      select 1 from contact_tags ct
      join tags t on t.id = ct.tag_id
      where ct.contact_id = ${contacts.id} and lower(t.name) like ${like}
    )
  )`;
}

export type NamePolicyRow = {
  fullName: string;
  preferredName: string | null;
  company: string | null;
  title: string | null;
  school: string | null;
  email: string | null;
  location: string | null;
  industry: string | null;
  tags: string[];
  keyFacts: string[];
  matchedArms: string[];
};

function wordStarts(text: string | null, q: string): boolean {
  return Boolean(text) && text!.toLowerCase().split(/[^a-z0-9]+/).some((w) => w.startsWith(q));
}

/** The query appears nowhere on the row but the prose (notes, AI summary). */
function proseOnly(row: NamePolicyRow, q: string): boolean {
  if (row.matchedArms.includes("semantic") || row.matchedArms.includes("experience")) return false;
  const fields = [row.company, row.title, row.school, row.email, row.location, row.industry, ...row.tags, ...row.keyFacts];
  return !fields.some((f) => wordStarts(f, q));
}

/**
 * For a single-token query: name matches first (tier 0, then 1, each in fused order),
 * everything else after; and when at least one name matched, rows whose only evidence is
 * prose are dropped — a name lookup is not a notes search. With no name match nothing is
 * dropped, so "Durham" still finds whoever's notes say Durham. Multi-token queries pass
 * through unchanged.
 */
export function applyNameMatchPolicy<T extends NamePolicyRow>(rows: T[], query: string): T[] {
  const q = normalizeSearchQuery(query);
  if (!q || q.includes(" ")) return rows;
  const tiered = rows.map((row, i) => ({ row, i, tier: nameMatchTier(row.fullName, row.preferredName, q) }));
  const anyName = tiered.some((t) => t.tier < 2);
  return tiered
    .filter((t) => !anyName || t.tier < 2 || !proseOnly(t.row, q))
    .sort((a, b) => a.tier - b.tier || a.i - b.i)
    .map((t) => t.row);
}
```

Then delete lines 261-298 of `src/actions/contacts.ts` (the doc comment starting `Match a query against the stored search vector` and `function searchCondition(q: string) { … }`); `contactSearchCondition` above is the same code.

- [ ] **Step 4: Wire the picker** — in `src/actions/contacts.ts` add `import { contactSearchCondition, nameMatchTierSql } from "@/lib/contact-search-rank";` beside the other `@/lib` imports; line 327 becomes `if (term) conditions.push(contactSearchCondition(term));`; line 136 (in `listContactsPage`) becomes `if (q) conditions.push(contactSearchCondition(q));`; replace the `.orderBy(` argument list at lines 343-352 with:

```ts
    .orderBy(
      // Name matches first, so "Priya" opens on Priya rather than on whoever sorts first
      // among the people whose notes mention her.
      ...(term ? [asc(nameMatchTierSql(term))] : []),
      ...(order === "recent"
        ? [
            // Never-spoken-to contacts fall to the back and sort alphabetically among
            // themselves, so the tail is still browsable rather than arbitrary.
            sql`${contacts.lastInteractionAt} desc nulls last`,
            asc(contacts.sortKey),
          ]
        : [asc(contacts.sortKey), asc(contacts.fullName), asc(contacts.id)])
    )
```

- [ ] **Step 5: Wire hybrid search** — in `src/lib/hybrid-search.ts` add after line 11 `import { applyNameMatchPolicy } from "@/lib/contact-search-rank";` and replace line 581:

```ts
  let results = normalizeToOwnMax(hydrated);
```

with:

```ts
  // Name matches first for a one-word lookup, and a note that merely mentions the name
  // does not sit beside the person it names. See `applyNameMatchPolicy`.
  let results = applyNameMatchPolicy(normalizeToOwnMax(hydrated), options.query);
```

- [ ] **Step 6: Run the tests; expect pass** — `npx tsx scripts/smoke-contact-search-rank.ts`, `npx tsx scripts/smoke-hybrid-search.ts` (its one-word queries "Hopper", "ada", "London", "engineer", "wildcard" keep passing: no row is prose-only where a name matched), `npx tsx scripts/smoke-dashboard-search.ts`, `npx tsx scripts/smoke-chat-retrieval.ts`: all `ok`.

- [ ] **Step 7: Typecheck, lint** — `npm run typecheck && npm run lint`: 0 errors.

- [ ] **Step 8: Browser check** — start `orbit-web`, press Cmd+K and type a first name that appears in the seeded demo workspace both as a contact name and inside another contact's notes (pick one from `/knowledge`). Expected: the named person is the first result. In the floating ask bar, the same word lists name matches first and no notes-only mention.

- [ ] **Step 9: Commit**

```bash
git add src/lib/contact-search-rank.ts src/actions/contacts.ts src/lib/hybrid-search.ts scripts/smoke-contact-search-rank.ts scripts/run-smoke.ts
git commit -m "$(cat <<'EOF'
Rank name matches first in contact search

A one-word search listed people whose notes mentioned the name beside, or in the
palette ahead of, the person with that name. One name-tier definition now orders
pickers and hybrid search, and drops prose-only hits when a name matched.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: The contacts page ranks name matches first, across pages (C2, part b)

**Root cause (verified):** `listContactsPage` (`src/actions/contacts.ts:123-210`) filters with the search condition and then orders by the chosen sort only (`orderFor`, `:224-232`); with the default name sort "Hassan Ali" (sort key `ali`) lists before "Priya Raman" (`raman`). The list is keyset-paged, so the name tier has to lead the ORDER BY *and* the cursor. The cursor helpers move to a DB-free lib module (a `"use server"` file cannot export them) so a smoke can walk pages with the real functions.

**Files:**
- Create: `src/lib/contacts-page-cursor.ts`
- Modify: `src/actions/contacts.ts:88-109` (delete cursor type/encode/decode), `:131`, `:135-137`, `:167-175`, `:208`, `:212-259` (delete `orderFor`/`cursorCondition`/`cursorFor`)
- Create: `scripts/smoke-contacts-search-paging.ts`; Modify: `scripts/run-smoke.ts` (pglite)

**Interfaces:**
- Consumes: `nameMatchTierSql`, `contactSearchCondition` (Task 5).
- Produces (`src/lib/contacts-page-cursor.ts`): `ContactsCursor` (the old `Cursor` plus optional `t: number`), `encodeContactsCursor(c: ContactsCursor): string`, `decodeContactsCursor(raw: string | undefined, sort: ContactSort, searching: boolean): ContactsCursor | null`, `contactsOrderBy(sort: ContactSort, tier: SQL<number> | null): SQL[]`, `contactsCursorCondition(cursor: ContactsCursor, tier: SQL<number> | null): SQL`, `contactsCursorFor(sort: ContactSort, row: CursorRow, searching: boolean): ContactsCursor`.

- [ ] **Step 1: Write the failing test** — `scripts/smoke-contacts-search-paging.ts`:

```ts
/**
 * A search on the contacts page lists name matches first in every sort, and keyset paging
 * (one row per page here) neither skips nor repeats anyone across the tier boundary.
 * Run: npx tsx scripts/smoke-contacts-search-paging.ts
 */
import "./smoke/_env";

import { and, eq, type SQL } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts } from "../src/db/schema";
import { contactsListSelection } from "../src/lib/contact-avatar-sql";
import { contactSearchCondition, nameMatchTierSql } from "../src/lib/contact-search-rank";
import {
  contactsCursorCondition,
  contactsCursorFor,
  contactsOrderBy,
  decodeContactsCursor,
  encodeContactsCursor,
} from "../src/lib/contacts-page-cursor";
import type { ContactSort } from "../src/lib/contacts-page";
import { run } from "./smoke/_env";

const U = "smoke-contacts-search-paging-user";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

/** listContactsPage's query, one row per page (limit 1, fetch 2). */
async function walk(sort: ContactSort, q: string): Promise<string[]> {
  const db = await getDb();
  const tier = nameMatchTierSql(q);
  const seen: string[] = [];
  let raw: string | undefined;
  for (let i = 0; i < 20; i++) {
    const cursor = decodeContactsCursor(raw, sort, true);
    const conditions: SQL[] = [eq(contacts.userId, U), contactSearchCondition(q)];
    if (cursor) conditions.push(contactsCursorCondition(cursor, tier));
    const rows = await db
      .select({ ...contactsListSelection, nameTier: tier })
      .from(contacts)
      .where(and(...conditions))
      .orderBy(...contactsOrderBy(sort, tier))
      .limit(2);
    const page = rows.slice(0, 1);
    seen.push(...page.map((r) => r.fullName));
    if (rows.length <= 1) break;
    raw = encodeContactsCursor(contactsCursorFor(sort, page[0], true));
  }
  return seen;
}

run(async () => {
  const db = await getDb();
  await db.delete(contacts).where(eq(contacts.userId, U));
  await db.insert(contacts).values([
    { userId: U, fullName: "Priya Raman", closeness: 95, updatedAt: new Date("2026-09-02T12:00:00Z") },
    { userId: U, fullName: "Priya Nair", closeness: 90, updatedAt: new Date("2026-09-01T12:00:00Z") },
    { userId: U, fullName: "Priyanka Das", closeness: 50, updatedAt: new Date("2026-09-03T12:00:00Z") },
    { userId: U, fullName: "Hassan Ali", closeness: 99, updatedAt: new Date("2026-09-04T12:00:00Z"), notes: "Met through Priya at the Durham founders dinner." },
  ]);

  const expect = {
    name: ["Priya Nair", "Priya Raman", "Priyanka Das", "Hassan Ali"],
    closeness: ["Priya Raman", "Priya Nair", "Priyanka Das", "Hassan Ali"],
    recent: ["Priya Raman", "Priya Nair", "Priyanka Das", "Hassan Ali"],
  } as const;
  for (const sort of ["name", "closeness", "recent"] as const) {
    const got = await walk(sort, "Priya");
    check(`${sort}: name tiers lead, the notes mention is last, nobody twice`, JSON.stringify(got) === JSON.stringify(expect[sort]), JSON.stringify(got));
  }

  const plain = encodeContactsCursor({ s: "name", k: "ali", n: "Hassan Ali", id: "00000000-0000-0000-0000-000000000000" });
  check("a cursor minted without a search is refused by a search", decodeContactsCursor(plain, "name", true) === null);
  check("and accepted without one", decodeContactsCursor(plain, "name", false) !== null);
  check("no search, no tier in the ORDER BY", contactsOrderBy("name", null).length === 3);
});
```

- [ ] **Step 2: Register and run; expect failure** — add `"smoke-contacts-search-paging": "pglite",`. Run it; expected: exits 1, `Cannot find module '../src/lib/contacts-page-cursor'`.

- [ ] **Step 3: Create `src/lib/contacts-page-cursor.ts`**:

```ts
/**
 * Keyset paging for the contacts list, moved out of src/actions/contacts.ts so it can be
 * exercised by `scripts/smoke-contacts-search-paging.ts`. DB-free.
 *
 * Every ordering ends in `id`, so it is a total order — without that tiebreak two contacts
 * comparing equal can straddle a page boundary and be shown twice or skipped. The tiebreak
 * runs in the same direction as the column ahead of it, because cursors are row-value
 * comparisons and that form compares every element the same way.
 *
 * During a search the name-match tier (`nameMatchTierSql`: 0 whole word, 1 prefix, 2
 * elsewhere) leads every sort, ascending, and the cursor carries the last row's tier as `t`.
 * The tier is compared on its own — `tier > t or (tier = t and <sort's row comparison>)` —
 * because it runs ascending while the closeness and recent sorts run descending.
 */
import { asc, desc, sql, type SQL } from "drizzle-orm";
import { contacts } from "@/db/schema";
import type { ContactSort } from "@/lib/contacts-page";

export type ContactsCursor =
  | { s: "name"; k: string; n: string; id: string; t?: number }
  | { s: "closeness"; c: number; id: string; t?: number }
  | { s: "recent"; u: string; id: string; t?: number };

type CursorRow = { id: string; sortKey: string | null; fullName: string; closeness: number | null; updatedAt: Date; nameTier: number };

export function encodeContactsCursor(cursor: ContactsCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeContactsCursor(raw: string | undefined, sort: ContactSort, searching: boolean): ContactsCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    // A cursor from a different sort, or from a search when this is not one (or the other
    // way round), describes a position that does not exist in this ordering.
    if (!parsed || parsed.s !== sort) return null;
    if (searching !== (typeof parsed.t === "number")) return null;
    return parsed as ContactsCursor;
  } catch {
    return null;
  }
}

export function contactsOrderBy(sort: ContactSort, tier: SQL<number> | null): SQL[] {
  const lead = tier ? [asc(tier)] : [];
  if (sort === "closeness") return [...lead, desc(contacts.closeness), desc(contacts.id)];
  if (sort === "recent") return [...lead, desc(contacts.updatedAt), desc(contacts.id)];
  return [...lead, asc(contacts.sortKey), asc(contacts.fullName), asc(contacts.id)];
}

function sortCondition(cursor: ContactsCursor): SQL {
  if (cursor.s === "closeness") {
    return sql`(${contacts.closeness}, ${contacts.id}) < (${cursor.c}, ${cursor.id}::uuid)`;
  }
  if (cursor.s === "recent") {
    return sql`(${contacts.updatedAt}, ${contacts.id}) < (${new Date(cursor.u)}, ${cursor.id}::uuid)`;
  }
  // Row-value comparison rather than an unrolled OR chain, so the planner can satisfy it
  // straight from `contacts_user_sort_idx`.
  return sql`(${contacts.sortKey}, ${contacts.fullName}, ${contacts.id}) > (${cursor.k}, ${cursor.n}, ${cursor.id}::uuid)`;
}

export function contactsCursorCondition(cursor: ContactsCursor, tier: SQL<number> | null): SQL {
  const within = sortCondition(cursor);
  if (!tier) return within;
  const t = cursor.t ?? 0;
  return sql`(${tier} > ${t}::int or (${tier} = ${t}::int and ${within}))`;
}

export function contactsCursorFor(sort: ContactSort, row: CursorRow, searching: boolean): ContactsCursor {
  const t = searching ? { t: Number(row.nameTier) } : {};
  if (sort === "closeness") return { s: "closeness", c: row.closeness ?? 0, id: row.id, ...t };
  if (sort === "recent") return { s: "recent", u: new Date(row.updatedAt).toISOString(), id: row.id, ...t };
  return { s: "name", k: row.sortKey ?? "", n: row.fullName, id: row.id, ...t };
}
```

- [ ] **Step 4: Wire `listContactsPage`** — in `src/actions/contacts.ts`:
  - Add imports: `import { contactsCursorCondition, contactsCursorFor, contactsOrderBy, decodeContactsCursor, encodeContactsCursor } from "@/lib/contacts-page-cursor";` (Task 5 already imported `contactSearchCondition, nameMatchTierSql`).
  - Delete lines 88-109 (`/** Ordering position of the last row…` through the end of `decodeCursor`) and lines 212-259 (the `Every ordering ends in id` comment, `orderFor`, `cursorCondition`, `cursorFor`). Line numbers below refer to the file before these deletions; apply the replacements first, then delete.
  - Line 131 becomes `const cursor = decodeContactsCursor(filters?.cursor, sort, Boolean(filters?.q?.trim()));`
  - After line 136 (`if (q) conditions.push(contactSearchCondition(q));`) add `const tier = q ? nameMatchTierSql(q) : null;`
  - Line 167 becomes `if (cursor) conditions.push(contactsCursorCondition(cursor, tier));`
  - Lines 170 and 173 become:

    ```ts
        .select({ ...contactsListSelection, nameTier: tier ?? sql<number>`2` })
    ```

    ```ts
        .orderBy(...contactsOrderBy(sort, tier))
    ```
  - Line 208 becomes `nextCursor: hasMore ? encodeContactsCursor(contactsCursorFor(sort, page[page.length - 1], Boolean(tier))) : null,`

- [ ] **Step 5: Run the tests; expect pass** — `npx tsx scripts/smoke-contacts-search-paging.ts`, `npx tsx scripts/smoke-contact-search-rank.ts`, `npx tsx scripts/smoke-contacts-page.ts`, `npx tsx scripts/smoke-page-budgets.ts`: all `ok`.

- [ ] **Step 6: Typecheck, lint** — `npm run typecheck && npm run lint`: 0 errors (`asc` and `desc` stay imported in contacts.ts; `getContact`, `searchContactsForPicker` and the action-items query still use them).

- [ ] **Step 7: Browser check** — start `orbit-web`, open `/contacts?q=<the first name you used in Task 5>`. Expected: people with that name first; the notes-only mention after them; scrolling to the end loads no duplicates. Repeat with `&sort=closeness`.

- [ ] **Step 8: Commit**

```bash
git add src/lib/contacts-page-cursor.ts src/actions/contacts.ts scripts/smoke-contacts-search-paging.ts scripts/run-smoke.ts
git commit -m "$(cat <<'EOF'
List name matches first when searching the contacts page

The name-match tier now leads every sort during a search and rides in the keyset
cursor, so paging stays exact. Cursor helpers move to a DB-free module the smoke
walks directly.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: 44 px touch targets on small icon buttons (C3)

**Verified:** `Button size="icon-sm"` is `size-7` (28 px), `icon-xs` is `size-6`, `icon` is `size-8` (`src/components/ui/button.tsx:28-32`). The contacts row's LinkedIn, follow-up and delete buttons are `icon-sm` in a `gap-1` cluster (`src/components/contacts/contacts-list.tsx:545`, `:553-570`, `:946-966`, `:1020-1041`). Fix without resizing any icon: a `tap-target` utility adds a centered, invisible `::after` at least 44×44 on coarse pointers only; each cluster gets enough gap on coarse pointers that two enlarged areas never overlap (28 px buttons need 16 px, `gap-4`; 32 px buttons need 12 px, `gap-3`). Tailwind 4.3.3 ships the `pointer-coarse:` variant.

**Buttons changed (12 in 7 files):**

| File | Button (line) | Size | Cluster gap added |
|---|---|---|---|
| `src/components/contacts/contacts-list.tsx` | LinkedIn (553), follow-up PopoverTrigger (946), delete (1020) | 28 px | `:545` `pointer-coarse:gap-4` |
| `src/components/capture/capture-summary.tsx` | "Set … aside" (153) | 28 px | none (row gap is 12 px beside an 8 px overhang) |
| `src/components/capture/capture-source-card.tsx` | previous / next photo (181, 190) | 28 px, `absolute` | none (opposite edges) |
| `src/components/capture/ignored-people-section.tsx` | "Forget …" (131) | 28 px | none (row `gap-3`) |
| `src/components/reminders/reminder-card.tsx` | edit (286) | 28 px | `:285` `pointer-coarse:gap-4` |
| `src/components/reminders/reminder-done-snooze.tsx` | done (34), snooze (54) | 28 px | `:33` `pointer-coarse:gap-4` |
| `src/components/reminders/suggested-reminders-panel.tsx` | edit, confirm, discard (182, 191, 207) | 32 px | `:181` `pointer-coarse:gap-3` |

Out of scope, recorded for a later pass: `reminder-list-sidebar.tsx` (list rename/delete, `icon-xs`) is the lists rail, not the reminders list the audit measured.

**Files:** Modify `src/app/globals.css` (append utility) and the seven components above; Create `scripts/smoke-tap-targets.ts`; Modify `scripts/run-smoke.ts` (pure).

**Interfaces:** Produces the CSS utility `tap-target` (needs a positioned element: `relative`, or the button's existing `absolute`). Task 8's scanner is independent.

- [ ] **Step 1: Write the failing test** — `scripts/smoke-tap-targets.ts`:

```ts
/**
 * Every small icon button on the touch surfaces the audit measured carries `tap-target`,
 * and each crowded cluster widens its gap on coarse pointers so hit areas never overlap.
 * Pure: parses the TSX with the TypeScript compiler, touches no database.
 * Run: npx tsx scripts/smoke-tap-targets.ts
 */
import { readFileSync } from "node:fs";
import ts from "typescript";

const FILES: Record<string, number> = {
  "src/components/contacts/contacts-list.tsx": 3,
  "src/components/capture/capture-summary.tsx": 1,
  "src/components/capture/capture-source-card.tsx": 2,
  "src/components/capture/ignored-people-section.tsx": 1,
  "src/components/reminders/reminder-card.tsx": 1,
  "src/components/reminders/reminder-done-snooze.tsx": 2,
  "src/components/reminders/suggested-reminders-panel.tsx": 3,
};
const CLUSTER_GAPS: Array<[string, string]> = [
  ["src/components/contacts/contacts-list.tsx", "pointer-coarse:gap-4"],
  ["src/components/reminders/reminder-card.tsx", "pointer-coarse:gap-4"],
  ["src/components/reminders/reminder-done-snooze.tsx", "pointer-coarse:gap-4"],
  ["src/components/reminders/suggested-reminders-panel.tsx", "pointer-coarse:gap-3"],
];
const SMALL = new Set(["icon-xs", "icon-sm", "icon"]);

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

function attr(el: ts.JsxOpeningLikeElement, name: string): ts.JsxAttribute | undefined {
  return el.attributes.properties.find((p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === name);
}

/** `size="icon-sm"`, or `buttonVariants({ …, size: "icon-sm" })` inside className. */
function sizeOf(el: ts.JsxOpeningLikeElement): string | null {
  const size = attr(el, "size");
  if (size?.initializer && ts.isStringLiteral(size.initializer)) return size.initializer.text;
  const m = (attr(el, "className")?.getText() ?? "").match(/size:\s*"([a-z-]+)"/);
  return m ? m[1] : null;
}

for (const [file, expected] of Object.entries(FILES)) {
  const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let small = 0;
  ts.forEachChild(sf, function visit(node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const size = sizeOf(node);
      if (size && SMALL.has(size)) {
        small += 1;
        const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        const cls = attr(node, "className")?.getText() ?? "";
        check(`${file}:${line} has tap-target`, /\btap-target\b/.test(cls), cls || "(no className)");
      }
    }
    ts.forEachChild(node, visit);
  });
  check(`${file} still has its ${expected} small icon button(s)`, small === expected, `found ${small}`);
}
for (const [file, gap] of CLUSTER_GAPS) {
  check(`${file} widens its cluster with ${gap}`, readFileSync(file, "utf8").includes(gap));
}
check("globals.css defines the utility", /@utility tap-target\b/.test(readFileSync("src/app/globals.css", "utf8")));

if (failures) {
  console.error(`\nsmoke-tap-targets: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nsmoke-tap-targets: ok");
process.exit(0);
```

- [ ] **Step 2: Register and run; expect failure** — add `"smoke-tap-targets": "pure",`. Run it; expected: exits 1 with twelve `FAIL … has tap-target` lines, four `FAIL … widens its cluster`, and `FAIL globals.css defines the utility`.

- [ ] **Step 3: Add the utility** — append to `src/app/globals.css`:

```css
/*
 * A 44px touch target on an icon button smaller than that, without moving or resizing the
 * icon. Coarse pointers only: with a mouse the painted button is the target. The element
 * must be positioned (relative or absolute). Neighbours in one row need enough gap that two
 * enlarged areas never overlap: pointer-coarse:gap-4 beside 28px buttons, gap-3 beside 32px.
 */
@utility tap-target {
  @media (pointer: coarse) {
    &::after {
      content: "";
      position: absolute;
      top: 50%;
      left: 50%;
      width: max(100%, 2.75rem);
      height: max(100%, 2.75rem);
      transform: translate(-50%, -50%);
    }
  }
}
```

- [ ] **Step 4: Apply it** — exact className edits (everything else on each element unchanged):
  - `contacts-list.tsx:545` `"flex shrink-0 items-center gap-1"` → `"flex shrink-0 items-center gap-1 pointer-coarse:gap-4"`
  - `contacts-list.tsx` LinkedIn Button (`aria-label={\`Open ${c.fullName} on LinkedIn\`}`) `className="shrink-0 text-muted-foreground"` → `className="tap-target relative shrink-0 text-muted-foreground"`
  - `contacts-list.tsx:959` in the follow-up `PopoverTrigger` `"relative shrink-0 text-muted-foreground",` → `"tap-target relative shrink-0 text-muted-foreground",`
  - `contacts-list.tsx:1032` in `DeleteRowButton` `"shrink-0 text-muted-foreground",` → `"tap-target relative shrink-0 text-muted-foreground",`
  - `capture-summary.tsx:157` `className="text-muted-foreground"` → `className="tap-target relative text-muted-foreground"`
  - `capture-source-card.tsx:184` → `className="tap-target absolute top-1/2 left-2 -translate-y-1/2 rounded-full opacity-90"`; `:193` → `className="tap-target absolute top-1/2 right-2 -translate-y-1/2 rounded-full opacity-90"`
  - `ignored-people-section.tsx:135` `className="text-muted-foreground"` → `className="tap-target relative text-muted-foreground"`
  - `reminder-card.tsx:285` `"flex shrink-0 items-start gap-1"` → `"flex shrink-0 items-start gap-1 pointer-coarse:gap-4"`; `:290` `className="text-muted-foreground"` → `className="tap-target relative text-muted-foreground"`
  - `reminder-done-snooze.tsx:33` `<div className="flex gap-1">` → `<div className="flex gap-1 pointer-coarse:gap-4">`; on both Buttons (lines 34 and 54) add the prop `className="tap-target relative"`
  - `suggested-reminders-panel.tsx:181` `"flex shrink-0 items-center gap-1"` → `"flex shrink-0 items-center gap-1 pointer-coarse:gap-3"`; on the three `size="icon"` Buttons (182, 191, 207) add `className="tap-target relative"`

- [ ] **Step 5: Run the test; expect pass** — `npx tsx scripts/smoke-tap-targets.ts`: all `ok`.

- [ ] **Step 6: Typecheck, lint** — `npm run typecheck && npm run lint`: 0 errors.

- [ ] **Step 7: Browser check at 375 px** — start `orbit-web`; set the pane to the `mobile` preset, open `/contacts`, reload. Run in the page:

```js
(() => {
  const coarse = matchMedia("(pointer: coarse)").matches;
  const b = document.querySelector('button[aria-label^="Delete "]');
  const r = b.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top - 6);
  return { coarse, button: [r.width, r.height], after: getComputedStyle(b, "::after").width, hitIsButton: b === hit || b.contains(hit) };
})()
```

Expected: `coarse: true`, `button: [28, 28]` (icon unchanged), `after: "44px"`, `hitIsButton: true`. If the pane reports `coarse: false`, confirm the compiled rule instead — `[...document.styleSheets].flatMap((s) => { try { return [...s.cssRules]; } catch { return []; } }).some((r) => r.cssText.includes("pointer: coarse") && r.cssText.includes("tap-target"))` returns `true` — and note in the commit that geometry was checked by rule only (the roadmap's acceptance step 13 re-checks on phones). Take a screenshot: icons look identical to before. Reset the preset to `desktop`.

- [ ] **Step 8: Commit**

```bash
git add src/app/globals.css src/components/contacts/contacts-list.tsx src/components/capture/capture-summary.tsx src/components/capture/capture-source-card.tsx src/components/capture/ignored-people-section.tsx src/components/reminders/reminder-card.tsx src/components/reminders/reminder-done-snooze.tsx src/components/reminders/suggested-reminders-panel.tsx scripts/smoke-tap-targets.ts scripts/run-smoke.ts
git commit -m "$(cat <<'EOF'
Give small icon buttons a 44px touch target on phones

A tap-target utility adds an invisible centered hit area on coarse pointers, and
crowded clusters widen their gap there, so row icons stay 28px but take a finger.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Every icon-only button has an accessible name (C8)

**Verified in source:** the Integrations dialog tabs are `role="tab"` buttons whose text content (label plus an `sr-only` status) names them (`src/components/settings/integrations-dialog.tsx:336-368`); the AI provider and model selects use `aria-labelledby` on Base UI `SelectTrigger`, and Base UI merges the caller's `aria-labelledby` after its own (`node_modules/@base-ui/react/select/trigger/SelectTrigger.js:128-137`), so both should be named. The audit's "unnamed" reading was likely Base UI's hidden native input. This task confirms that in the accessibility tree and adds a repo-wide guard. The guard below was run against `origin/main` 33a213c while writing this plan and reports exactly four real hits, fixed here:

| Hit | Fix |
|---|---|
| `src/components/dashboard/suggestion-row.tsx:148` (X, dismiss) | `aria-label={\`Dismiss suggestion for ${contactName}\`}` |
| `src/components/graph/network-graph.tsx:898` (Filter popover trigger) | `aria-label="Filters"` |
| `src/components/settings/api-settings.tsx:153` (Copy) | `aria-label={created.mcpUrl ? "Copy MCP URL" : "Copy key"}` |
| `src/components/settings/goals-settings.tsx:37` (Trash, remove goal) | `aria-label={\`Remove goal: ${g.text}\`}` |

**Files:** Create `scripts/smoke-icon-button-names.ts`; Modify `scripts/run-smoke.ts` (pure) and the four components; conditionally `src/components/settings/ai-settings.tsx:3`, `:65-78`, `:125-141`.

**Interfaces:** none produced for other tasks.

- [ ] **Step 1: Write the failing test** — `scripts/smoke-icon-button-names.ts`:

```ts
/**
 * Icon-only buttons need a name a screen reader can say. Walks every .tsx under
 * src/components with the TypeScript parser and flags a button-like element (button,
 * Button, *Trigger, *Close) whose children render no text and that has no aria-label,
 * aria-labelledby, title or children prop.
 *
 * Counted as text: non-blank JSX text, any expression that is not an element or a literal
 * null/false/true/undefined, an element with an sr-only className, and any non-icon element
 * containing text. Icons are lucide-react imports, identifiers ending in Icon, and svg.
 * Allowlisted by pattern: a spread prop (the name may arrive in it), a render prop (the
 * rendered element is the button), a Button written as another element's render value, and
 * a self-closing custom component (it names itself where it is defined).
 * Run: npx tsx scripts/smoke-icon-button-names.ts
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const ROOT = "src/components";
const BUTTON_TAG = /^(button|Button|[A-Z][A-Za-z]*Trigger|[A-Z][A-Za-z]*Close)$/;
const NAME_ATTRS = new Set(["aria-label", "aria-labelledby", "title", "children", "render"]);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return p.endsWith(".tsx") ? [p] : [];
  });
}

function iconNames(sf: ts.SourceFile): Set<string> {
  const icons = new Set<string>(["svg"]);
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const bindings = stmt.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    const fromLucide = stmt.moduleSpecifier.text === "lucide-react";
    for (const el of bindings.elements) if (fromLucide || /Icon$/.test(el.name.text)) icons.add(el.name.text);
  }
  ts.forEachChild(sf, function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name && /Icon$/.test(node.name.text)) icons.add(node.name.text);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && /Icon$/.test(node.name.text)) icons.add(node.name.text);
    ts.forEachChild(node, visit);
  });
  return icons;
}

const tagOf = (n: ts.JsxOpeningLikeElement) => n.tagName.getText();
const attrsOf = (n: ts.JsxOpeningLikeElement) => n.attributes.properties;
const hasSrOnly = (n: ts.JsxOpeningLikeElement) =>
  attrsOf(n).some((a) => ts.isJsxAttribute(a) && a.name.getText() === "className" && /sr-only/.test(a.getText()));

function exprGivesText(expr: ts.Expression | undefined, icons: Set<string>): boolean {
  if (!expr) return false;
  if (ts.isParenthesizedExpression(expr)) return exprGivesText(expr.expression, icons);
  if (ts.isConditionalExpression(expr)) return exprGivesText(expr.whenTrue, icons) || exprGivesText(expr.whenFalse, icons);
  if (ts.isBinaryExpression(expr)) {
    const k = expr.operatorToken.kind;
    if (k === ts.SyntaxKind.AmpersandAmpersandToken) return exprGivesText(expr.right, icons);
    if (k === ts.SyntaxKind.BarBarToken || k === ts.SyntaxKind.QuestionQuestionToken) return exprGivesText(expr.left, icons) || exprGivesText(expr.right, icons);
  }
  if (ts.isJsxElement(expr) || ts.isJsxSelfClosingElement(expr) || ts.isJsxFragment(expr)) return nodeGivesText(expr, icons);
  if ([ts.SyntaxKind.NullKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.TrueKeyword].includes(expr.kind)) return false;
  if (ts.isIdentifier(expr) && expr.text === "undefined") return false;
  return true;
}

function nodeGivesText(node: ts.Node, icons: Set<string>): boolean {
  if (ts.isJsxText(node)) return node.text.trim().length > 0;
  if (ts.isJsxExpression(node)) return exprGivesText(node.expression, icons);
  if (ts.isJsxSelfClosingElement(node)) {
    if (icons.has(tagOf(node))) return false;
    if (hasSrOnly(node)) return true;
    return !/^[a-z]/.test(tagOf(node)) || attrsOf(node).some((a) => ts.isJsxAttribute(a) && a.name.getText() === "children");
  }
  if (ts.isJsxElement(node)) {
    if (icons.has(tagOf(node.openingElement))) return false;
    if (hasSrOnly(node.openingElement)) return true;
    return node.children.some((c) => nodeGivesText(c, icons));
  }
  if (ts.isJsxFragment(node)) return node.children.some((c) => nodeGivesText(c, icons));
  return false;
}

const hits: string[] = [];
for (const file of walk(ROOT)) {
  const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const icons = iconNames(sf);
  ts.forEachChild(sf, function visit(node) {
    const open = ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : null;
    if (open && BUTTON_TAG.test(tagOf(open))) {
      const selfClosing = ts.isJsxSelfClosingElement(node);
      const asRenderValue = selfClosing && ts.isJsxExpression(node.parent) && ts.isJsxAttribute(node.parent.parent) && node.parent.parent.name.getText() === "render";
      const selfClosingComponent = selfClosing && !/^(button|Button)$/.test(tagOf(open));
      const named = attrsOf(open).some((p) => ts.isJsxSpreadAttribute(p) || (ts.isJsxAttribute(p) && NAME_ATTRS.has(p.name.getText())));
      const text = ts.isJsxElement(node) && node.children.some((c) => nodeGivesText(c, icons));
      if (!asRenderValue && !selfClosingComponent && !named && !text) {
        hits.push(`${file}:${sf.getLineAndCharacterOfPosition(open.getStart()).line + 1} <${tagOf(open)}>`);
      }
    }
    ts.forEachChild(node, visit);
  });
}

if (hits.length) {
  console.error(`  FAIL icon-only buttons without an accessible name:\n       ${hits.join("\n       ")}`);
  console.error(`\nsmoke-icon-button-names: ${hits.length} unnamed`);
  process.exit(1);
}
console.log("  ok   every icon-only button in src/components has a name");
console.log("\nsmoke-icon-button-names: ok");
process.exit(0);
```

- [ ] **Step 2: Register and run; expect failure** — add `"smoke-icon-button-names": "pure",`. Run it; expected: exits 1 listing exactly the four files and lines in the table above (line numbers may shift by the edits of earlier tasks; the files will match). If it lists more, add a name to each extra one the same way and list it in the commit message.

- [ ] **Step 3: Name the four buttons** — add the attribute from the table to each opening tag (next to its `size`/`type` props). For `suggestion-row.tsx`, `contactName` is already a prop (line 47); for `goals-settings.tsx`, `g` is the map variable (line 32); for `api-settings.tsx`, `created` is in scope (line 139).

- [ ] **Step 4: Run the test; expect pass** — `npx tsx scripts/smoke-icon-button-names.ts`: `smoke-icon-button-names: ok`.

- [ ] **Step 5: Check the Integrations dialog in the accessibility tree** — start `orbit-web`, open `/settings?integration=ai`, then `read_page` with `filter: "interactive"`. Expected: each tab listed as `tab "AI provider, …"` (label plus status), and the two comboboxes as `combobox "Provider"` and `combobox "Model"`. Record what you saw in the commit message.
  - If, and only if, a tab or combobox has no name: in `src/components/settings/ai-settings.tsx` change line 3 to `import { useId, useState, useTransition } from "react";`, add `const providerLabelId = useId();` and `const modelLabelId = useId();` after line 48, replace `id="provider-label"` / `aria-labelledby="provider-label"` with `id={providerLabelId}` / `aria-labelledby={providerLabelId}`, the same for `model-label` with `modelLabelId`, and add `aria-label="AI provider"` and `aria-label="Model"` to the two `SelectTrigger`s as a fallback. For an unnamed tab, add `aria-label={\`${t.label}, ${statusText(status)}\`}` to the tab `button` in `integrations-dialog.tsx` (around line 336). Re-run `read_page` until every control is named.

- [ ] **Step 6: Typecheck, lint, copy guard** — `npm run typecheck && npm run lint && npx tsx scripts/smoke-toast-copy.ts`: 0 errors, ok.

- [ ] **Step 7: Commit**

```bash
git add scripts/smoke-icon-button-names.ts scripts/run-smoke.ts src/components/dashboard/suggestion-row.tsx src/components/graph/network-graph.tsx src/components/settings/api-settings.tsx src/components/settings/goals-settings.tsx
git commit -m "$(cat <<'EOF'
Name every icon-only button and guard it with a smoke

Four icon-only buttons had no accessible name. A parser-based smoke now fails on
any new one. Integrations dialog tabs and selects checked in the accessibility
tree: <record what read_page showed>.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

(Replace the angle-bracket sentence with what Step 5 showed; add `src/components/settings/ai-settings.tsx` / `integrations-dialog.tsx` to `git add` only if Step 5 changed them.)

---

### Task 9: Setup docs that work, and a demo-sign-in script that says what to do next (C5)

**Verified:** README "Quick start" and the Database table (`README.md:53-83`) use `npm install` and list `npm run db:push`, which no longer exists (`package.json:18` is `db:push:DANGEROUS`); nothing mentions worktrees, the three local configurations, stale `.data/pglite`, the single-writer rule or the OAuth port. `scripts/demo-signin-link.ts:58-64` already exits 1 when the Clerk user is missing, but only says "Run scripts/provision-demo-account.ts first." without the command, the flag, or which instance.

**Files:** Modify `README.md:53-83`; Create `scripts/lib/demo-account-messages.ts`; Modify `scripts/demo-signin-link.ts:29`, `:58-64`; Create `scripts/smoke-demo-signin-message.ts`; Modify `scripts/run-smoke.ts` (pure).

**Interfaces:** Produces `clerkInstanceLabel(secretKey: string): "test" | "live" | "unknown"` and `missingDemoUserMessage(email: string, secretKey: string): string` in `scripts/lib/demo-account-messages.ts`.

- [ ] **Step 1: Write the failing test** — `scripts/smoke-demo-signin-message.ts`:

```ts
/**
 * demo-signin-link's "no such user" message names the exact provisioning command, with
 * the same email and Clerk instance, and never echoes the secret key. Pure.
 * Run: npx tsx scripts/smoke-demo-signin-message.ts
 */
import { clerkInstanceLabel, missingDemoUserMessage } from "./lib/demo-account-messages";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const msg = missingDemoUserMessage("demo@orbit.com", "sk_test_SECRETVALUE123");
check("names the instance", msg.includes("Clerk test instance"), msg);
check("gives the exact command", msg.includes("CLERK_SECRET_KEY=sk_test_… npx tsx scripts/provision-demo-account.ts --email demo@orbit.com"), msg);
check("says to re-run", msg.includes("then run this script again"), msg);
check("never prints the secret", !msg.includes("SECRETVALUE123"));
check("live keys are labelled live", clerkInstanceLabel("sk_live_x") === "live");
check("anything else is unknown", clerkInstanceLabel("whatever") === "unknown");
check("an unknown key gets a placeholder, not the key", missingDemoUserMessage("a@b.co", "whatever").includes("CLERK_SECRET_KEY=<your Clerk secret key>"));

if (failures) {
  console.error(`\nsmoke-demo-signin-message: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nsmoke-demo-signin-message: ok");
process.exit(0);
```

- [ ] **Step 2: Register and run; expect failure** — add `"smoke-demo-signin-message": "pure",`. Run it; expected: exits 1, `Cannot find module './lib/demo-account-messages'`.

- [ ] **Step 3: Implement** — `scripts/lib/demo-account-messages.ts`:

```ts
/**
 * Console copy for the demo-account scripts, apart from them so a pure smoke can check it
 * without calling Clerk. Never echoes a secret: only the key's instance prefix is shown.
 */
export function clerkInstanceLabel(secretKey: string): "test" | "live" | "unknown" {
  if (secretKey.startsWith("sk_test_")) return "test";
  if (secretKey.startsWith("sk_live_")) return "live";
  return "unknown";
}

export function missingDemoUserMessage(email: string, secretKey: string): string {
  const instance = clerkInstanceLabel(secretKey);
  const keyShown = instance === "unknown" ? "<your Clerk secret key>" : `sk_${instance}_…`;
  const where = instance === "unknown" ? "the Clerk instance behind this key" : `the Clerk ${instance} instance behind this key`;
  return [
    `No Clerk user found for ${email} in ${where}.`,
    "Create it first, with the same secret key you just used:",
    `  CLERK_SECRET_KEY=${keyShown} npx tsx scripts/provision-demo-account.ts --email ${email}`,
    "then run this script again.",
  ].join("\n");
}
```

In `scripts/demo-signin-link.ts`, after line 29 (`import { createClerkClient } from "@clerk/backend";`) add `import { missingDemoUserMessage } from "./lib/demo-account-messages";` and replace lines 58-64:

```ts
  if (!user) {
    console.error(
      `No Clerk user found for ${EMAIL}.\n` +
        "Run scripts/provision-demo-account.ts first."
    );
    process.exit(1);
  }
```

with:

```ts
  if (!user) {
    console.error(missingDemoUserMessage(EMAIL, secretKey!));
    process.exit(1);
  }
```

- [ ] **Step 4: Rewrite the README setup sections** — replace `README.md` lines 53-83 (from `## Quick start` through the paragraph ending `Set it to a Neon/Postgres URL for remote data.`) with:

````markdown
## Quick start

```bash
npm ci
cp .env.example .env.local   # leave DATABASE_URL and the Clerk keys unset for local work
npm run db:setup             # create the tables in local PGlite (.data/pglite)
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) (or the port Next prints if 3000 is taken). Add a Gemini, OpenAI or Anthropic key in **Settings → Integrations → AI provider** (or the matching env var) before using Capture or Chat.

### Three ways to run it locally

| You want | Run | What you get |
|---|---|---|
| The product with data in it (default) | `npm run dev`, with `DATABASE_URL` and the Clerk keys unset | Signed in as `demo-user` on local PGlite; a full demo workspace is seeded on the first request; plan limits are lifted on localhost |
| Empty states and onboarding | `ORBIT_DEMO_DATA=off npm run dev` | The same, with nothing seeded |
| The real sign-in surface | put the `pk_test_…` / `sk_test_…` Clerk keys in `.env.local`, keep `DATABASE_URL` unset, `npm run dev` | Clerk sign-in against your test instance, your account on local PGlite (seeded on first request unless `ORBIT_DEMO_DATA=off`) |

Things that catch people out:

- **A git worktree has no `node_modules`.** Run `npm ci` inside it; symlinking the main checkout's breaks as soon as the branch's dependencies differ.
- **`.data/pglite` outlives branches.** It may hold fixtures from another branch or an old smoke run. **Settings → Data and privacy → Delete data** clears it, and on localhost the demo workspace re-seeds on the next request.
- **One writer per `.data/pglite`.** Stop the dev server before running any script that writes to the local database; two writers corrupt it.
- **The port is part of Google OAuth.** Changing it breaks Gmail and Google Contacts until `GOOGLE_REDIRECT_URI` and the redirect URI in the Google Cloud console use the new port.
- **Demo sign-in links** (`scripts/demo-signin-link.ts`) need the Clerk user to exist in that instance first: `CLERK_SECRET_KEY=sk_test_… npx tsx scripts/provision-demo-account.ts`.

Optional demo contact:

```bash
npm run db:seed
```

Restart `npm run dev` afterward if the server was already running, so it reloads the shared PGlite database.

### Database

| Command | Purpose |
|---|---|
| `npm run db:setup` | Bootstrap the schema and verify read/write (local PGlite, or `DATABASE_URL` when set) |
| `npm run db:migrate` | Apply the schema to whatever `DATABASE_URL` points at (the Vercel build runs this before `next build`) |
| `npm run db:check` | Check that the bootstrap DDL in `src/db/index.ts` covers `src/db/schema.ts` |
| `npm run db:generate` | Generate SQL migrations under `drizzle/` |
| `npm run db:seed` | Insert a sample contact for `demo-user` |

Schema changes go through the DDL in `src/db/index.ts` and a `SCHEMA_VERSION` bump. Do not run `npm run db:push:DANGEROUS` against a real database: Drizzle push drops the runtime-managed `embedding_vector` column.

Leave `DATABASE_URL` unset to use on-disk PGlite (`.data/pglite`). Set it to a Neon/Postgres URL for remote data.
````

Then change the line after `### Env vars` (currently the table header follows directly) by inserting above the table: `` `.env.example` is the complete, commented list; `npm run check:env` reports what a production build would refuse. The ones most local work touches: ``

- [ ] **Step 5: Run the tests; expect pass** — `npx tsx scripts/smoke-demo-signin-message.ts`: all `ok`. Then check the missing-key path still works: `CLERK_SECRET_KEY= npx tsx scripts/demo-signin-link.ts` — expected: `Missing CLERK_SECRET_KEY.` and exit 1. (The missing-user branch needs a real `sk_test_` key for an instance without the user; that is manual step M-P4-2.)

- [ ] **Step 6: Typecheck, lint** — `npm run typecheck && npm run lint`: 0 errors. Proofread the README render: `grep -n "db:push" README.md` prints only the `db:push:DANGEROUS` warning line.

- [ ] **Step 7: Commit**

```bash
git add README.md scripts/lib/demo-account-messages.ts scripts/demo-signin-link.ts scripts/smoke-demo-signin-message.ts scripts/run-smoke.ts
git commit -m "$(cat <<'EOF'
Fix the README setup path and the demo sign-in next step

Quick start uses npm ci and no longer names the removed db:push; documents the
three local configurations and the worktree, PGlite and OAuth-port traps. The
demo sign-in script prints the exact provisioning command.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: The localhost plan card says why limits are lifted (C6)

**Verified:** on localhost every account is a demo account (`isDemoAccount`, `src/lib/demo-account.ts:45-49`), so `getEntitlements` lifts the contact limit (`src/lib/entitlements.ts:176`) and `PlanSettings` prints "Unlimited contacts — N in your orbit." (`src/components/settings/plan-settings.tsx:180-183`) beside the Free plan's "Up to 500 contacts" feature. The card gets the reason from `getPlanOverview` (`src/actions/settings.ts:473-481`). The Stripe business name is a manual step (M-P4-1).

**Files:** Modify `src/lib/demo-account.ts:45-49`; `src/lib/plan-copy.ts:1-7` (import) and append; `src/actions/settings.ts:473-481` and its imports; `src/components/settings/plan-settings.tsx:1-7`, `:82-88`, `:180-183`; `src/app/(clerk)/(app)/settings/page.tsx:143-146`. Create `scripts/smoke-plan-card-copy.ts`; Modify `scripts/run-smoke.ts` (pure).

**Interfaces:** Produces `DemoAccountReason = "localhost" | "showcase"`, `demoAccountReason(userId: string | null | undefined): DemoAccountReason | null` (demo-account.ts); `unlimitedContactsLine(used: number, demo: DemoAccountReason | null): string` (plan-copy.ts); `getPlanOverview()` gains `demoAccount: DemoAccountReason | null`; `PlanSettings` gains prop `demoAccount`.

- [ ] **Step 1: Write the failing test** — `scripts/smoke-plan-card-copy.ts`:

```ts
/**
 * The plan card never says "Unlimited contacts" beside "Up to 500 contacts" without saying
 * why: a demo account names the exemption. Pure (env toggles only).
 * Run: npx tsx scripts/smoke-plan-card-copy.ts
 */
import { demoAccountReason, isDemoAccount } from "../src/lib/demo-account";
import { unlimitedContactsLine } from "../src/lib/plan-copy";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const env = process.env as Record<string, string | undefined>;
const prior = { node: env.NODE_ENV, showcase: env.DEMO_ACCOUNT_USER_ID };
try {
  env.NODE_ENV = "development";
  delete env.DEMO_ACCOUNT_USER_ID;
  check("any account on localhost is a localhost demo", demoAccountReason("user_real") === "localhost");
  check("no user, no reason", demoAccountReason(null) === null);
  env.NODE_ENV = "production";
  env.DEMO_ACCOUNT_USER_ID = "user_showcase";
  check("the showcase account off localhost", demoAccountReason("user_showcase") === "showcase");
  check("anyone else off localhost is not a demo", demoAccountReason("user_real") === null);
  for (const id of ["user_showcase", "user_real", null]) {
    check(`isDemoAccount agrees for ${id}`, isDemoAccount(id) === (demoAccountReason(id) !== null));
  }
} finally {
  if (prior.node === undefined) delete env.NODE_ENV; else env.NODE_ENV = prior.node;
  if (prior.showcase === undefined) delete env.DEMO_ACCOUNT_USER_ID; else env.DEMO_ACCOUNT_USER_ID = prior.showcase;
}

check("localhost wording", unlimitedContactsLine(12, "localhost") === "Demo account — plan limits lifted on localhost. 12 in your orbit.", unlimitedContactsLine(12, "localhost"));
check("showcase wording", unlimitedContactsLine(3, "showcase") === "Showcase account — plan limits lifted. 3 in your orbit.");
check("a real unlimited plan keeps its line", unlimitedContactsLine(40, null) === "Unlimited contacts — 40 in your orbit.");

if (failures) {
  console.error(`\nsmoke-plan-card-copy: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nsmoke-plan-card-copy: ok");
process.exit(0);
```

- [ ] **Step 2: Register and run; expect failure** — add `"smoke-plan-card-copy": "pure",`. Run it; expected: exits 1, `does not provide an export named 'demoAccountReason'`.

- [ ] **Step 3: Implement** — in `src/lib/demo-account.ts` replace `isDemoAccount` (lines 45-49) with:

```ts
export type DemoAccountReason = "localhost" | "showcase";

/** Why this account is a demo account, or null when it is not one. `isDemoAccount` is this, as a boolean. */
export function demoAccountReason(userId: string | null | undefined): DemoAccountReason | null {
  if (!userId) return null;
  if (isLocalhost()) return "localhost";
  return userId === getShowcaseAccountId() ? "showcase" : null;
}

export function isDemoAccount(userId: string | null | undefined): boolean {
  return demoAccountReason(userId) !== null;
}
```

(Keep the doc comment above it.) In `src/lib/plan-copy.ts`, after the import block ending line 7, add `import type { DemoAccountReason } from "@/lib/demo-account";` and append:

```ts
/**
 * The plan card's line when contacts are uncapped. A demo account's limits are lifted by
 * `getEntitlements`, not bought, so it says so — otherwise a free plan on localhost read
 * "Unlimited contacts" right beside its own "Up to 500 contacts".
 */
export function unlimitedContactsLine(used: number, demo: DemoAccountReason | null): string {
  if (demo === "localhost") return `Demo account — plan limits lifted on localhost. ${used} in your orbit.`;
  if (demo === "showcase") return `Showcase account — plan limits lifted. ${used} in your orbit.`;
  return `Unlimited contacts — ${used} in your orbit.`;
}
```

In `src/actions/settings.ts` add `import { demoAccountReason } from "@/lib/demo-account";` beside the other `@/lib` imports and replace `getPlanOverview` (lines 473-481) with:

```ts
export async function getPlanOverview() {
  const userId = await requireUserId();
  const [entitlements, usage] = await Promise.all([
    getEntitlements(userId),
    contactUsageForUser(userId),
  ]);

  return { entitlements, usage, demoAccount: demoAccountReason(userId) };
}
```

In `src/components/settings/plan-settings.tsx`: line 5 becomes `import { planCopy, unlimitedContactsLine } from "@/lib/plan-copy";`; add `import type { DemoAccountReason } from "@/lib/demo-account";` after line 7; the props (lines 82-88) become:

```tsx
export function PlanSettings({
  entitlements,
  usage,
  demoAccount,
}: {
  entitlements: Entitlements;
  usage: { used: number; limit: number | null; remaining: number | null };
  /** Set when plan limits are lifted because this is a demo account, not because of the plan. */
  demoAccount: DemoAccountReason | null;
}) {
```

and line 182 (`Unlimited contacts — {usage.used} in your orbit.`) becomes `{unlimitedContactsLine(usage.used, demoAccount)}`.

In `src/app/(clerk)/(app)/settings/page.tsx` lines 143-146 become:

```tsx
          <PlanSettings
            entitlements={planOverview.entitlements}
            usage={planOverview.usage}
            demoAccount={planOverview.demoAccount}
          />
```

- [ ] **Step 4: Run the tests; expect pass** — `npx tsx scripts/smoke-plan-card-copy.ts` and `npx tsx scripts/smoke-entitlements.ts`: all `ok`.

- [ ] **Step 5: Typecheck, lint, copy guard** — `npm run typecheck && npm run lint && npx tsx scripts/smoke-toast-copy.ts`: 0 errors, ok.

- [ ] **Step 6: Browser check** — start `orbit-web`, open `/settings`. Expected on the Pricing Plan card: `Demo account — plan limits lifted on localhost. N in your orbit.`; no "Unlimited contacts".

- [ ] **Step 7: Commit**

```bash
git add src/lib/demo-account.ts src/lib/plan-copy.ts src/actions/settings.ts src/components/settings/plan-settings.tsx "src/app/(clerk)/(app)/settings/page.tsx" scripts/smoke-plan-card-copy.ts scripts/run-smoke.ts
git commit -m "$(cat <<'EOF'
Say "demo account" on the plan card when limits are lifted locally

The localhost plan card said "Unlimited contacts" beside "Up to 500 contacts".
It now names the demo exemption, localhost or showcase.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: The recruiter sharing panel says exactly what is shared (C7)

**Verified:** `src/components/recruiters/sharing-toggle.tsx:89-104` says work email and LinkedIn are "Shared when on" and that "anything Orbit read from your inbox" is never shared. On `origin/main` 33a213c the code unlocks email, phone and LinkedIn to anyone holding a link (`const unlocked = Boolean(link) || pooledForViewer;`, `src/lib/recruiters.ts:84`), and a Gmail scan writes the sender's address onto the shared row (audit A8). Phase 0 changes the rule to: contact details are shown only to a viewer who shares and only on pooled rows (or from the viewer's own link), and a non-sharing caller's contact details never reach the shared row. The copy must match that rule, including that an address found in the user's inbox is shared while they share.

**Files:** Modify `src/components/recruiters/sharing-toggle.tsx:89-104` (and the file comment at `:19-21`).

**Interfaces:** none.

- [ ] **Step 1: Precondition — Phase 0's A8 fix is in the code.** Run `grep -n "const unlocked" src/lib/recruiters.ts`. Expected: the line no longer reads `Boolean(link) || pooledForViewer` (Phase 0 narrows it). Then run `npx tsx scripts/smoke-recruiter-sharing.ts`; expected all `ok`, including Phase 0's case that a non-sharing caller's email/phone/LinkedIn is not merged onto the shared row. If either check fails, STOP: skip this task, and report "C7 blocked on Phase 0 A8" — shipping this copy over the old code would state something false.

- [ ] **Step 2: Replace the disclosure** — lines 89-104 become:

```tsx
      <dl className="grid gap-3 border-t border-border/60 pt-4 text-sm sm:grid-cols-2">
        <div>
          <dt className="font-medium text-foreground">Shared while you share</dt>
          <dd className="mt-1 text-muted-foreground">
            Each recruiter’s name, firm and specialty, and your star rating as
            part of the community average. Their work email, phone and LinkedIn
            are shown only to other people who share their lists too — including
            an address Orbit found in your inbox.
          </dd>
        </div>
        <div>
          <dt className="font-medium text-foreground">Never shared</dt>
          <dd className="mt-1 text-muted-foreground">
            Your notes, your AI interaction summaries and your status. While your
            list is private, nothing you log reaches the pool, contact details
            included.
          </dd>
        </div>
      </dl>
```

and the file comment's last sentence (line 21, `Keep it in sync with \`toPublicRecruiter\`.`) becomes `Keep it in sync with \`toPublicRecruiter\` and with which callers may add contact details to a shared row (\`logRecruiter\`, the Gmail scan).`

- [ ] **Step 3: Tests** — `npx tsx scripts/smoke-recruiter-sharing.ts` (all `ok`) and `npx tsx scripts/smoke-toast-copy.ts` (ok; no toast text changed).

- [ ] **Step 4: Typecheck, lint** — `npm run typecheck && npm run lint`: 0 errors.

- [ ] **Step 5: Browser check** — start `orbit-web`, open `/recruiters` (plan gates are lifted on localhost). Expected: the panel shows "Shared while you share" and "Never shared" with the text above, in both the private and shared states (toggle once with **Share my list**, then **Make private**).

- [ ] **Step 6: Commit**

```bash
git add src/components/recruiters/sharing-toggle.tsx
git commit -m "$(cat <<'EOF'
Make the recruiter sharing panel match what is shared

Contact details go only to other sharing members, including an address found in
the user's inbox; nothing leaves a private list. Matches Phase 0's A8 rule.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: No plaintext IPs or model output in logs (low-severity leftovers)

**Verified:** `src/lib/interest-list-join.ts:108` logs `{ ip: ctx.ip }` on a rate-limited join; `src/lib/extension/parse-profile.ts:115` logs `content.slice(0, 300)` of a model's answer about a LinkedIn profile (personal data) when it fails to parse. Fix: a daily-rotating keyed tag instead of the IP (same IP correlates within a day, reverses to nothing without the key), and the length only for model output. The key is `ENCRYPTION_SECRET`, which `src/lib/env.ts:22` requires in production.

**Files:** Create `src/lib/log-redaction.ts`; Modify `src/lib/interest-list-join.ts:14-28` (import), `:108`; `src/lib/extension/parse-profile.ts:115`; Create `scripts/smoke-log-hygiene.ts`; Modify `scripts/run-smoke.ts` (pure).

**Interfaces:** Produces `ipLogTag(ip: string | null | undefined, now?: Date): string`.

- [ ] **Step 1: Write the failing test** — `scripts/smoke-log-hygiene.ts`:

```ts
/**
 * Logs carry a keyed, day-scoped tag instead of an IP, and a length instead of model
 * output. Pure. Run: npx tsx scripts/smoke-log-hygiene.ts
 */
import { readFileSync } from "node:fs";
import { ipLogTag } from "../src/lib/log-redaction";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const day1 = new Date("2026-09-15T10:00:00Z");
const day2 = new Date("2026-09-16T10:00:00Z");
const tag = ipLogTag("203.0.113.7", day1);
check("a 12-hex-character tag", /^[0-9a-f]{12}$/.test(tag), tag);
check("the IP is not in it", !tag.includes("203"));
check("stable within a day", ipLogTag("203.0.113.7", new Date("2026-09-15T23:00:00Z")) === tag);
check("rotates across days", ipLogTag("203.0.113.7", day2) !== tag);
check("different IPs differ", ipLogTag("203.0.113.8", day1) !== tag);
check("no IP reads none", ipLogTag(null) === "none");

const join = readFileSync("src/lib/interest-list-join.ts", "utf8");
check("interest-list join no longer logs the raw IP", !/ip:\s*ctx\.ip/.test(join) && join.includes("ipLogTag(ctx.ip)"));
const profile = readFileSync("src/lib/extension/parse-profile.ts", "utf8");
check("parse-profile no longer logs model output", !/console\.\w+\([^)]*content\.slice\(/.test(profile));

if (failures) {
  console.error(`\nsmoke-log-hygiene: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nsmoke-log-hygiene: ok");
process.exit(0);
```

- [ ] **Step 2: Register and run; expect failure** — add `"smoke-log-hygiene": "pure",`. Run it; expected: exits 1, `Cannot find module '../src/lib/log-redaction'`.

- [ ] **Step 3: Implement** — `src/lib/log-redaction.ts`:

```ts
import { createHmac } from "node:crypto";

/**
 * What a log line carries instead of a client IP: an HMAC of the IP and the UTC day, keyed
 * with ENCRYPTION_SECRET, cut to 12 hex characters. The same IP reads the same all day, so
 * "one address hammering the form" is still visible; without the key, and after midnight,
 * the tag reverses to nothing. The dev fallback key only ever applies without the secret,
 * which production refuses to start without (src/lib/env.ts).
 */
export function ipLogTag(ip: string | null | undefined, now: Date = new Date()): string {
  if (!ip) return "none";
  const key = process.env.ENCRYPTION_SECRET || "orbit-dev-log-tag";
  return createHmac("sha256", key)
    .update(`ip-log:${now.toISOString().slice(0, 10)}:${ip}`)
    .digest("hex")
    .slice(0, 12);
}
```

In `src/lib/interest-list-join.ts` add `import { ipLogTag } from "@/lib/log-redaction";` after line 17 (`import { getAppBaseUrl } …`) and replace line 108 with:

```ts
    if (isRateLimitedError(err)) console.warn("[interest-list] join rate-limited", { ipTag: ipLogTag(ctx.ip) });
```

In `src/lib/extension/parse-profile.ts` replace line 115 with:

```ts
    console.warn("[parse-profile] unparseable response", { chars: content.length });
```

- [ ] **Step 4: Tests** — `npx tsx scripts/smoke-log-hygiene.ts` and `npx tsx scripts/smoke-interest-list-join.ts`: all `ok`.

- [ ] **Step 5: Typecheck, lint** — `npm run typecheck && npm run lint`: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/log-redaction.ts src/lib/interest-list-join.ts src/lib/extension/parse-profile.ts scripts/smoke-log-hygiene.ts scripts/run-smoke.ts
git commit -m "$(cat <<'EOF'
Stop logging plaintext IPs and profile model output

Rate-limited waitlist joins log a keyed, day-scoped tag instead of the IP; an
unparseable profile answer logs its length, not 300 characters of it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: A save never merges into a contact the person declined on the card (leftover: save-time auto-merge)

**Read and decided.** `buildSaveInput` (`src/lib/capture-job-runner.ts:225-235`) re-runs duplicate detection for every card saved as "New" and merges into the top candidate at `DUPLICATE_MERGE_CONFIDENCE`. A card's merge target defaults to any duplicate it showed (`defaultMergeId`, `src/lib/capture/review-reducer.ts:94-102`), so `mergeContactId: null` on a card that *showed* duplicates means the person chose New — and the save overrode them. The re-check still matters for contacts that appeared *after* the parse (a parallel capture, a retried save that created the person), which the card never showed. Decision: keep the save-time merge, but never into a contact the card showed and the person declined. Merging only into the card's `suggestedMergeId` (the literal reading of the audit note) was rejected: that is exactly the contact a "New" choice declined.

**Files:** Modify `src/lib/capture/review-reducer.ts` (append); `src/lib/capture-job-runner.ts:27` (import), `:225-235`. Create `scripts/smoke-capture-merge-target.ts`; Modify `scripts/run-smoke.ts` (pure).

**Interfaces:** Consumes Task 3's edits to the same block (apply this after Task 3). Produces `saveTimeMergeTarget(item: Pick<BulkNotePersonPreview, "duplicates">, decision: Pick<CaptureDecision, "mergeContactId">, top: { id: string; confidence: number } | null, threshold: number): string | null`.

- [ ] **Step 1: Write the failing test** — `scripts/smoke-capture-merge-target.ts`:

```ts
/**
 * The save-time duplicate re-check merges a "New" card only into a contact that appeared
 * after the parse — never into one the card showed and the person declined. Pure.
 * Run: npx tsx scripts/smoke-capture-merge-target.ts
 */
import { saveTimeMergeTarget } from "../src/lib/capture/review-reducer";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const shown = { duplicates: [{ id: "c-shown", fullName: "Priya Raman", company: "Loom", title: null, reason: "Same name", confidence: 0.9 }] };
const none = { duplicates: [] };
const T = 0.85;

check("an explicit merge choice wins", saveTimeMergeTarget(shown, { mergeContactId: "c-chosen" }, { id: "c-other", confidence: 0.99 }, T) === "c-chosen");
check("no candidate, no merge", saveTimeMergeTarget(none, { mergeContactId: null }, null, T) === null);
check("a weak candidate, no merge", saveTimeMergeTarget(none, { mergeContactId: null }, { id: "c-new", confidence: 0.6 }, T) === null);
check("a declined candidate is never merged into", saveTimeMergeTarget(shown, { mergeContactId: null }, { id: "c-shown", confidence: 0.99 }, T) === null);
check("a contact that appeared after the parse is", saveTimeMergeTarget(shown, { mergeContactId: null }, { id: "c-new", confidence: 0.95 }, T) === "c-new");

if (failures) {
  console.error(`\nsmoke-capture-merge-target: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nsmoke-capture-merge-target: ok");
process.exit(0);
```

- [ ] **Step 2: Register and run; expect failure** — add `"smoke-capture-merge-target": "pure",`. Run it; expected: exits 1, `does not provide an export named 'saveTimeMergeTarget'`.

- [ ] **Step 3: Implement** — append to `src/lib/capture/review-reducer.ts`:

```ts
/**
 * Where a card saved as "New" goes after the save re-runs duplicate detection. A card
 * defaults to merging into any duplicate it showed (`defaultMergeId`), so "New" on a card
 * that showed candidates is a choice, and the save must not reverse it. A confident match
 * the card never showed — a contact created since the parse, say by a retried save — is
 * still merged, which is what keeps a retry from creating the person twice.
 */
export function saveTimeMergeTarget(
  item: Pick<BulkNotePersonPreview, "duplicates">,
  decision: Pick<CaptureDecision, "mergeContactId">,
  top: { id: string; confidence: number } | null,
  threshold: number
): string | null {
  if (decision.mergeContactId) return decision.mergeContactId;
  if (!top || top.confidence < threshold) return null;
  if (item.duplicates.some((d) => d.id === top.id)) return null;
  return top.id;
}
```

In `src/lib/capture-job-runner.ts`, add `saveTimeMergeTarget` to the review-reducer import (line 27) and replace lines 225-235:

```ts
    let mergeContactId = decision.mergeContactId;
    if (!mergeContactId && index) {
      const top = findDuplicateCandidatesIndexed(index, {
        fullName: parsed.name,
        email: parsed.email,
        linkedinUrl: parsed.linkedin_url,
        company: parsed.company,
        title: parsed.role,
      })[0];
      if (top && top.confidence >= DUPLICATE_MERGE_CONFIDENCE) mergeContactId = top.contact.id;
    }
```

with:

```ts
    let mergeContactId = decision.mergeContactId;
    if (!mergeContactId && index) {
      const top = findDuplicateCandidatesIndexed(index, {
        fullName: parsed.name,
        email: parsed.email,
        linkedinUrl: parsed.linkedin_url,
        company: parsed.company,
        title: parsed.role,
      })[0];
      mergeContactId = saveTimeMergeTarget(
        item,
        decision,
        top ? { id: top.contact.id, confidence: top.confidence } : null,
        DUPLICATE_MERGE_CONFIDENCE
      );
    }
```

- [ ] **Step 4: Tests** — `npx tsx scripts/smoke-capture-merge-target.ts`, `npx tsx scripts/smoke-capture-jobs.ts` (its idempotent-save case still merges the person the first attempt created), `npx tsx scripts/smoke-capture-reminder-count.ts`: all `ok`.

- [ ] **Step 5: Typecheck, lint** — `npm run typecheck && npm run lint`: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/capture/review-reducer.ts src/lib/capture-job-runner.ts scripts/smoke-capture-merge-target.ts scripts/run-smoke.ts
git commit -m "$(cat <<'EOF'
Honour a declined duplicate when a capture saves

The save-time duplicate re-check merged "New" cards into the very contact the
card had shown and the person had declined. It now merges only into a match that
appeared after the parse.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 14: The daily cron sweeps abandoned meeting transcripts and expired scan grants (leftover)

**Verified:** `sweepAbandonedSessions` (`src/lib/meeting-sessions.ts:293-312`) is private and per-user, called only from `createMeetingSessionRow` (`:103`) — someone who records once and never again keeps the transcript forever, despite `ABANDONED_SESSION_TTL_DAYS = 30` (`:38`). `sweepExpiredHandoffs` (`src/lib/scan-handoff.ts:101-104`) runs only when someone mints a grant (`:115`). No scheduled job calls either (`grep -rn "sweepAbandoned\|sweepExpiredHandoffs" src .github`). The only scheduled job is `src/app/api/imports/process-stalled/route.ts`, whose housekeeping block already prunes capture photos (`:172`).

**Files:** Modify `src/lib/meeting-sessions.ts:293-312`; `src/lib/scan-handoff.ts:101-104`; `src/app/api/imports/process-stalled/route.ts:8` (imports), `:127` (stats), `:172` (calls). Create `scripts/smoke-housekeeping-sweeps.ts`; Modify `scripts/run-smoke.ts` (pglite).

**Interfaces:** Produces `sweepAbandonedMeetingSessions(now?: Date, limit?: number): Promise<number>`; `sweepExpiredHandoffs(now?: Date): Promise<number>` (was `Promise<void>`; both existing callers ignore the value).

- [ ] **Step 1: Write the failing test** — `scripts/smoke-housekeeping-sweeps.ts`:

```ts
/**
 * The global sweeps the daily cron runs: abandoned meeting sessions (and their transcript
 * segments) past the TTL, and expired phone-scan grants. Run: npx tsx scripts/smoke-housekeeping-sweeps.ts
 */
import "./smoke/_env";

import { readFileSync } from "node:fs";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { captureHandoffs, meetingSessions, meetingTranscriptSegments } from "../src/db/schema";
import { ABANDONED_SESSION_TTL_DAYS, sweepAbandonedMeetingSessions } from "../src/lib/meeting-sessions";
import { sweepExpiredHandoffs } from "../src/lib/scan-handoff";
import { run } from "./smoke/_env";

const USERS = ["smoke-sweeps-a", "smoke-sweeps-b"];

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

run(async () => {
  const db = await getDb();
  await db.delete(meetingSessions).where(inArray(meetingSessions.userId, USERS));
  await db.delete(captureHandoffs).where(inArray(captureHandoffs.userId, USERS));
  const old = new Date(Date.now() - (ABANDONED_SESSION_TTL_DAYS + 1) * 86_400_000);

  const [abandoned] = await db.insert(meetingSessions).values({ userId: USERS[0], status: "ended", updatedAt: old }).returning();
  const [discarded] = await db.insert(meetingSessions).values({ userId: USERS[1], status: "discarded" }).returning();
  const [fresh] = await db.insert(meetingSessions).values({ userId: USERS[0], status: "recording" }).returning();
  const [savedOld] = await db.insert(meetingSessions).values({ userId: USERS[1], status: "saved", updatedAt: old }).returning();
  await db.insert(meetingTranscriptSegments).values({ sessionId: abandoned.id, userId: USERS[0], seq: 0, startMs: 0, endMs: 1000, text: "hello", engine: "whisper" });

  console.log("Meeting sessions…");
  const swept = await sweepAbandonedMeetingSessions();
  const left = (await db.select({ id: meetingSessions.id }).from(meetingSessions).where(inArray(meetingSessions.userId, USERS))).map((r) => r.id);
  check("an abandoned session past the TTL is swept, across users", !left.includes(abandoned.id) && !left.includes(discarded.id), JSON.stringify(left));
  check("a live recording and a saved session are kept", left.includes(fresh.id) && left.includes(savedOld.id));
  check("the sweep reports what it removed", swept >= 2, String(swept));
  const segs = await db.select().from(meetingTranscriptSegments).where(eq(meetingTranscriptSegments.sessionId, abandoned.id));
  check("its transcript went with it", segs.length === 0);

  console.log("\nScan handoffs…");
  await db.insert(captureHandoffs).values([
    { userId: USERS[0], tokenHash: "smoke-sweeps-expired", expiresAt: new Date(Date.now() - 60_000) },
    { userId: USERS[0], tokenHash: "smoke-sweeps-live", expiresAt: new Date(Date.now() + 600_000) },
  ]);
  const removed = await sweepExpiredHandoffs();
  const handoffs = await db.select({ tokenHash: captureHandoffs.tokenHash }).from(captureHandoffs).where(inArray(captureHandoffs.userId, USERS));
  check("the expired grant is gone, the live one kept", JSON.stringify(handoffs.map((h) => h.tokenHash)) === JSON.stringify(["smoke-sweeps-live"]), JSON.stringify(handoffs));
  check("the sweep reports a count", removed >= 1, String(removed));

  const route = readFileSync("src/app/api/imports/process-stalled/route.ts", "utf8");
  check("the daily cron calls both sweeps", route.includes("sweepAbandonedMeetingSessions()") && route.includes("sweepExpiredHandoffs()"));
});
```

- [ ] **Step 2: Register and run; expect failure** — add `"smoke-housekeeping-sweeps": "pglite",`. Run it; expected: exits 1, `does not provide an export named 'sweepAbandonedMeetingSessions'`.

- [ ] **Step 3: Implement** — in `src/lib/meeting-sessions.ts` replace `sweepAbandonedSessions` (lines 293-312) with:

```ts
/** Sessions deleted per global sweep, so a backlog cannot eat the cron's budget. */
const GLOBAL_SWEEP_BATCH = 500;

function abandonedSessionPredicate(now: Date) {
  const cutoff = new Date(now.getTime() - ABANDONED_SESSION_TTL_DAYS * 86_400_000);
  return or(
    eq(meetingSessions.status, "discarded"),
    and(inArray(meetingSessions.status, UNFINISHED), lt(meetingSessions.updatedAt, cutoff)),
  );
}

async function deleteSessions(ids: string[]) {
  const db = await getDb();
  await db.delete(meetingTranscriptSegments).where(inArray(meetingTranscriptSegments.sessionId, ids));
  await db.delete(meetingSessions).where(inArray(meetingSessions.id, ids));
}

async function sweepAbandonedSessions(userId: string, now: Date) {
  const db = await getDb();
  const stale = await db
    .select({ id: meetingSessions.id })
    .from(meetingSessions)
    .where(and(eq(meetingSessions.userId, userId), abandonedSessionPredicate(now)));
  if (!stale.length) return;
  await deleteSessions(stale.map((s) => s.id));
}

/**
 * Every user's abandoned sessions, from the daily cron. The per-user sweep above only runs
 * when that user starts another meeting, so someone who recorded once and never again kept
 * the transcript forever. Returns how many sessions it deleted.
 */
export async function sweepAbandonedMeetingSessions(now: Date = new Date(), limit = GLOBAL_SWEEP_BATCH): Promise<number> {
  const db = await getDb();
  const stale = await db
    .select({ id: meetingSessions.id })
    .from(meetingSessions)
    .where(abandonedSessionPredicate(now))
    .limit(limit);
  if (!stale.length) return 0;
  await deleteSessions(stale.map((s) => s.id));
  return stale.length;
}
```

In `src/lib/scan-handoff.ts` replace lines 101-104 with (update the doc comment's "rather than on a cron" to "and, as a backstop, by the daily cron"):

```ts
export async function sweepExpiredHandoffs(now: Date = new Date()): Promise<number> {
  const db = await getDb();
  const removed = await db.delete(captureHandoffs).where(lt(captureHandoffs.expiresAt, now)).returning();
  return removed.length;
}
```

In `src/app/api/imports/process-stalled/route.ts`: after line 8 add `import { sweepAbandonedMeetingSessions } from "@/lib/meeting-sessions";` and `import { sweepExpiredHandoffs } from "@/lib/scan-handoff";`; in `stats`, after `capturePhotosPruned: 0,` add:

```ts
    /** Meetings nobody finished, past `ABANDONED_SESSION_TTL_DAYS`. */
    meetingSessionsSwept: 0,
    /** Phone-scan grants past their expiry. */
    handoffsSwept: 0,
```

and after line 172 (`stats.capturePhotosPruned = await pruneUnattachedCapturePhotos();`) add:

```ts
      // Abandoned meeting transcripts. The per-user sweep only runs when that user records
      // again; without this, one recording never finished is kept forever.
      stats.meetingSessionsSwept = await sweepAbandonedMeetingSessions();
      // Expired scan grants. Minting sweeps too, but only when someone mints.
      stats.handoffsSwept = await sweepExpiredHandoffs();
```

- [ ] **Step 4: Tests** — `npx tsx scripts/smoke-housekeeping-sweeps.ts`, `npx tsx scripts/smoke-meeting-sessions.ts`, `npx tsx scripts/smoke-scan-handoff.ts`, `npx tsx scripts/smoke-internal-auth.ts`: all `ok`.

- [ ] **Step 5: Typecheck, lint** — `npm run typecheck && npm run lint`: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/meeting-sessions.ts src/lib/scan-handoff.ts src/app/api/imports/process-stalled/route.ts scripts/smoke-housekeeping-sweeps.ts scripts/run-smoke.ts
git commit -m "$(cat <<'EOF'
Sweep abandoned meeting transcripts and expired scan grants daily

Both sweeps ran only when the same user acted again. The daily cron now runs
global, bounded versions and records the counts in cron_runs.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 15: The calendar feed token is stored as a hash (leftover; code half)

**Verified:** `user_settings.calendar_feed_token` holds the plaintext bearer token (`src/actions/calendar-feed.ts:74-86` writes it; `src/lib/calendar-feed.ts:60-73` compares it; `src/lib/admin-user-detail.ts:47` calls it "a live plaintext bearer credential"). The settings panel rebuilds the URL from the stored value on every load (`toStatus`, `src/actions/calendar-feed.ts:23-47`), so hashing means the URL can be shown only in the response that minted it — the same "shown once" pattern API keys already use (`src/components/settings/api-settings.tsx:139-146`). Existing tokens keep working: the feed route hashes the token in the URL and Task 17 hashes stored rows in place with the same function in SQL.

**Files:** Modify `src/lib/calendar-feed.ts:1` (import), `:44-46`, `:66-67`; `src/actions/calendar-feed.ts` (whole file body below the imports); `src/components/settings/calendar-feed-settings.tsx:149-194`; `scripts/smoke-admin-actions.ts:218-222`; `src/lib/admin-user-detail.ts:47` (comment). Create `scripts/smoke-calendar-feed-token.ts`; Modify `scripts/run-smoke.ts` (pglite).

**Interfaces:** Produces `hashCalendarFeedToken(token: string): string` (sha256, hex — Task 17's SQL must equal it), `mintCalendarFeedToken(userId: string): Promise<string>`, `clearCalendarFeedToken(userId: string): Promise<void>` in `src/lib/calendar-feed.ts`. `CalendarFeedStatus.url`/`webcalUrl`/`googleAddUrl` are non-null only in the response of `enableCalendarFeed` (when it minted) and `regenerateCalendarFeedToken`.

- [ ] **Step 1: Write the failing test** — `scripts/smoke-calendar-feed-token.ts`:

```ts
/**
 * The feed token is a bearer credential: the database holds only its SHA-256, the route
 * still resolves the token, the stored hash is not itself a credential, and Node's hash
 * equals the SQL that migrates existing rows. Run: npx tsx scripts/smoke-calendar-feed-token.ts
 */
import "./smoke/_env";

import { eq, sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import { userSettings } from "../src/db/schema";
import { clearCalendarFeedToken, findUserByFeedToken, hashCalendarFeedToken, mintCalendarFeedToken } from "../src/lib/calendar-feed";
import { ensureUserSettings } from "../src/lib/user-settings";
import { run } from "./smoke/_env";

const USER = "smoke-calendar-feed-token-user";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

run(async () => {
  const db = await getDb();
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await ensureUserSettings(USER);

  const token = await mintCalendarFeedToken(USER);
  const row = await db.query.userSettings.findFirst({ where: eq(userSettings.userId, USER) });
  check("the row stores a 64-hex hash, not the token", /^[0-9a-f]{64}$/.test(row?.calendarFeedToken ?? "") && row?.calendarFeedToken !== token);
  check("it is the token's hash", row?.calendarFeedToken === hashCalendarFeedToken(token));
  check("the token resolves", (await findUserByFeedToken(token))?.userId === USER);
  check("with the .ics suffix too", (await findUserByFeedToken(`${token}.ics`))?.userId === USER);
  check("the stored hash is not a credential", (await findUserByFeedToken(row!.calendarFeedToken!)) === null);

  const res = await db.execute(sql`select encode(sha256(convert_to(${token}, 'UTF8')), 'hex') as h`);
  check("Node's hash equals the migration's SQL", rowsOf<{ h: string }>(res)[0]?.h === hashCalendarFeedToken(token));

  const second = await mintCalendarFeedToken(USER);
  check("regenerating revokes the old token", (await findUserByFeedToken(token)) === null);
  check("and the new one resolves", (await findUserByFeedToken(second))?.userId === USER);
  await clearCalendarFeedToken(USER);
  check("turning it off revokes it", (await findUserByFeedToken(second)) === null);
});
```

- [ ] **Step 2: Register and run; expect failure** — add `"smoke-calendar-feed-token": "pglite",`. Run it; expected: exits 1, `does not provide an export named 'clearCalendarFeedToken'`.

- [ ] **Step 3: Implement the lib** — in `src/lib/calendar-feed.ts` line 1 becomes `import { createHash, randomBytes } from "node:crypto";`. After `generateCalendarFeedToken` (lines 44-46) add:

```ts
/**
 * What `user_settings.calendar_feed_token` stores: the SHA-256 of the token, hex. The feed
 * URL is a bearer credential, so the column holds only its fingerprint and a copy of the
 * table opens nobody's calendar. Must equal the SQL that hashed existing rows in place:
 * encode(sha256(convert_to(token, 'UTF8')), 'hex').
 */
export function hashCalendarFeedToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Mint a token, store its hash, and return the token — the only time it exists in plaintext. */
export async function mintCalendarFeedToken(userId: string): Promise<string> {
  const token = generateCalendarFeedToken();
  const db = await getDb();
  await db
    .update(userSettings)
    .set({
      calendarFeedToken: hashCalendarFeedToken(token),
      calendarFeedTokenCreatedAt: new Date(),
      calendarFeedLastFetchedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(userSettings.userId, userId));
  return token;
}

export async function clearCalendarFeedToken(userId: string): Promise<void> {
  const db = await getDb();
  await db
    .update(userSettings)
    .set({ calendarFeedToken: null, calendarFeedTokenCreatedAt: null, calendarFeedLastFetchedAt: null, updatedAt: new Date() })
    .where(eq(userSettings.userId, userId));
}
```

In `findUserByFeedToken`, line 67 `where: eq(userSettings.calendarFeedToken, token),` becomes `where: eq(userSettings.calendarFeedToken, hashCalendarFeedToken(token)),`.

- [ ] **Step 4: Rewrite the actions** — in `src/actions/calendar-feed.ts`, the import from `@/lib/calendar-feed` (lines 8-12) becomes `import { buildCalendarFeedUrl, buildCalendarFeedWebcalUrl, clearCalendarFeedToken, mintCalendarFeedToken } from "@/lib/calendar-feed";`, and everything from `export type CalendarFeedStatus` (line 14) to the end becomes:

```ts
export type CalendarFeedStatus = {
  enabled: boolean;
  /** The feed URLs exist only in the response that minted the token; Orbit stores a hash. */
  url: string | null;
  webcalUrl: string | null;
  googleAddUrl: string | null;
  createdAt: Date | null;
  lastFetchedAt: Date | null;
};

type FeedRow = {
  calendarFeedToken: string | null;
  calendarFeedTokenCreatedAt: Date | null;
  calendarFeedLastFetchedAt: Date | null;
};

function toStatus(row: FeedRow, freshToken: string | null): CalendarFeedStatus {
  if (!row.calendarFeedToken) {
    return { enabled: false, url: null, webcalUrl: null, googleAddUrl: null, createdAt: null, lastFetchedAt: null };
  }
  const webcalUrl = freshToken ? buildCalendarFeedWebcalUrl(freshToken) : null;
  return {
    enabled: true,
    url: freshToken ? buildCalendarFeedUrl(freshToken) : null,
    webcalUrl,
    googleAddUrl: webcalUrl ? `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcalUrl)}` : null,
    createdAt: row.calendarFeedTokenCreatedAt,
    lastFetchedAt: row.calendarFeedLastFetchedAt,
  };
}

async function readSettings(userId: string): Promise<FeedRow> {
  const db = await getDb();
  await ensureUserSettings(userId);
  const row = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
    columns: { calendarFeedToken: true, calendarFeedTokenCreatedAt: true, calendarFeedLastFetchedAt: true },
  });
  return row ?? { calendarFeedToken: null, calendarFeedTokenCreatedAt: null, calendarFeedLastFetchedAt: null };
}

export async function getCalendarFeedStatus(): Promise<CalendarFeedStatus> {
  const userId = await requireUserId();
  return toStatus(await readSettings(userId), null);
}

/** Minted only on request — never in ensureUserSettings. Don't issue unasked-for creds. */
export async function enableCalendarFeed(): Promise<CalendarFeedStatus> {
  const userId = await requireUserId();
  const existing = await readSettings(userId);
  if (existing.calendarFeedToken) return toStatus(existing, null);
  const token = await mintCalendarFeedToken(userId);
  return toStatus(await readSettings(userId), token);
}

/** Revokes immediately: the previous URL starts 404ing on the next poll. */
export async function regenerateCalendarFeedToken(): Promise<CalendarFeedStatus> {
  const userId = await requireUserId();
  await ensureUserSettings(userId);
  const token = await mintCalendarFeedToken(userId);
  return toStatus(await readSettings(userId), token);
}

export async function disableCalendarFeed(): Promise<CalendarFeedStatus> {
  const userId = await requireUserId();
  await ensureUserSettings(userId);
  await clearCalendarFeedToken(userId);
  return toStatus(await readSettings(userId), null);
}
```

- [ ] **Step 5: Show the link once** — in `src/components/settings/calendar-feed-settings.tsx` replace lines 151-194 (the `<div className="space-y-2">` holding the URL input and its four buttons) with:

```tsx
          {status.url ? (
            <div className="space-y-2">
              <p className="text-sm font-medium">Copy this link now — Orbit won’t show it again.</p>
              <Input
                readOnly
                value={revealed ? status.url : maskUrl(status.url)}
                onFocus={(e) => e.currentTarget.select()}
                className="font-mono text-xs"
                aria-label="Calendar feed URL"
              />
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => setRevealed((v) => !v)}>
                  {revealed ? "Hide" : "Reveal"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    await navigator.clipboard.writeText(status.url!);
                    toast.success(TOAST_COPY.copied);
                  }}
                >
                  Copy link
                </Button>
                <a href={status.webcalUrl!} className="inline-flex h-8 items-center rounded-md border border-input px-3 text-sm hover:bg-accent">
                  Add to Apple Calendar
                </a>
                <a href={status.googleAddUrl!} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center rounded-md border border-input px-3 text-sm hover:bg-accent">
                  Add to Google Calendar
                </a>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Your calendar feed is on. Orbit keeps only a fingerprint of its link, so it can’t
              show the link again. To add it to another device, regenerate it below — the old
              link stops working.
            </p>
          )}
```

- [ ] **Step 6: Keep the admin smoke honest** — in `scripts/smoke-admin-actions.ts` line 218 becomes `const { findUserByFeedToken, hashCalendarFeedToken } = await import("../src/lib/calendar-feed");` and line 222 becomes `.set({ calendarFeedToken: hashCalendarFeedToken(feedToken) })`. In `src/lib/admin-user-detail.ts:47` change `(a live plaintext bearer credential)` to `(the SHA-256 of a bearer credential)`.

- [ ] **Step 7: Tests** — `npx tsx scripts/smoke-calendar-feed-token.ts`, `npx tsx scripts/smoke-admin-actions.ts`, `npx tsx scripts/smoke-admin-unmasked.ts`, `npx tsx scripts/smoke-purge.ts`, `npx tsx scripts/smoke-purge-selective.ts`, `npx tsx scripts/smoke-ics-feed.ts`: all `ok`.

- [ ] **Step 8: Typecheck, lint, copy guard** — `npm run typecheck && npm run lint && npx tsx scripts/smoke-toast-copy.ts`: 0 errors, ok.

- [ ] **Step 9: Browser check** — start `orbit-web`, open `/settings?integration=calendar`, press **Create calendar feed**. Expected: "Copy this link now — Orbit won’t show it again." with a masked URL; **Copy link** copies it; `curl -s -o /dev/null -w '%{http_code}\n' "http://localhost:3001/api/calendar/<token>.ics"` (the path of the copied URL; its host may be the configured app URL rather than localhost) prints `200`. Reload the page: the fingerprint paragraph shows and no URL. **Regenerate link** → a new URL; the old one now returns `404`.

- [ ] **Step 10: Commit**

```bash
git add src/lib/calendar-feed.ts src/actions/calendar-feed.ts src/components/settings/calendar-feed-settings.tsx scripts/smoke-admin-actions.ts src/lib/admin-user-detail.ts scripts/smoke-calendar-feed-token.ts scripts/run-smoke.ts
git commit -m "$(cat <<'EOF'
Store the calendar feed token as a hash and show its link once

The feed URL is a bearer credential; the column now holds its SHA-256 and the
route hashes the presented token. Settings shows the link only when it is minted.
Existing rows are hashed in place by the batched migration.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 16: AI-derived timeline events are tagged and do not count as touches (leftover; code half)

**Verified:** the LinkedIn timeline backfill inserts model-derived events (`reach_out` / `meeting` / `in_person`, external id `li-event:…`) with `source: "linkedin_messages"` (`src/lib/linkedin-timeline-backfill.ts:264-278`), describing messages that are already interaction rows. The closeness inputs count every interaction: touch counts and the constellation tallies in `src/lib/closeness-cohort.ts:236-245` and `:352-360`, the single-contact rescore in `src/lib/closeness-materialize.ts:326-337`, and the profile's "Last touch" reads the newest interaction (`src/app/(clerk)/(app)/(main)/contacts/[id]/page.tsx:181-183`). So a thread is double-counted, and a meeting a model read into a message qualifies the person as "met". No column is needed: `interactions.source` is free text (`src/db/schema.ts:679`). New rows get `source = 'ai_derived'`; Task 17 re-tags existing `li-event:%` rows.

**Files:** Create `src/lib/interaction-provenance.ts`; Modify `src/lib/linkedin-timeline-backfill.ts:66` (import), `:273`; `src/lib/closeness-cohort.ts:2-4` (imports), `:244`, `:359`; `src/lib/closeness-materialize.ts:1-3` (imports), `:332-337`; `src/actions/contacts.ts:622-628` (columns); `src/app/(clerk)/(app)/(main)/contacts/[id]/page.tsx:38` (import), `:181`; `scripts/smoke-linkedin-timeline-backfill.ts:340-344`. Create `scripts/smoke-ai-derived-interactions.ts`; Modify `scripts/run-smoke.ts` (pglite).

**Interfaces:** Produces `AI_DERIVED_SOURCE = "ai_derived"`, `countsAsTouch(): SQL`, `latestLoggedTouch<T extends { source: string | null }>(newestFirst: readonly T[]): T | null`. Task 17's migration uses the literal `'ai_derived'`.

- [ ] **Step 1: Write the failing test** — `scripts/smoke-ai-derived-interactions.ts`:

```ts
/**
 * Model-derived timeline events are not touches: they do not raise the recency count, do
 * not make someone "met in person", and are not the profile's last touch.
 * Run: npx tsx scripts/smoke-ai-derived-interactions.ts
 */
import "./smoke/_env";

process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke-ai-derived";
process.env.CLERK_SECRET_KEY ||= "sk_test_smoke-ai-derived";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, interactions, userSettings } from "../src/db/schema";
import { getClosenessCohort } from "../src/lib/closeness-cohort";
import { AI_DERIVED_SOURCE, latestLoggedTouch } from "../src/lib/interaction-provenance";
import { ensureUserSettings } from "../src/lib/user-settings";
import { run } from "./smoke/_env";

const USER = "smoke-ai-derived-user";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

run(async () => {
  const db = await getDb();
  await db.delete(interactions).where(eq(interactions.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await ensureUserSettings(USER);

  const [c] = await db.insert(contacts).values({ userId: USER, fullName: "Priya Raman" }).returning();
  const day = (n: number) => new Date(Date.now() - n * 86_400_000);
  await db.insert(interactions).values([
    { userId: USER, contactId: c.id, interactionType: "note", source: "capture", interactionDate: day(3), externalId: "smoke-ai-note" },
    { userId: USER, contactId: c.id, interactionType: "linkedin_message", source: "linkedin_messages", direction: "in", interactionDate: day(4), externalId: "smoke-ai-msg" },
    { userId: USER, contactId: c.id, interactionType: "meeting", source: AI_DERIVED_SOURCE, interactionDate: day(1), externalId: `li-event:${c.id}:meeting:a` },
    { userId: USER, contactId: c.id, interactionType: "in_person", source: AI_DERIVED_SOURCE, interactionDate: day(2), externalId: `li-event:${c.id}:in_person:b` },
  ]);

  for (const label of ["fresh cohort", "stored cohort"] as const) {
    console.log(`\n${label}…`);
    const cohort = await getClosenessCohort(USER);
    const signals = cohort.constellationSignals.get(c.id);
    check("recent touches count the note and the message only", cohort.touchCounts.get(c.id) === 2, String(cohort.touchCounts.get(c.id)));
    check("a model-read meeting does not make them met", signals?.meetingInteractions === 0, JSON.stringify(signals));
    check("the message still counts as inbound", signals?.linkedInInbound === 1 && signals?.noteInteractions === 1, JSON.stringify(signals));
    check("they have still interacted", cohort.interactedIds.has(c.id));
  }

  console.log("\nlast touch…");
  const newestFirst = [
    { id: "ai", source: AI_DERIVED_SOURCE },
    { id: "note", source: "capture" },
  ];
  check("the newest real touch, skipping derived rows", latestLoggedTouch(newestFirst)?.id === "note");
  check("null source counts as real", latestLoggedTouch([{ id: "x", source: null }])?.id === "x");
  check("only derived rows means none", latestLoggedTouch([{ id: "ai", source: AI_DERIVED_SOURCE }]) === null);
});
```

- [ ] **Step 2: Register and run; expect failure** — add `"smoke-ai-derived-interactions": "pglite",`. Run it; expected: exits 1, `Cannot find module '../src/lib/interaction-provenance'`.

- [ ] **Step 3: Create `src/lib/interaction-provenance.ts`**:

```ts
/**
 * Where an interaction came from, where it changes how it counts. DB-free (schema only).
 *
 * `ai_derived` marks rows a model inferred rather than a person logged or a provider
 * recorded — today the LinkedIn timeline events. They summarise messages that are already
 * rows of their own, so counting them double-counts the thread, and a meeting a model read
 * into a message is not evidence a meeting happened. They stay on the timeline; they are
 * excluded from recency, closeness and "last touch".
 */
import { isNull, ne, or, type SQL } from "drizzle-orm";
import { interactions } from "@/db/schema";

export const AI_DERIVED_SOURCE = "ai_derived";

/** WHERE fragment: the row is a real touch (anything but an AI-derived event). */
export function countsAsTouch(): SQL {
  return or(isNull(interactions.source), ne(interactions.source, AI_DERIVED_SOURCE))!;
}

/** The newest real touch from rows ordered newest first, or null. */
export function latestLoggedTouch<T extends { source: string | null }>(newestFirst: readonly T[]): T | null {
  return newestFirst.find((row) => row.source !== AI_DERIVED_SOURCE) ?? null;
}
```

- [ ] **Step 4: Tag new rows and exclude them from the inputs**
  - `src/lib/linkedin-timeline-backfill.ts`: after line 66 add `import { AI_DERIVED_SOURCE } from "@/lib/interaction-provenance";`; line 273 `source: "linkedin_messages",` becomes `source: AI_DERIVED_SOURCE,`.
  - `src/lib/closeness-cohort.ts`: add `import { countsAsTouch } from "@/lib/interaction-provenance";` after line 4; lines 244 and 359 `.where(eq(interactions.userId, userId))` both become `.where(and(eq(interactions.userId, userId), countsAsTouch()))` (`and` is already imported, line 2).
  - `src/lib/closeness-materialize.ts`: add `import { countsAsTouch } from "@/lib/interaction-provenance";` after line 3; lines 332-337 become:

```ts
      .where(
        and(
          eq(interactions.userId, userId),
          eq(interactions.contactId, contactId),
          countsAsTouch()
        )
      ),
```

  - `src/actions/contacts.ts`: in `getContact`'s `interactions.columns` (lines 622-628) add `source: true,` after `aiSummary: true,`.
  - `src/app/(clerk)/(app)/(main)/contacts/[id]/page.tsx`: add `import { latestLoggedTouch } from "@/lib/interaction-provenance";` after line 38; line 181 becomes `const latestInteraction = latestLoggedTouch(contact.interactions);`.
  - `scripts/smoke-linkedin-timeline-backfill.ts` lines 340-344 become:

```ts
  check(
    "derived events are tagged as AI-derived, not as the engine's messages",
    rows.every((r) => r.source === "ai_derived"),
    JSON.stringify(rows.map((r) => r.source))
  );
```

- [ ] **Step 5: Tests** — `npx tsx scripts/smoke-ai-derived-interactions.ts`, `npx tsx scripts/smoke-linkedin-timeline-backfill.ts`, `npx tsx scripts/smoke-constellation-signals.ts`, `npx tsx scripts/smoke-closeness.ts`, `npx tsx scripts/smoke-contact-profile.ts`: all `ok`.

- [ ] **Step 6: Typecheck, lint** — `npm run typecheck && npm run lint`: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/interaction-provenance.ts src/lib/linkedin-timeline-backfill.ts src/lib/closeness-cohort.ts src/lib/closeness-materialize.ts src/actions/contacts.ts "src/app/(clerk)/(app)/(main)/contacts/[id]/page.tsx" scripts/smoke-linkedin-timeline-backfill.ts scripts/smoke-ai-derived-interactions.ts scripts/run-smoke.ts
git commit -m "$(cat <<'EOF'
Tag AI-derived timeline events and keep them out of closeness

LinkedIn timeline events a model inferred are now source ai_derived and no longer
count toward recency, the constellation's "met" tally, or the profile's last
touch. Existing rows are re-tagged by the batched migration.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 17: The batched schema bump — hash existing feed tokens, tag existing AI-derived rows

**Why a bump with no DDL:** both changes are data migrations for rows that already exist, and `alters` only runs when `SCHEMA_VERSION` moves (`reconcileSchema`, `src/db/index.ts:2941`; the Vercel build runs it via `npm run db:migrate`). `alters` already carries a data `UPDATE` (`gmail_connections`, `src/db/index.ts:2612-2613`), so this follows precedent. Both statements are idempotent, so later bumps re-running them is harmless. No new column, table, or `EXPECTED_TABLES` entry.

**Rollback consequence (write it in the PR):** once this migration runs, a deployment from before Task 15 compares the feed URL's plaintext token against stored hashes, so every existing calendar feed 404s on that older build. Do not promote a pre-Task-15 deployment after this ships; if one is unavoidable, users regenerate their feed link in Settings.

**Files:** Modify `src/db/index.ts:1405-1406` (changelog + version), `:2662-2663` (append to `alters`); `scripts/schema-ddl.lock.json` (regenerated). Create `scripts/smoke-polish-migrations.ts`; Modify `scripts/run-smoke.ts` (pglite).

**Interfaces:** Consumes `hashCalendarFeedToken`, `findUserByFeedToken` (Task 15) and `AI_DERIVED_SOURCE` (Task 16).

- [ ] **Step 1: Write the failing test** — `scripts/smoke-polish-migrations.ts`:

```ts
/**
 * The Phase 4 data migrations, on a database one version behind: plaintext calendar feed
 * tokens become their SHA-256 (and still resolve), li-event interactions become ai_derived,
 * nothing else changes, and a second pass changes nothing.
 * Run: npx tsx scripts/smoke-polish-migrations.ts
 */
import "./smoke/_env";

import { eq, sql } from "drizzle-orm";
import { SCHEMA_VERSION, getDb, reconcileSchema } from "../src/db";
import { contacts, interactions, userSettings } from "../src/db/schema";
import { findUserByFeedToken, hashCalendarFeedToken } from "../src/lib/calendar-feed";
import { AI_DERIVED_SOURCE } from "../src/lib/interaction-provenance";
import { ensureUserSettings } from "../src/lib/user-settings";
import { run } from "./smoke/_env";

const USER = "smoke-polish-migrations-user";
const LEGACY_TOKEN = "legacyPlaintextFeedToken_0123456789abcdefXYZ"; // 43 chars, base64url-shaped

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function behindAndReconcile() {
  const db = await getDb();
  await db.execute(sql`UPDATE schema_migrations SET version = ${SCHEMA_VERSION - 1} WHERE id = 1`);
  const result = await reconcileSchema();
  check("the sweep ran with no failed statement", result.applied === true && result.failed.length === 0, JSON.stringify(result.failed));
}

run(async () => {
  const db = await getDb();
  await db.delete(interactions).where(eq(interactions.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await ensureUserSettings(USER);
  await db.update(userSettings).set({ calendarFeedToken: LEGACY_TOKEN }).where(eq(userSettings.userId, USER));
  const [c] = await db.insert(contacts).values({ userId: USER, fullName: "Priya Raman" }).returning();
  await db.insert(interactions).values([
    { userId: USER, contactId: c.id, interactionType: "meeting", source: "linkedin_messages", externalId: `li-event:${c.id}:meeting:x` },
    { userId: USER, contactId: c.id, interactionType: "linkedin_message", source: "linkedin_messages", direction: "in", externalId: "li-msg:smoke-1" },
  ]);

  console.log("First pass…");
  await behindAndReconcile();
  const settings = await db.query.userSettings.findFirst({ where: eq(userSettings.userId, USER) });
  check("the stored token is now its hash", settings?.calendarFeedToken === hashCalendarFeedToken(LEGACY_TOKEN), String(settings?.calendarFeedToken));
  check("the old feed URL still resolves", (await findUserByFeedToken(LEGACY_TOKEN))?.userId === USER);
  const rows = await db.query.interactions.findMany({ where: eq(interactions.userId, USER) });
  const bySource = Object.fromEntries(rows.map((r) => [r.externalId, r.source]));
  check("the li-event row is ai_derived", bySource[`li-event:${c.id}:meeting:x`] === AI_DERIVED_SOURCE, JSON.stringify(bySource));
  check("a real message is untouched", bySource["li-msg:smoke-1"] === "linkedin_messages");

  console.log("\nSecond pass…");
  await behindAndReconcile();
  const again = await db.query.userSettings.findFirst({ where: eq(userSettings.userId, USER) });
  check("a hash is never hashed twice", again?.calendarFeedToken === hashCalendarFeedToken(LEGACY_TOKEN));
  check("the feed still resolves", (await findUserByFeedToken(LEGACY_TOKEN))?.userId === USER);
});
```

- [ ] **Step 2: Register and run; expect failure** — add `"smoke-polish-migrations": "pglite",`. Run it; expected: exits 1 at `the stored token is now its hash failed: legacyPlaintextFeedToken_…` (no migration yet).

- [ ] **Step 3: Add the statements** — in `src/db/index.ts`, after line 2662 (`` `CREATE UNIQUE INDEX IF NOT EXISTS target_companies_user_company_uidx ON target_companies(user_id, company_id)`, ``) and before `];` (line 2663), insert:

```ts
  // Launch Phase 4: calendar feed tokens are stored as their SHA-256, hex, matching
  // hashCalendarFeedToken in src/lib/calendar-feed.ts. Idempotent: live tokens are
  // 43-character base64url, so a stored 64-hex value is already a hash and is left alone.
  `UPDATE user_settings
      SET calendar_feed_token = encode(sha256(convert_to(calendar_feed_token, 'UTF8')), 'hex')
    WHERE calendar_feed_token IS NOT NULL AND calendar_feed_token !~ '^[0-9a-f]{64}$'`,
  // Launch Phase 4: LinkedIn timeline events a model inferred are tagged ai_derived, so
  // closeness and last touch skip them (src/lib/interaction-provenance.ts). Idempotent.
  `UPDATE interactions SET source = 'ai_derived'
    WHERE external_id LIKE 'li-event:%' AND source IS DISTINCT FROM 'ai_derived'`,
```

(No backticks inside those `//` comments.)

- [ ] **Step 4: Bump the version** — compute N:

```bash
git fetch -q --all && for b in $(git for-each-ref --format='%(refname:short)' refs/remotes/origin); do git show "${b}:src/db/index.ts" 2>/dev/null | grep -oE 'export const SCHEMA_VERSION = [0-9]+'; done | grep -oE '[0-9]+$' | sort -n | tail -1
```

N is that number plus one. Replace line 1406 `export const SCHEMA_VERSION = 55;` with `export const SCHEMA_VERSION = N;` (the integer), and add above it, after line 1405:

```ts
//
// N = launch Phase 4 polish: no DDL. Two idempotent data migrations at the end of
// `alters` — calendar feed tokens hashed in place, li-event interactions tagged ai_derived.
```

(write the integer in place of N in the comment too).

- [ ] **Step 5: Regenerate the guard and bootstrap locally** — `npx tsx scripts/smoke-schema-ddl.ts --update` (expected: lock written, ok), then with `orbit-web` stopped `npm run db:setup` (expected: the printed table list is unchanged from before this task; no failures).

- [ ] **Step 6: Tests** — `npx tsx scripts/smoke-polish-migrations.ts`, `npx tsx scripts/smoke-schema-upgrade.ts`, `npx tsx scripts/smoke-schema-ddl.ts`, `npx tsx scripts/smoke-migration-guards.ts`, `npx tsx scripts/smoke-calendar-feed-token.ts`: all `ok`.

- [ ] **Step 7: Whole suite** — `npm run typecheck && npm run lint && npm test`. Expected: 0 errors; the suite summary reports every script passing. If `smoke-admin-render` or `smoke-instrumentation` time out, re-run them alone before suspecting code (machine load).

- [ ] **Step 8: Commit**

```bash
git add src/db/index.ts scripts/schema-ddl.lock.json scripts/smoke-polish-migrations.ts scripts/run-smoke.ts
git commit -m "$(cat <<'EOF'
Migrate existing feed tokens to hashes and tag AI-derived rows

One batched schema bump with no DDL: idempotent updates hash stored calendar feed
tokens in place and tag li-event interactions ai_derived.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 9: Before pushing** — `git fetch origin && git merge origin/main`; if the merge brought in DDL or another `SCHEMA_VERSION`, re-run Step 4's scan and bump again (a branch's own number is stale on any database a pre-merge build stamped), then re-run Steps 5-7. Re-check `origin/main` for a rival fix of any item here (about sixty worktrees are active).

---

## Manual steps (not code)

- **M-P4-1 Stripe business name (C6).** dashboard.stripe.com → toggle **Live mode** on → gear icon → **Settings** → **Business** → **Public details** → set **Public business name** to `Orbit` (and the statement descriptor to `ORBIT`) → **Save**. Repeat with Live mode off so the sandbox stops showing "stripe-almond-grass". Check: start a checkout from `/upgrade` on a preview; the Stripe page header reads Orbit.
- **M-P4-2 Demo account in the Clerk test instance (C5).** `CLERK_SECRET_KEY=sk_test_… npx tsx scripts/provision-demo-account.ts --email demo@orbit.com`, then `CLERK_SECRET_KEY=sk_test_… npx tsx scripts/demo-signin-link.ts --base-url http://localhost:3001`. Before provisioning, running the second command once confirms the new "No Clerk user found … Create it first" message.
- **M-P4-3 Calendar feeds after deploy (Task 15/17).** Force-refresh your own subscribed Orbit calendar (Apple Calendar: right-click the calendar → Refresh; Google Calendar refreshes on its own within hours) and confirm it still updates. Tell beta users that Settings no longer re-shows the feed link and that **Regenerate link** gives a new one. Do not promote a pre-Task-15 deployment afterwards (see Task 17).
- **M-P4-4 Screen reader (C8).** macOS: Cmd+F5 for VoiceOver, open `/settings?integration=ai` in Safari, Tab through the tab list and the Provider and Model selects; each is announced with its name. Record the result in the PR.
- **M-P4-5 A real phone (C3).** On an iPhone and an Android phone, open `/contacts` and `/reminders` and tap just outside the edge of a row's delete and snooze icons; the tap hits the button, not the row. This is also roadmap acceptance step 13.

## Self-review

Audit item → task:

| Item | Task |
|---|---|
| C1 skipped phrase not in the note | 1 (root cause: hard-coded example in `SkippedNote`, not the model) |
| C1 one follow-up became two reminders | 2 |
| C1 button count disagrees with result | 3 |
| C1 "Last touch in about 9 hours" | 4 |
| C2 contacts search ranking | 5 (ask bar, graph, chat, palette and pickers), 6 (contacts page with keyset paging) |
| C3 mobile tap targets | 7 (12 buttons in 7 files, listed there) |
| C5 setup friction: README, worktree `npm ci`, three configurations, demo-signin next step | 9 |
| C6 "Unlimited contacts" beside "Up to 500" | 10; Stripe business name is M-P4-1 |
| C7 recruiter copy aligned with Phase 0's rule | 11 (gated on Phase 0) |
| C8 accessible names + guard | 8 (four real hits fixed; dialog checked in the tree, conditional fix spelled out) |
| Calendar feed token stored hashed | 15 (code), 17 (in-place migration — the one bump) |
| `previewBulkSendQuality` | Dropped: fixed in Phase 0 (A8) |
| Interest-list IP in logs | 12 |
| `parse-profile` logs model output | 12 |
| Save-time auto-merge | 13 (decision: never merge into a declined, shown candidate) |
| AI-derived timeline interactions | 16 (code, no column: `interactions.source` is free text), 17 (re-tag existing rows) |
| Abandoned meeting transcripts, expired scan handoffs | 14 (neither was called by any scheduled job) |

Not in this plan, deliberately: C4 (chat mount time — a Speed Insights look, roadmap Phase 3b), and C6's `/api/health` behaviours (token 401, reconcile inside the probe), which belong to Phase 0's A5/health work; the assigned C6 scope was the plan card and the Stripe name. The "by Friday" phrase the audit note used is still unrecognized by the relative-date grammar; Task 1 makes that visible and truthful rather than extending the grammar.

Checks run on this plan: every task names exact files and lines verified on `origin/main` 33a213c; every new function is defined in the task that creates it and consumed by name later (`dropSupersededWindowDrafts` 2→3, `plannedCaptureReminders`/`reminderFactsFor` 3→13, `nameMatchTierSql`/`contactSearchCondition` 5→6, `hashCalendarFeedToken` 15→17, `AI_DERIVED_SOURCE` 16→17); every new smoke is registered in `MANIFEST` with its tier (pure: skipped-phrases, reminder-dedupe, last-touch, tap-targets, icon-button-names, demo-signin-message, plan-card-copy, log-hygiene, capture-merge-target; pglite: capture-reminder-count, contact-search-rank, contacts-search-paging, housekeeping-sweeps, calendar-feed-token, ai-derived-interactions, polish-migrations); the Task 8 scanner was run against the repo while planning and returns exactly the four listed hits; `SCHEMA_VERSION` is never hard-coded.
