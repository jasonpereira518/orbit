# Note Processing Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make pasted meeting notes produce participant interactions, mention links, auto-created reminders (dated, relative, and per action item) with one-click undo, and a structured contact brief with an open-next-steps checklist.

**Architecture:** Keep the two concurrent AI passes in `parseBulkCaptureNotes` (people + dates) and add a deterministic post-pass: relative dates resolve against the note's anchor date, mentions resolve through the duplicate index, and every write is idempotent through hashes and `externalId`. All save logic moves out of the `"use server"` action into `src/lib/note-batch-save.ts` so it can run in `scripts/smoke-*.ts` without Clerk. One schema bump (16 → 17) carries every new table and column.

**Tech Stack:** Next.js 16.2.10 App Router (server actions, `after()` from `next/server`), Drizzle ORM on Neon (`neon-http`) and PGlite, zod 4, `completeJson` from `src/lib/ai.ts` (BYOK Gemini/OpenAI/Anthropic), hand-rolled `scripts/smoke-*.ts` run with `npx tsx`.

**Spec:** `docs/superpowers/specs/2026-09-02-note-processing-design.md`

## Global Constraints

- **Next.js differs from training data.** Before writing any route, page, or server action, read the relevant file under `node_modules/next/dist/docs/01-app/03-api-reference/` (server actions: `01-directives/use-server.md`; `after`: `04-functions/after.md`; `revalidatePath`: `04-functions/revalidatePath.md`; dynamic route pages: `03-file-conventions/page.md`). This worktree has no `node_modules`; Task 0 symlinks main's.
- **Every `completeJson` call passes an `operation` label** (e.g. `"capture.dates"`, `"contact.brief"`).
- **Schema changes** go in `src/db/schema.ts` AND the hand-written SQL in `src/db/index.ts`: new tables in the `DDL` template; new columns on existing tables in the `DDL` table body (fresh DBs) plus the Neon `alters` list plus a PGlite `ensureColumn` call (existing DBs); statements that need those columns to already exist (partial indexes, backfills) go in `ADMIN_V2_STATEMENTS`, which both drivers run after their column pass. Bump `SCHEMA_VERSION` to 17 once, then `npx tsx scripts/smoke-schema-ddl.ts --update`. **Never run `db:push` or `db:generate`.**
- **`"use server"` files export only async functions.** Types and sync helpers live in `src/lib/`.
- **Smoke scripts** follow `scripts/smoke-linkedin-timeline-backfill.ts`: `dotenv` first, fake Clerk keys, `delete process.env.DATABASE_URL`, then import from `../src/*`. Stop this worktree's dev server before running any DB-writing smoke script (PGlite is single-writer). Each script's header carries a `Run:` line.
- **Baselines:** `npx tsc --noEmit` passes; `npx next build` passes; eslint has 48 pre-existing errors. Do not add to them.
- **`src/lib/duplicates.ts` reads as binary to grep.** Use `git show HEAD:src/lib/duplicates.ts | cat -v` to read it.
- Dates are pinned to local noon (`atLocalNoon` from `src/lib/interaction-date.ts`, `isoDayToLocalNoon` from `src/lib/suggested-reminder-utils.ts`). Never `new Date("YYYY-MM-DD")`.
- Commit after every task with a conventional message. Do not push; PRs are opened per slice by the person running the plan.

---

## File structure

| File | Responsibility |
|---|---|
| `src/lib/relative-date.ts` (new) | Pure: phrase + anchor → date/basis/rule |
| `src/lib/interaction-date.ts` | Export `WEEKDAYS` (currently private) |
| `src/lib/date-commitment-extract.ts` | Dates prompt, `fetchRawCommitments`, `validateCommitments` with anchor routing |
| `src/db/schema.ts`, `src/db/index.ts` | Schema v17: `note_batches`, `interaction_mentions`, `action_items`, `contact_briefs`, reminder provenance columns |
| `src/lib/note-batches.ts` (new) | Types + pure helpers for batches (external ids, result shape, window dates) |
| `src/lib/note-batch-save.ts` (new) | `saveNoteBatch`, `undoNoteBatchForUser`: all DB writes for a confirmed capture |
| `src/lib/contact-writes.ts` | `logNoteInteractionForUser` (idempotent by `externalId`), `syncActionItems` hook |
| `src/actions/capture.ts` | Thin: parse preview + `confirmBulkCapture` → `saveNoteBatch` |
| `src/actions/note-batches.ts` (new) | `getNoteBatch`, `undoNoteBatch`, `dismissNoteReminder` |
| `src/app/(app)/(main)/capture/[batchId]/page.tsx` (new) + `src/components/capture/note-batch-result.tsx` (new) | Results view |
| `src/lib/mention-resolution.ts` (new) | Pure: mention names → contact ids or unresolved |
| `src/lib/ai.ts` | `role` + `mentions` in the people schemas and prompts |
| `src/lib/action-items.ts` (new) | Hash, diff, sync, list, status |
| `src/actions/action-items.ts` (new) | `setActionItemStatus` |
| `src/lib/contact-brief.ts` (new, replaces `src/lib/person-summary.ts`) | Brief generation + recent discussions + staleness |
| `src/components/contacts/contact-brief-card.tsx`, `contact-next-steps.tsx`, `contact-mentions-section.tsx`, `contact-add-notes-card.tsx` (new) | Profile UI |
| `src/components/chat/bulk-notes-panel.tsx` | `lockedParticipantId`, route to results page |
| `scripts/smoke-relative-date.ts`, `smoke-note-batch.ts`, `smoke-mention-resolution.ts`, `smoke-action-items.ts`, `smoke-contact-brief.ts` (new) | Per-slice tests |

---

## Task 0: Worktree setup

**Files:** none in repo.

- [ ] **Step 1: Link node_modules and verify tooling works**

```bash
ln -s /Users/jasonpereira/Projects/orbit/node_modules node_modules
npx tsc --noEmit && echo TSC_OK
npm run db:check && echo DDL_OK
```

Expected: `TSC_OK` and `DDL_OK` (lock version 16, fingerprint unchanged).

- [ ] **Step 2: Confirm the dev server for this worktree is not running**

```bash
lsof -iTCP:3001 -sTCP:LISTEN || echo "port 3001 free"
```

Expected: `port 3001 free`. If a server is listening, ask before killing it (it may belong to another session). Never kill port 3000 (the user's main server).

---

# Slice 1 — Relative-date resolver

## Task 1: `resolveRelativeDate` (pure) + smoke

**Files:**
- Create: `src/lib/relative-date.ts`
- Modify: `src/lib/interaction-date.ts:33` (add `export` to `WEEKDAYS`)
- Create: `scripts/smoke-relative-date.ts`

**Interfaces:**
- Consumes: `atLocalNoon`, `WEEKDAYS` from `src/lib/interaction-date.ts`
- Produces:
  ```ts
  export type DateBasis = "absolute" | "relative" | "vague";
  export type ResolvedRelativeDate = { date: Date; basis: DateBasis; rule: string };
  export const DEFAULT_VAGUE_WINDOW_DAYS = 14;
  export function resolveRelativeDate(phrase: string, anchor: Date, opts?: { defaultWindowDays?: number }): ResolvedRelativeDate | null;
  ```

- [ ] **Step 1: Export `WEEKDAYS`**

In `src/lib/interaction-date.ts` change `const WEEKDAYS: Record<string, number> = {` to `export const WEEKDAYS: Record<string, number> = {`.

- [ ] **Step 2: Write the failing smoke test**

Create `scripts/smoke-relative-date.ts`:

```ts
/**
 * The relative-date grammar, pinned to a fixed anchor so every rule is checked against a
 * known calendar. No network, no DB.
 * Run: npx tsx scripts/smoke-relative-date.ts
 */
import { resolveRelativeDate } from "../src/lib/relative-date";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}
function iso(d: Date | null | undefined) {
  if (!d) return "null";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Tuesday 2026-09-01, 9:30 local — not noon, so the noon pin is exercised.
const ANCHOR = new Date(2026, 8, 1, 9, 30, 0, 0);

const table: Array<[phrase: string, expectedIso: string, basis: string, rule: string]> = [
  ["tomorrow", "2026-09-02", "relative", "tomorrow"],
  ["in 3 days", "2026-09-04", "relative", "in-n-units"],
  ["in two weeks", "2026-09-15", "relative", "in-n-units"],
  ["in a couple of weeks", "2026-09-15", "relative", "in-n-units"],
  ["in a few days", "2026-09-04", "relative", "in-n-units"],
  ["in 2 months", "2026-11-01", "relative", "in-n-units"],
  ["Friday", "2026-09-04", "relative", "weekday"],
  ["next Friday", "2026-09-04", "relative", "weekday"],
  ["this Tuesday", "2026-09-08", "relative", "weekday"], // strictly after the anchor Tuesday
  ["next week", "2026-09-07", "relative", "next-week"],
  ["next month", "2026-10-01", "relative", "next-month"],
  ["end of the week", "2026-09-04", "relative", "end-of-week"],
  ["EOW", "2026-09-04", "relative", "end-of-week"],
  ["end of month", "2026-09-30", "relative", "end-of-month"],
  ["eom", "2026-09-30", "relative", "end-of-month"],
  ["end of the quarter", "2026-09-30", "relative", "end-of-quarter"],
  ["end of year", "2026-12-31", "relative", "end-of-year"],
  ["Q4", "2026-10-01", "relative", "quarter"],
  ["Q3", "2027-07-01", "relative", "quarter"], // Q3 2026 already started → next year
  ["after the holidays", "2027-01-02", "relative", "after-holidays"],
  ["soon", "2026-09-15", "vague", "vague"],
  ["at some point", "2026-09-15", "vague", "vague"],
  ["when you get a chance", "2026-09-15", "vague", "vague"],
  ["next time", "2026-09-15", "vague", "vague"],
];

for (const [phrase, expected, basis, rule] of table) {
  const r = resolveRelativeDate(phrase, ANCHOR);
  check(`"${phrase}" → ${expected}`, r !== null && iso(r.date) === expected, iso(r?.date));
  check(`  basis ${basis}`, r?.basis === basis, r?.basis);
  check(`  rule ${rule}`, r?.rule === rule, r?.rule);
  check(`  pinned to noon`, r?.date.getHours() === 12, String(r?.date.getHours()));
}

// Unknown phrasing is a null, never a guess.
check('"Sept 2" is not relative', resolveRelativeDate("Sept 2", ANCHOR) === null);
check('"the deck" is null', resolveRelativeDate("the deck", ANCHOR) === null);
check('"last week" is null (past)', resolveRelativeDate("last week", ANCHOR) === null);

// Vague window is configurable.
{
  const r = resolveRelativeDate("soon", ANCHOR, { defaultWindowDays: 7 });
  check("vague window honors defaultWindowDays", iso(r?.date) === "2026-09-08", iso(r?.date));
}

// Month arithmetic clamps instead of overflowing: Jan 31 + 1 month is Feb 28, not Mar 3.
{
  const jan31 = new Date(2026, 0, 31, 12);
  const r = resolveRelativeDate("in 1 month", jan31);
  check("in 1 month from Jan 31 → Feb 28", iso(r?.date) === "2026-02-28", iso(r?.date));
}

// Case and surrounding whitespace do not matter.
check("case-insensitive", iso(resolveRelativeDate("  Next FRIDAY ", ANCHOR)?.date) === "2026-09-04");

console.log("\nsmoke-relative-date: all checks passed");
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx tsx scripts/smoke-relative-date.ts`
Expected: fails with `Cannot find module '../src/lib/relative-date'`.

- [ ] **Step 4: Implement `src/lib/relative-date.ts`**

```ts
/**
 * Resolves a relative date phrase ("in two weeks", "next Friday", "soon") against an anchor
 * date — the date the note is about, not necessarily today.
 *
 * Pure and deterministic so the grammar is checkable without a model; the AI only copies
 * the phrase verbatim, and `validateCommitments` proves the phrase exists in the note before
 * this runs. Unknown phrasing returns null rather than a guess.
 *
 * Deliberately NOT `parseInteractionDateFromNotes`: that walks yearless dates backwards to
 * date a past interaction. This always looks forward.
 */
import { WEEKDAYS, atLocalNoon } from "@/lib/interaction-date";

export type DateBasis = "absolute" | "relative" | "vague";

export type ResolvedRelativeDate = {
  date: Date;
  basis: DateBasis;
  /** Which grammar rule fired — surfaced in the results view and asserted by the smoke test. */
  rule: string;
};

export const DEFAULT_VAGUE_WINDOW_DAYS = 14;

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, a: 1, an: 1, "a couple of": 2, "a couple": 2,
  couple: 2, "a few": 3, few: 3, several: 3,
};

const WEEKDAY_ALTERNATION = Object.keys(WEEKDAYS).sort((a, b) => b.length - a.length).join("|");

const VAGUE_RE =
  /^(soon|at some point|sometime|some time|later|eventually|when (i|you|we) (get|have) (a|the) chance|next time|when (i'm|you're|i am|you are) back)$/;

function norm(phrase: string) {
  return phrase.replace(/\s+/g, " ").trim().toLowerCase();
}

function addDays(d: Date, n: number) {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return atLocalNoon(out);
}

/** Month arithmetic that clamps to the last day of the target month instead of overflowing. */
function addMonths(d: Date, n: number) {
  const target = new Date(d.getFullYear(), d.getMonth() + n, 1, 12);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(d.getDate(), lastDay));
  return atLocalNoon(target);
}

function endOfMonth(d: Date) {
  return atLocalNoon(new Date(d.getFullYear(), d.getMonth() + 1, 0, 12));
}

/** First strictly-after occurrence of a weekday. "Friday" on a Friday means next week. */
function nextWeekday(from: Date, weekday: number) {
  const delta = (weekday - from.getDay() + 7) % 7 || 7;
  return addDays(from, delta);
}

/** Monday of the week after the anchor's week (weeks start Monday). */
function nextWeekMonday(from: Date) {
  const dow = from.getDay(); // 0 = Sunday
  const daysUntilNextMonday = dow === 0 ? 1 : 8 - dow;
  return addDays(from, daysUntilNextMonday);
}

function parseCount(raw: string): number | null {
  const s = raw.trim();
  if (/^\d+$/.test(s)) return Number(s);
  return NUMBER_WORDS[s] ?? null;
}

export function resolveRelativeDate(
  phrase: string,
  anchor: Date,
  opts?: { defaultWindowDays?: number }
): ResolvedRelativeDate | null {
  const p = norm(phrase);
  if (!p) return null;
  const base = atLocalNoon(anchor);
  const relative = (date: Date, rule: string): ResolvedRelativeDate => ({ date, basis: "relative", rule });

  if (p === "tomorrow") return relative(addDays(base, 1), "tomorrow");

  // "in N days|weeks|months", N numeric or a small number word.
  const inN = p.match(/^in (\d+|[a-z]+(?: [a-z]+){0,2}?) (day|week|month)s?$/);
  if (inN) {
    const n = parseCount(inN[1]);
    if (n == null || n <= 0) return null;
    const unit = inN[2];
    if (unit === "day") return relative(addDays(base, n), "in-n-units");
    if (unit === "week") return relative(addDays(base, n * 7), "in-n-units");
    return relative(addMonths(base, n), "in-n-units");
  }

  // Bare weekday, "next <weekday>", "this <weekday>" — all mean the first one strictly after the anchor.
  const wd = p.match(new RegExp(`^(?:next |this |on )?(${WEEKDAY_ALTERNATION})$`));
  if (wd) {
    const weekday = WEEKDAYS[wd[1]];
    if (weekday == null) return null;
    return relative(nextWeekday(base, weekday), "weekday");
  }

  if (p === "next week") return relative(nextWeekMonday(base), "next-week");
  if (p === "next month") {
    return relative(atLocalNoon(new Date(base.getFullYear(), base.getMonth() + 1, 1, 12)), "next-month");
  }

  if (/^(end of (the )?week|eow)$/.test(p)) {
    // Friday of the anchor's week; if the anchor is already Friday or later, next Friday.
    const friday = 5;
    const delta = (friday - base.getDay() + 7) % 7;
    return relative(addDays(base, delta === 0 ? 0 : delta), "end-of-week");
  }
  if (/^(end of (the )?month|eom)$/.test(p)) return relative(endOfMonth(base), "end-of-month");
  if (/^(end of (the )?quarter|eoq)$/.test(p)) {
    const qEndMonth = Math.floor(base.getMonth() / 3) * 3 + 2;
    return relative(atLocalNoon(new Date(base.getFullYear(), qEndMonth + 1, 0, 12)), "end-of-quarter");
  }
  if (/^(end of (the )?year|eoy)$/.test(p)) {
    return relative(atLocalNoon(new Date(base.getFullYear(), 11, 31, 12)), "end-of-year");
  }

  // "Q1".."Q4": first day of that quarter, next future occurrence (a quarter already begun rolls a year).
  const q = p.match(/^q([1-4])$/);
  if (q) {
    const startMonth = (Number(q[1]) - 1) * 3;
    let candidate = new Date(base.getFullYear(), startMonth, 1, 12);
    if (candidate <= base) candidate = new Date(base.getFullYear() + 1, startMonth, 1, 12);
    return relative(atLocalNoon(candidate), "quarter");
  }

  if (/^after the holidays$/.test(p)) {
    const jan2 = new Date(base.getFullYear() + (base.getMonth() === 0 && base.getDate() < 2 ? 0 : 1), 0, 2, 12);
    return relative(atLocalNoon(jan2), "after-holidays");
  }

  if (VAGUE_RE.test(p)) {
    const days = opts?.defaultWindowDays ?? DEFAULT_VAGUE_WINDOW_DAYS;
    return { date: addDays(base, days), basis: "vague", rule: "vague" };
  }

  return null;
}
```

Note on the `end-of-week` rule: the smoke table anchors on a Tuesday, so "end of the week" is that Friday. When the anchor is a Saturday or Sunday, `delta` lands on the coming Friday, which is the intended reading.

- [ ] **Step 5: Run the smoke test until it passes**

Run: `npx tsx scripts/smoke-relative-date.ts`
Expected: every line prefixed `ok`, ending in `smoke-relative-date: all checks passed`. If the `in a couple of weeks` case fails, the lazy quantifier in `inN` is not capturing three words; make the count group `([a-z]+(?: [a-z]+){0,2})` (greedy) and re-run.

- [ ] **Step 6: Typecheck and commit**

```bash
npx tsc --noEmit
git add src/lib/relative-date.ts src/lib/interaction-date.ts scripts/smoke-relative-date.ts
git commit -m "feat(notes): deterministic relative-date resolver"
```

## Task 2: Route relative phrases through `validateCommitments`, split the AI fetch from validation

**Files:**
- Modify: `src/lib/date-commitment-extract.ts`
- Modify: `scripts/smoke-date-commitments.ts` (signature change + new cases)
- Modify: `src/actions/capture.ts:196-215, 272-300` (anchor + basis in preview)
- Modify: `src/components/capture/suggested-reminders-review.tsx` (show basis label; find the line rendering `rawDatePhrase`)

**Interfaces:**
- Consumes: `resolveRelativeDate`, `DateBasis` from Task 1
- Produces:
  ```ts
  export type DatedCommitment = { ...existing fields; dateBasis: DateBasis; anchorIso: string };
  export type ValidateOptions = { today: Date; anchor?: Date };
  export function validateCommitments(rawItems: RawCommitmentItem[], notes: string, opts: ValidateOptions): DatedCommitmentResult;
  export async function fetchRawCommitments(userId: string, notes: string, options?: { today?: Date; knownPeople?: string[] }): Promise<RawCommitmentItem[]>;
  export async function extractDatedCommitments(userId, notes, options?: { today?: Date; anchor?: Date; knownPeople?: string[] }): Promise<DatedCommitmentResult>; // fetch + validate
  ```
  `RejectedCounts` is unchanged; `relative` now means "relative phrase the grammar could not resolve".
  `SuggestedReminderPreview` (in `src/actions/capture.ts`) gains `dateBasis: DateBasis` and `anchorIso: string`.

- [ ] **Step 1: Update the existing smoke script to the new signature and add failing cases**

In `scripts/smoke-date-commitments.ts`, replace every call `validateCommitments(X, notes, AUG)` with `validateCommitments(X, notes, { today: AUG })` and `DEC` likewise (`sed -i '' 's/, AUG)/, { today: AUG })/g; s/, DEC)/, { today: DEC })/g' scripts/smoke-date-commitments.ts`, then eyeball with `grep -n validateCommitments`). Append before the final log line:

```ts
// 9. Relative phrases resolve against the ANCHOR (the note's date), not today.
{
  const anchor = new Date(2026, 8, 1, 12); // Tue Sept 1 — the meeting date found in the notes
  const today = new Date(2026, 8, 3, 12);  // pasted two days later
  const notes = "Great chat with Sarah. She'll send the deck in two weeks and we meet next Friday.";
  const r = validateCommitments(
    [
      item({ title: "Send deck", raw_date_phrase: "in two weeks", date: "" }),
      item({ title: "Meet Sarah", raw_date_phrase: "next Friday", date: "" }),
    ],
    notes,
    { today, anchor }
  );
  check("relative: two commitments resolved", r.commitments.length === 2, String(r.commitments.length));
  check("  'in two weeks' from Sept 1 → Sept 15", isoDay(r.commitments[0].dueDate) === "2026-09-15", isoDay(r.commitments[0].dueDate));
  check("  'next Friday' from Sept 1 → Sept 4", isoDay(r.commitments[1].dueDate) === "2026-09-04", isoDay(r.commitments[1].dueDate));
  check("  basis relative", r.commitments[0].dateBasis === "relative");
  check("  anchorIso recorded", r.commitments[0].anchorIso === "2026-09-01", r.commitments[0].anchorIso);
  check("  rejected.relative is 0", r.rejected.relative === 0);
}

// 10. A relative phrase that already passed by TODAY is skipped as past, even if it was
//     in the future relative to the anchor.
{
  const anchor = new Date(2026, 8, 1, 12);
  const today = new Date(2026, 8, 10, 12);
  const notes = "Ping him tomorrow about the intro.";
  const r = validateCommitments([item({ title: "Ping about intro", raw_date_phrase: "tomorrow", date: "" })], notes, { today, anchor });
  check("late upload: 'tomorrow' from Sept 1 is past on Sept 10", r.commitments.length === 0 && r.rejected.past === 1, JSON.stringify(r.rejected));
}

// 11. Vague phrasing lands on the default window with basis "vague".
{
  const anchor = new Date(2026, 8, 1, 12);
  const notes = "Should grab coffee soon.";
  const r = validateCommitments([item({ title: "Grab coffee", raw_date_phrase: "soon", date: "" })], notes, { today: anchor, anchor });
  check("vague 'soon' → anchor + 14d", isoDay(r.commitments[0]?.dueDate) === "2026-09-15", isoDay(r.commitments[0]?.dueDate));
  check("  basis vague", r.commitments[0]?.dateBasis === "vague");
}

// 12. A relative phrase the grammar does not know is still rejected as relative.
{
  const anchor = new Date(2026, 8, 1, 12);
  const notes = "Let's sync in a fortnight or so.";
  const r = validateCommitments([item({ title: "Sync", raw_date_phrase: "in a fortnight", date: "" })], notes, { today: anchor, anchor });
  check("unknown relative phrase rejected", r.commitments.length === 0 && r.rejected.relative === 1, JSON.stringify(r.rejected));
}

// 13. Absolute dates still resolve exactly as before and carry basis "absolute" + anchor.
{
  const anchor = new Date(2026, 8, 1, 12);
  const notes = "Kickoff is Sept 20.";
  const r = validateCommitments([item({ title: "Kickoff", raw_date_phrase: "Sept 20", date: "2026-09-20" })], notes, { today: anchor, anchor });
  check("absolute basis", r.commitments[0]?.dateBasis === "absolute" && r.commitments[0]?.anchorIso === "2026-09-01");
}

// 14. Without an anchor, today is the anchor.
{
  const today = new Date(2026, 8, 1, 12);
  const r = validateCommitments([item({ title: "Ping", raw_date_phrase: "tomorrow", date: "" })], "Ping tomorrow.", { today });
  check("no anchor → today", isoDay(r.commitments[0]?.dueDate) === "2026-09-02", isoDay(r.commitments[0]?.dueDate));
}
```

- [ ] **Step 2: Run to verify the new cases fail**

Run: `npx tsx scripts/smoke-date-commitments.ts`
Expected: TypeScript error on the options object or `relative: two commitments resolved failed`.

- [ ] **Step 3: Implement in `src/lib/date-commitment-extract.ts`**

1. Imports: add `import { resolveRelativeDate, type DateBasis } from "@/lib/relative-date";`.
2. `DatedCommitment`: add `dateBasis: DateBasis;` and `anchorIso: string;` after `sourceExcerpt`.
3. Add `export type ValidateOptions = { today: Date; anchor?: Date };`.
4. Change the signature to `validateCommitments(rawItems, notes, opts: ValidateOptions)` and at the top: `const today = opts.today; const anchor = atLocalNoon(opts.anchor ?? today); const anchorIso = toIsoDay(anchor);`.
5. Replace steps 2–3 of the loop (the `RELATIVE_RE.test(phrase)` rejection and `deriveMonthDay`) with:

```ts
    // 2. Relative phrasing resolves against the anchor through the deterministic grammar.
    //    Unknown relative phrasing is rejected — never guessed.
    let resolvedDate: Date;
    let yearInferred = false;
    let dateBasis: DateBasis;
    if (RELATIVE_RE.test(phrase) || !deriveMonthDay(phrase)) {
      const rel = resolveRelativeDate(phrase, anchor);
      if (!rel) {
        rejected.relative += 1;
        continue;
      }
      resolvedDate = rel.date;
      dateBasis = rel.basis;
    } else {
      // 3. Absolute: the phrase names a calendar date; the model's ISO must agree.
      const md = deriveMonthDay(phrase)!;
      const resolved = resolveDate(md, today);
      if (!resolved) {
        rejected.unverifiable += 1;
        continue;
      }
      const modelIso = item.date.trim();
      const modelMatch = modelIso.match(ISO_RE);
      if (modelMatch) {
        const modelMonth = Number(modelMatch[2]) - 1;
        const modelDay = Number(modelMatch[3]);
        if (modelMonth !== md.month || modelDay !== md.day) {
          rejected.unverifiable += 1;
          continue;
        }
      }
      resolvedDate = resolved.date;
      yearInferred = resolved.yearInferred;
      dateBasis = "absolute";
    }

    // 4. A reminder in the past (by TODAY, not the anchor) is noise the user has to clear.
    if (resolvedDate < todayStart) {
      rejected.past += 1;
      continue;
    }
```

   and in the pushed object use `dueDate: atLocalNoon(resolvedDate), yearInferred, dateBasis, anchorIso`. Keep the title/dedupe/actionKind logic as is. Also loosen `RELATIVE_RE` so it no longer blocks phrases the grammar handles — it is now only a classifier: keep it, but remove `last|yesterday` from being resolvable by leaving them out of the grammar (they return null → rejected). Update the doc comment on `RELATIVE_RE` to say "classifies a phrase as relative; the grammar in relative-date.ts decides if it resolves".
6. Split the network call:

```ts
export async function fetchRawCommitments(
  userId: string,
  notes: string,
  options?: { today?: Date; knownPeople?: string[] }
): Promise<RawCommitmentItem[]> {
  const trimmed = notes.trim();
  if (!trimmed) return [];
  const today = options?.today ?? new Date();
  const todayIso = toIsoDay(today);
  const todayWeekday = WEEKDAY_NAMES[today.getDay()];
  const corpus = trimmed.slice(0, MAX_NOTE_CHARS);
  const people = (options?.knownPeople || []).filter(Boolean);
  const peopleBlock = people.length ? `People likely mentioned:\n- ${people.join("\n- ")}\n\n` : "";
  const content = await completeJson(userId, {
    operation: "capture.dates",
    temperature: 0.1,
    maxOutputTokens: 2048,
    system: buildSystemPrompt(todayIso, todayWeekday),
    user: `Today: ${todayIso} (${todayWeekday})\n\n${peopleBlock}Notes:\n${corpus}`,
  });
  return datedCommitmentsSchema.parse(JSON.parse(content)).commitments;
}

export async function extractDatedCommitments(
  userId: string,
  notes: string,
  options?: { today?: Date; anchor?: Date; knownPeople?: string[] }
): Promise<DatedCommitmentResult> {
  const today = options?.today ?? new Date();
  const raw = await fetchRawCommitments(userId, notes, { today, knownPeople: options?.knownPeople });
  return validateCommitments(raw, notes.trim().slice(0, MAX_NOTE_CHARS), { today, anchor: options?.anchor });
}
```

7. Rewrite the prompt's rule block (`buildSystemPrompt`) so the "ABSOLUTE DATES ONLY" section becomes:

```
DATED COMMITMENTS. Extract every commitment, follow-up, deadline, or event the notes attach a time to, whether the time is:
- an absolute calendar date ("Sept 2", "December 1", "15th of October", "9/2", "2026-09-02"), or
- a relative phrase ("next Tuesday", "in two weeks", "end of the month", "Q4", "tomorrow", "after the holidays"), or
- a vague phrase ("soon", "at some point", "when you get a chance").
- DISCARD commitments with no time reference at all ("I'll send the deck", "we should grab coffee").
- NEVER rewrite a relative or vague phrase into a calendar date. Copy it verbatim into raw_date_phrase and leave "date" as "" for those.

Field rules:
- raw_date_phrase: the time text copied VERBATIM from the notes, exactly as written and nothing more — for "she'll send it in two weeks" that is "in two weeks". It must appear character-for-character in the notes.
- date_kind: "absolute" when raw_date_phrase names a month or numeric date, "relative" when it is anchored to now/the meeting ("next", "in N", "tomorrow", "end of"), "vague" when it names no interval ("soon", "sometime").
- date: for absolute phrases only, YYYY-MM-DD (infer the nearest FUTURE year when unstated, year_stated=false). For relative and vague phrases use "".
```

   Keep the remaining field rules (title, detail, person_name, kind, confidence, source_excerpt) and the "Other rules" block, and update the JSON shape to include `"date_kind": "absolute"|"relative"|"vague"`. Add `date_kind: nullTrimmed` to `commitmentItemSchema` (parsed but not trusted; the validator classifies itself).

- [ ] **Step 4: Run both smoke scripts**

Run: `npx tsx scripts/smoke-date-commitments.ts && npx tsx scripts/smoke-relative-date.ts`
Expected: all `ok`. Case 2 (December → January year boundary) must still pass; if it fails, the absolute branch is being routed into the relative branch — check that `deriveMonthDay("Jan 8")` returns non-null before the `RELATIVE_RE` test.

- [ ] **Step 5: Wire the anchor into `parseBulkCaptureNotes`**

In `src/actions/capture.ts`:
- Replace the import of `extractDatedCommitments` with `fetchRawCommitments, validateCommitments, emptyCommitmentResult, type RejectedCounts`.
- Replace the `Promise.all` block:

```ts
    const today = new Date();
    const [personParse, rawCommitments] = await Promise.all([
      parseMultiPersonNotesWithAI(userId, corpus, mergedHints),
      fetchRawCommitments(userId, corpus, {
        today,
        knownPeople: seedPeople.map((p) => p.name).filter(Boolean) as string[],
      }).catch(() => [] as Awaited<ReturnType<typeof fetchRawCommitments>>),
    ]);

    const { people, shared_notes, interaction_date } = personParse;
    // The anchor is the date the notes are ABOUT: what the people pass found, else the
    // calendar/email hint, else the upload moment. Relative phrases count from it.
    const anchorSource = interaction_date || mergedHints.eventDate || null;
    const anchor = anchorSource ? isoDayToLocalNoon(anchorSource) : today;
    const anchorBasis: "note" | "hint" | "upload" = interaction_date ? "note" : mergedHints.eventDate ? "hint" : "upload";
    const commitmentResult = (() => {
      try {
        return validateCommitments(rawCommitments, corpus, { today, anchor });
      } catch {
        return emptyCommitmentResult();
      }
    })();
```

- In `SuggestedReminderPreview` add `dateBasis: DateBasis; anchorIso: string;` (import `type DateBasis` from `@/lib/relative-date`) and map them from `c.dateBasis`, `c.anchorIso`.
- Return `anchorIso: isoDay(anchor), anchorBasis` alongside `interactionDate`.

- [ ] **Step 6: Show the basis in the review UI**

In `src/components/capture/suggested-reminders-review.tsx`, where each row renders `rawDatePhrase` (grep `rawDatePhrase`), append a muted hint when `item.dateBasis !== "absolute"`:

```tsx
{item.dateBasis !== "absolute" && (
  <span className="text-[11px] text-muted-foreground">
    {" "}· counted from {item.anchorIso}{item.dateBasis === "vague" ? " (no date given, default 2 weeks)" : ""}
  </span>
)}
```

The `SuggestionReviewItem` type in `bulk-notes-panel.tsx` extends `SuggestedReminderPreview`, so the fields flow through without further changes. The staged `suggested_reminders` insert in `confirmBulkCapture` ignores the two new fields (the table has no column for them; Slice 2 replaces that path).

- [ ] **Step 7: Typecheck, build check, commit**

```bash
npx tsc --noEmit
npx eslint src/lib/date-commitment-extract.ts src/actions/capture.ts src/components/capture/suggested-reminders-review.tsx
git add -A src/lib/date-commitment-extract.ts src/actions/capture.ts src/components/capture/suggested-reminders-review.tsx scripts/smoke-date-commitments.ts
git commit -m "feat(notes): resolve relative and vague date phrases against the note's anchor date"
```

**Slice 1 ships here.** Relative dates now flow into the existing suggest-then-confirm panel.

---

# Slice 2 — Schema v17, auto-create, note batches, results page, undo

## Task 3: Schema v17

**Files:**
- Modify: `src/db/schema.ts` (after `suggestedReminders`, ~line 583; `reminders` at 499; `interactions` at 437; relations near 1733)
- Modify: `src/db/index.ts` (`DDL` template after the `suggested_reminders` indexes ~line 212; `reminders` body at 176; `interactions` body at 149; `SCHEMA_VERSION` at 670; `migratePglite` ensureColumn block ~962; `alters` ~1395; `ADMIN_V2_STATEMENTS` ~1280)
- Modify: `scripts/schema-ddl.lock.json` (via `--update`)

**Interfaces:**
- Produces (Drizzle tables): `noteBatches`, `interactionMentions`, `actionItems`, `contactBriefs`; new columns `reminders.noteBatchId/sourceInteractionId/actionItemId/sourceExcerpt/rawDatePhrase/dateBasis/itemHash`, `interactions.noteBatchId`; types `NoteBatchResult`, `NoteBatch`, `InteractionMention`, `ActionItem`, `ContactBrief`, `ReminderDateBasis`.

- [ ] **Step 1: Add the result type and tables to `src/db/schema.ts`**

Insert after the `suggestedReminders` table definition (before `export type ImportStats`):

```ts
export type ReminderDateBasis = "absolute" | "relative" | "vague" | "window";

/**
 * What one confirmed note paste produced, rendered by `/capture/[batchId]`. Stored as a
 * snapshot: the rows it points at may later be edited or dismissed, and the page shows
 * live status alongside this record of what was created.
 */
export type NoteBatchResult = {
  participants: { contactId: string; interactionId: string | null; name: string; created: boolean; duplicate: boolean }[];
  mentions: { interactionId: string; contactId: string; text: string; confidence: number; matchedBy: string }[];
  unresolvedMentions: { text: string; context: string | null }[];
  actionItems: { id: string; contactId: string; text: string; reminderId: string | null }[];
  reminders: { id: string; contactId: string | null; title: string; dueIso: string; dateBasis: ReminderDateBasis; rawDatePhrase: string | null; sourceExcerpt: string | null }[];
  skipped: { relative: number; unverifiable: number; past: number; duplicate: number };
};

/** One confirmed paste of notes — the unit the results page and Undo operate on. */
export const noteBatches = pgTable(
  "note_batches",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    sourceHash: text("source_hash").notNull(),
    sourceText: text("source_text").notNull(),
    entryPoint: text("entry_point").$type<"capture" | "profile">().default("capture").notNull(),
    seedContactId: uuid("seed_contact_id"),
    /** The date relative phrases were counted from. */
    anchorDate: timestamp("anchor_date", { withTimezone: true }).notNull(),
    anchorBasis: text("anchor_basis").$type<"note" | "hint" | "upload">().default("upload").notNull(),
    status: text("status").$type<"saved" | "undone">().default("saved").notNull(),
    result: jsonb("result").$type<NoteBatchResult>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    undoneAt: timestamp("undone_at", { withTimezone: true }),
  },
  (t) => [
    index("note_batches_user_created_idx").on(t.userId, t.createdAt),
    index("note_batches_user_source_idx").on(t.userId, t.sourceHash),
  ]
);

/** A contact named in a note they were not a participant of. Shown on both profiles. */
export const interactionMentions = pgTable(
  "interaction_mentions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    interactionId: uuid("interaction_id").notNull().references(() => interactions.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
    mentionText: text("mention_text").notNull(),
    confidence: real("confidence").notNull(),
    matchedBy: text("matched_by").$type<"exact_name" | "name_company" | "first_name_unique" | "user_pick">().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("interaction_mentions_interaction_contact_uidx").on(t.interactionId, t.contactId),
    index("interaction_mentions_user_contact_idx").on(t.userId, t.contactId),
  ]
);

/**
 * One row per action item extracted from (or typed into) an interaction, with completion
 * state. `interactions.action_items` stays as a write-through denorm for existing readers;
 * this table is the source of truth for "open next steps".
 */
export const actionItems = pgTable(
  "action_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    contactId: uuid("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
    interactionId: uuid("interaction_id").notNull().references(() => interactions.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    position: integer("position").default(0).notNull(),
    status: text("status").$type<"open" | "done">().default("open").notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    /** sha256(`${interactionId}|${text.trim().toLowerCase()}`) — see `actionItemHash` in src/lib/action-items.ts. */
    itemHash: text("item_hash").notNull(),
    reminderId: uuid("reminder_id").references(() => reminders.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("action_items_user_item_hash_uidx").on(t.userId, t.itemHash),
    index("action_items_user_contact_status_idx").on(t.userId, t.contactId, t.status),
  ]
);

/** The structured profile brief. 1:1 with contacts; kept off `contacts` because that table is scanned whole on hot paths. */
export const contactBriefs = pgTable("contact_briefs", {
  contactId: uuid("contact_id").primaryKey().references(() => contacts.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  standing: text("standing").notNull(),
  recentDiscussions: jsonb("recent_discussions").$type<{ interactionId: string; dateIso: string; line: string }[]>().default([]).notNull(),
  generatedAt: timestamp("generated_at", { withTimezone: true }).defaultNow().notNull(),
  basisInteractionId: uuid("basis_interaction_id"),
  model: text("model"),
});
```

Because `actionItems` references `reminders` and `reminders` will reference `actionItems`, declare the `reminders` foreign key with a lazy reference and place `actionItems` after `reminders` (it already is). In the `reminders` table add, after `createdBy`:

```ts
    /** Set when the reminder came out of a note paste; links to the results page and drives "From notes". */
    noteBatchId: uuid("note_batch_id"),
    sourceInteractionId: uuid("source_interaction_id").references(() => interactions.id, { onDelete: "set null" }),
    actionItemId: uuid("action_item_id"),
    sourceExcerpt: text("source_excerpt"),
    rawDatePhrase: text("raw_date_phrase"),
    dateBasis: text("date_basis").$type<ReminderDateBasis>(),
    /** `buildSuggestionItemHash(sourceHash, dueIso, title)`; soft-unique per user (NULLs allowed) so a re-paste cannot recreate a reminder. */
    itemHash: text("item_hash"),
```

and in its index list add `uniqueIndex("reminders_user_item_hash_uidx").on(t.userId, t.itemHash)`. (`actionItemId` is a plain uuid, not a `.references()`, to avoid the circular table reference; the FK is declared in SQL only.)

In `interactions` add after `externalId`: `noteBatchId: uuid("note_batch_id"),`.

Relations (near line 1733):

```ts
export const noteBatchesRelations = relations(noteBatches, ({ many }) => ({
  reminders: many(reminders),
}));
export const interactionMentionsRelations = relations(interactionMentions, ({ one }) => ({
  interaction: one(interactions, { fields: [interactionMentions.interactionId], references: [interactions.id] }),
  contact: one(contacts, { fields: [interactionMentions.contactId], references: [contacts.id] }),
}));
export const actionItemsRelations = relations(actionItems, ({ one }) => ({
  interaction: one(interactions, { fields: [actionItems.interactionId], references: [interactions.id] }),
  contact: one(contacts, { fields: [actionItems.contactId], references: [contacts.id] }),
}));
export const contactBriefsRelations = relations(contactBriefs, ({ one }) => ({
  contact: one(contacts, { fields: [contactBriefs.contactId], references: [contacts.id] }),
}));
```

Add to `interactionsRelations`: `mentions: many(interactionMentions), actionItems: many(actionItems)` (change `({ one })` to `({ one, many })`). Add to `contactsRelations`: `brief: one(contactBriefs, { fields: [contacts.id], references: [contactBriefs.contactId] })` — check whether that relation object already uses `one`; if it destructures only `many`, change to `({ one, many })`. Row types at the bottom: `export type NoteBatch = typeof noteBatches.$inferSelect; export type InteractionMention = typeof interactionMentions.$inferSelect; export type ActionItem = typeof actionItems.$inferSelect; export type ContactBrief = typeof contactBriefs.$inferSelect;`.

- [ ] **Step 2: Mirror in `src/db/index.ts`**

1. In the `DDL` template, `interactions` body: add `  note_batch_id uuid,` after `external_id text,`. `reminders` body: add after `created_by text NOT NULL DEFAULT 'user',`:
   ```
     note_batch_id uuid,
     source_interaction_id uuid REFERENCES interactions(id) ON DELETE SET NULL,
     action_item_id uuid,
     source_excerpt text,
     raw_date_phrase text,
     date_basis text,
     item_hash text,
   ```
2. In the `DDL` template after the `suggested_reminders` indexes:
   ```sql
   CREATE TABLE IF NOT EXISTS note_batches (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     user_id text NOT NULL,
     source_hash text NOT NULL,
     source_text text NOT NULL,
     entry_point text NOT NULL DEFAULT 'capture',
     seed_contact_id uuid,
     anchor_date timestamptz NOT NULL,
     anchor_basis text NOT NULL DEFAULT 'upload',
     status text NOT NULL DEFAULT 'saved',
     result jsonb NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now(),
     undone_at timestamptz
   );
   CREATE INDEX IF NOT EXISTS note_batches_user_created_idx ON note_batches(user_id, created_at);
   CREATE INDEX IF NOT EXISTS note_batches_user_source_idx ON note_batches(user_id, source_hash);
   CREATE TABLE IF NOT EXISTS interaction_mentions (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     user_id text NOT NULL,
     interaction_id uuid NOT NULL REFERENCES interactions(id) ON DELETE CASCADE,
     contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
     mention_text text NOT NULL,
     confidence real NOT NULL,
     matched_by text NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now()
   );
   CREATE UNIQUE INDEX IF NOT EXISTS interaction_mentions_interaction_contact_uidx ON interaction_mentions(interaction_id, contact_id);
   CREATE INDEX IF NOT EXISTS interaction_mentions_user_contact_idx ON interaction_mentions(user_id, contact_id);
   CREATE TABLE IF NOT EXISTS action_items (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     user_id text NOT NULL,
     contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
     interaction_id uuid NOT NULL REFERENCES interactions(id) ON DELETE CASCADE,
     text text NOT NULL,
     position integer NOT NULL DEFAULT 0,
     status text NOT NULL DEFAULT 'open',
     completed_at timestamptz,
     item_hash text NOT NULL,
     reminder_id uuid REFERENCES reminders(id) ON DELETE SET NULL,
     created_at timestamptz NOT NULL DEFAULT now()
   );
   CREATE UNIQUE INDEX IF NOT EXISTS action_items_user_item_hash_uidx ON action_items(user_id, item_hash);
   CREATE INDEX IF NOT EXISTS action_items_user_contact_status_idx ON action_items(user_id, contact_id, status);
   CREATE TABLE IF NOT EXISTS contact_briefs (
     contact_id uuid PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,
     user_id text NOT NULL,
     standing text NOT NULL,
     recent_discussions jsonb NOT NULL DEFAULT '[]',
     generated_at timestamptz NOT NULL DEFAULT now(),
     basis_interaction_id uuid,
     model text
   );
   ```
3. Neon `alters` list — append:
   ```ts
   `ALTER TABLE interactions ADD COLUMN IF NOT EXISTS note_batch_id uuid`,
   `ALTER TABLE reminders ADD COLUMN IF NOT EXISTS note_batch_id uuid`,
   `ALTER TABLE reminders ADD COLUMN IF NOT EXISTS source_interaction_id uuid REFERENCES interactions(id) ON DELETE SET NULL`,
   `ALTER TABLE reminders ADD COLUMN IF NOT EXISTS action_item_id uuid`,
   `ALTER TABLE reminders ADD COLUMN IF NOT EXISTS source_excerpt text`,
   `ALTER TABLE reminders ADD COLUMN IF NOT EXISTS raw_date_phrase text`,
   `ALTER TABLE reminders ADD COLUMN IF NOT EXISTS date_basis text`,
   `ALTER TABLE reminders ADD COLUMN IF NOT EXISTS item_hash text`,
   ```
4. `migratePglite` — after the existing `ensureColumn` calls add:
   ```ts
   await ensureColumn(client, "interactions", "note_batch_id", "uuid");
   await ensureColumn(client, "reminders", "note_batch_id", "uuid");
   await ensureColumn(client, "reminders", "source_interaction_id", "uuid REFERENCES interactions(id) ON DELETE SET NULL");
   await ensureColumn(client, "reminders", "action_item_id", "uuid");
   await ensureColumn(client, "reminders", "source_excerpt", "text");
   await ensureColumn(client, "reminders", "raw_date_phrase", "text");
   await ensureColumn(client, "reminders", "date_basis", "text");
   await ensureColumn(client, "reminders", "item_hash", "text");
   ```
5. `ADMIN_V2_STATEMENTS` — append (both drivers run this after their column pass, and the DDL guard scans it for unique-index parity):
   ```ts
   `CREATE UNIQUE INDEX IF NOT EXISTS reminders_user_item_hash_uidx ON reminders(user_id, item_hash)`,
   `CREATE INDEX IF NOT EXISTS reminders_note_batch_idx ON reminders(note_batch_id)`,
   `CREATE INDEX IF NOT EXISTS interactions_note_batch_idx ON interactions(note_batch_id)`,
   // Legacy action items → rows. Idempotent through the unique (user_id, item_hash) index.
   // The hash formula MUST equal actionItemHash() in src/lib/action-items.ts.
   `INSERT INTO action_items (user_id, contact_id, interaction_id, text, position, item_hash)
    SELECT i.user_id, i.contact_id, i.id, a.value, a.ordinality - 1,
           encode(sha256(convert_to(i.id::text || '|' || lower(btrim(a.value)), 'UTF8')), 'hex')
    FROM interactions i, jsonb_array_elements_text(COALESCE(i.action_items, '[]'::jsonb)) WITH ORDINALITY a
    WHERE btrim(a.value) <> ''
    ON CONFLICT (user_id, item_hash) DO NOTHING`,
   ```
6. `export const SCHEMA_VERSION = 17;` and update its doc comment's last line to note v17 = note processing tables.

- [ ] **Step 3: Run the guard, update the lock, verify PGlite migrates**

```bash
npx tsc --noEmit
npx tsx scripts/smoke-schema-ddl.ts --update && npm run db:check
```

Expected: `db:check` passes; `scripts/schema-ddl.lock.json` now says `"version": 17`. If the coverage check reports a `reminders.action_item_id` or `contact_briefs.*` column missing, the column name in `schema.ts` and the SQL disagree — fix the SQL side. Then verify the migration actually runs (the guard is static):

```bash
npx tsx -e 'import("dotenv").then(({config})=>{config({path:".env.local"});config();delete process.env.DATABASE_URL;process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY||="pk_test_x";process.env.CLERK_SECRET_KEY||="sk_test_x";return import("./src/db/index.ts")}).then(async m=>{const db=await m.getDb();const r=await db.execute(m.SCHEMA_VERSION?`select count(*)::int as n from action_items`:"select 1");console.log(m.rowsOf(r));process.exit(0)})'
```

Expected: `[ { n: <number> } ]` with no thrown error (the backfill ran). If `sha256` is reported as an unknown function on PGlite, replace it with `digest(..., 'sha256')` from `pgcrypto` — but first confirm PGlite's Postgres version is ≥ 11 (`select version()`), where `sha256(bytea)` is built in.

- [ ] **Step 4: Commit**

```bash
git add src/db/schema.ts src/db/index.ts scripts/schema-ddl.lock.json
git commit -m "feat(db): schema v17 — note batches, mentions, action items, contact briefs, reminder provenance"
```

## Task 4: Batch helpers + idempotent note interaction write

**Files:**
- Create: `src/lib/note-batches.ts`
- Modify: `src/lib/contact-writes.ts` (`LogInteractionInput` ~119; add `logNoteInteractionForUser` after `logInteractionForUser` ~795)

**Interfaces:**
- Produces:
  ```ts
  // src/lib/note-batches.ts
  export type { NoteBatchResult, ReminderDateBasis } from "@/db/schema";
  export const DEFAULT_FOLLOW_UP_WINDOW_DAYS = 14;
  export const NOTE_INTERACTION_EXTERNAL_ID_PREFIX = "notes:";
  export function noteInteractionExternalId(sourceHash: string, contactId: string): string; // `notes:${sourceHash}:${contactId}`
  export function windowDueDate(anchor: Date, days?: number): Date;                        // anchor + days, local noon
  export function emptyNoteBatchResult(): NoteBatchResult;
  export function normalizeTitle(s: string): string;                                       // trim, collapse whitespace, lowercase
  export function titlesCollide(a: string, b: string): boolean;                            // normalizeTitle equality
  export function withinCollisionWindow(a: Date, b: Date, days?: number): boolean;         // |a-b| <= 3 days
  // src/lib/contact-writes.ts
  export type LogInteractionInput = { ...existing; externalId?: string; noteBatchId?: string };
  export async function logNoteInteractionForUser(userId: string, input: LogInteractionInput & { externalId: string }, options?: ContactWriteOptions): Promise<{ row: Interaction; created: boolean }>;
  ```

- [ ] **Step 1: Write `src/lib/note-batches.ts`**

```ts
/**
 * Pure helpers shared by the save path (src/lib/note-batch-save.ts), the capture action, and
 * the results page. No DB, no AI — everything here is unit-checkable.
 */
import { atLocalNoon } from "@/lib/interaction-date";
import type { NoteBatchResult } from "@/db/schema";

export type { NoteBatchResult, ReminderDateBasis } from "@/db/schema";

export const DEFAULT_FOLLOW_UP_WINDOW_DAYS = 14;
export const COLLISION_WINDOW_DAYS = 3;
export const NOTE_INTERACTION_EXTERNAL_ID_PREFIX = "notes:";

/** Re-pasting the same note for the same contact must not log a second interaction. */
export function noteInteractionExternalId(sourceHash: string, contactId: string) {
  return `${NOTE_INTERACTION_EXTERNAL_ID_PREFIX}${sourceHash}:${contactId}`;
}

export function windowDueDate(anchor: Date, days = DEFAULT_FOLLOW_UP_WINDOW_DAYS) {
  const d = new Date(anchor);
  d.setDate(d.getDate() + days);
  return atLocalNoon(d);
}

export function emptyNoteBatchResult(): NoteBatchResult {
  return {
    participants: [],
    mentions: [],
    unresolvedMentions: [],
    actionItems: [],
    reminders: [],
    skipped: { relative: 0, unverifiable: 0, past: 0, duplicate: 0 },
  };
}

export function normalizeTitle(s: string) {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

export function titlesCollide(a: string, b: string) {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  return Boolean(na) && (na === nb || na.includes(nb) || nb.includes(na));
}

export function withinCollisionWindow(a: Date, b: Date, days = COLLISION_WINDOW_DAYS) {
  return Math.abs(a.getTime() - b.getTime()) <= days * 86_400_000;
}
```

- [ ] **Step 2: Add the idempotent write to `src/lib/contact-writes.ts`**

Extend `LogInteractionInput` with `externalId?: string; noteBatchId?: string;`. In `logInteractionForUser`'s insert add `externalId: input.externalId, noteBatchId: input.noteBatchId,` to `.values({...})`. Then add:

```ts
/**
 * `logInteractionForUser` for note pastes: keyed on `externalId` so a second paste of the
 * same note is a no-op rather than a duplicate timeline row. When the row already exists the
 * side effects (embedding, summary, closeness) are skipped — nothing changed.
 */
export async function logNoteInteractionForUser(
  userId: string,
  input: LogInteractionInput & { externalId: string },
  options?: ContactWriteOptions
): Promise<{ row: Interaction; created: boolean }> {
  const db = await getDb();
  const existing = await db.query.interactions.findFirst({
    where: and(eq(interactions.userId, userId), eq(interactions.externalId, input.externalId)),
  });
  if (existing) return { row: existing, created: false };
  try {
    const row = await logInteractionForUser(userId, input, options);
    return { row, created: true };
  } catch (err) {
    // Lost a race with a concurrent paste of the same note: the unique index fired.
    const message = err instanceof Error ? err.message : String(err);
    if (/interactions_user_external_uidx|duplicate key/i.test(message)) {
      const row = await db.query.interactions.findFirst({
        where: and(eq(interactions.userId, userId), eq(interactions.externalId, input.externalId)),
      });
      if (row) return { row, created: false };
    }
    throw err;
  }
}
```

Import `type Interaction` from `@/db/schema` if not already imported.

- [ ] **Step 3: Typecheck and commit**

```bash
npx tsc --noEmit
git add src/lib/note-batches.ts src/lib/contact-writes.ts
git commit -m "feat(notes): batch helpers and idempotent note interaction write"
```

## Task 5: `saveNoteBatch` + `undoNoteBatchForUser` + smoke

**Files:**
- Create: `src/lib/note-batch-save.ts`
- Create: `scripts/smoke-note-batch.ts`

**Interfaces:**
- Consumes: `createContactForUser`, `updateContactForUser`, `logNoteInteractionForUser` (contact-writes), `buildSuggestionItemHash`, `isoDay`, `isoDayToLocalNoon` (suggested-reminder-utils), `inferReminderActionKind` (reminder-action-kind), `getInboxListId` (reminder-lists), helpers from Task 4, `ParsedNote` (ai.ts), `DatedCommitment` (date-commitment-extract).
- Produces:
  ```ts
  export type NoteBatchParticipantInput = {
    notes: string; parsed: ParsedNote; mergeContactId?: string | null;
    createReminder: boolean; relationshipScore: number; tagNames: string[];
    followUpDays?: number | null; interactionDate?: string | null; interactionType?: string | null;
  };
  export type NoteBatchCommitmentInput = Pick<DatedCommitment, "title" | "description" | "rawDatePhrase" | "yearInferred" | "personName" | "actionKind" | "confidenceScore" | "sourceExcerpt" | "dateBasis" | "anchorIso"> & { dueDateIso: string; contactId?: string | null };
  export type SaveNoteBatchInput = {
    sourceText: string; sourceHash: string; anchorIso: string; anchorBasis: "note" | "hint" | "upload";
    entryPoint: "capture" | "profile"; seedContactId?: string | null;
    participants: NoteBatchParticipantInput[]; commitments: NoteBatchCommitmentInput[];
    skipped: { relative: number; unverifiable: number; past: number };
  };
  export type SaveNoteBatchOutput = { batchId: string; created: number; updated: number; contactIds: string[]; remindersCreated: number; result: NoteBatchResult };
  export async function saveNoteBatch(userId: string, input: SaveNoteBatchInput): Promise<SaveNoteBatchOutput>;
  export async function undoNoteBatchForUser(userId: string, batchId: string): Promise<{ remindersDismissed: number; mentionsRemoved: number }>;
  export async function dismissNoteReminderForUser(userId: string, reminderId: string): Promise<void>;
  ```

- [ ] **Step 1: Write the failing smoke test `scripts/smoke-note-batch.ts`**

```ts
/**
 * The save path behind a confirmed note paste, with no AI: participants become contacts +
 * interactions, dated commitments become reminders immediately, a re-paste creates nothing
 * new, and Undo dismisses without deleting (so the re-paste guard survives it).
 *
 * Writes to the local PGlite file. Stop this worktree's dev server first.
 * Run: npx tsx scripts/smoke-note-batch.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke-note-batch";
process.env.CLERK_SECRET_KEY ||= "sk_test_smoke-note-batch";
delete process.env.DATABASE_URL;

import { and, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, interactions, noteBatches, reminders, userSettings } from "../src/db/schema";
import { saveNoteBatch, undoNoteBatchForUser, type SaveNoteBatchInput } from "../src/lib/note-batch-save";
import { hashSourceNote } from "../src/lib/suggested-reminder-utils";
import { ensureUserSettings } from "../src/lib/user-settings";

const USER = "smoke-note-batch-user";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function reset() {
  const db = await getDb();
  await db.delete(reminders).where(eq(reminders.userId, USER));
  await db.delete(noteBatches).where(eq(noteBatches.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER)); // cascades interactions, mentions, action items
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await ensureUserSettings(USER);
}

const NOTE = `Coffee with Sarah Chen (Stripe, PM). Kickoff is Sept 20. She'll intro me to Raj in two weeks.
Also met Dev Patel — wants the deck soon.`;

function parsed(name: string, company: string | null, actionItems: string[], followUpDays: number | null) {
  return {
    name, company, role: null, location: null, email: null, linkedin_url: null, met_at: null,
    topics: ["fundraising"], action_items: actionItems,
    follow_up_recommendation: followUpDays ? `Follow up with ${name}` : null, follow_up_days: followUpDays,
    relationship_score_suggestion: 3, tags: [], summary: `Chat with ${name}`, key_facts: [], opportunities: [],
    shared_interests: [], suggested_next_message: null, confidence: 0.9, interaction_date: "2026-09-01",
    low_confidence_fields: [],
  };
}

function input(): SaveNoteBatchInput {
  return {
    sourceText: NOTE,
    sourceHash: hashSourceNote(NOTE),
    anchorIso: "2026-09-01",
    anchorBasis: "note",
    entryPoint: "capture",
    participants: [
      { notes: NOTE, parsed: parsed("Sarah Chen", "Stripe", ["Send Sarah the deck"], 14), createReminder: true, relationshipScore: 3, tagNames: [] },
      { notes: NOTE, parsed: parsed("Dev Patel", null, [], 7), createReminder: true, relationshipScore: 2, tagNames: [] },
    ],
    commitments: [
      { title: "Kickoff", description: null, rawDatePhrase: "Sept 20", dueDateIso: "2026-09-20", yearInferred: true, personName: "Sarah Chen", actionKind: "meet", confidenceScore: 90, sourceExcerpt: "Kickoff is Sept 20.", dateBasis: "absolute", anchorIso: "2026-09-01" },
      { title: "Intro to Raj", description: null, rawDatePhrase: "in two weeks", dueDateIso: "2026-09-15", yearInferred: false, personName: "Sarah Chen", actionKind: "follow_up", confidenceScore: 80, sourceExcerpt: "She'll intro me to Raj in two weeks.", dateBasis: "relative", anchorIso: "2026-09-01" },
    ],
    skipped: { relative: 0, unverifiable: 0, past: 0 },
  };
}

async function main() {
  await reset();
  const db = await getDb();

  // 1. First save: two contacts, two interactions, reminders auto-created.
  const first = await saveNoteBatch(USER, input());
  check("two contacts created", first.created === 2 && first.updated === 0, JSON.stringify({ c: first.created, u: first.updated }));
  const rows = await db.query.interactions.findMany({ where: eq(interactions.userId, USER) });
  check("two interactions", rows.length === 2, String(rows.length));
  check("interactions dated from the note", rows.every((r) => new Date(r.interactionDate).getMonth() === 8 && new Date(r.interactionDate).getDate() === 1));
  check("interactions carry the batch id", rows.every((r) => r.noteBatchId === first.batchId));
  check("externalId is notes:<hash>:<contactId>", rows.every((r) => r.externalId?.startsWith(`notes:${hashSourceNote(NOTE)}:`)));

  const rems = await db.query.reminders.findMany({ where: and(eq(reminders.userId, USER), eq(reminders.status, "pending")) });
  const titles = rems.map((r) => r.title).sort();
  // Sarah: Kickoff (absolute) + Intro to Raj (relative). Dev: no commitments → fallback "Follow up with Dev Patel".
  // Sarah's fallback follow-up is suppressed because she already has reminders from the note.
  check("three pending reminders", rems.length === 3, titles.join(" | "));
  check("  Sarah has no generic follow-up", !titles.includes("Follow up with Sarah Chen"), titles.join(" | "));
  check("  Dev got the fallback follow-up", titles.includes("Follow up with Dev Patel"));
  const kickoff = rems.find((r) => r.title === "Kickoff")!;
  check("  provenance recorded", kickoff.noteBatchId === first.batchId && kickoff.rawDatePhrase === "Sept 20" && kickoff.dateBasis === "absolute" && Boolean(kickoff.itemHash) && Boolean(kickoff.sourceInteractionId));
  check("  reminderType extracted_date for dated", kickoff.reminderType === "extracted_date");
  const sarahId = first.contactIds[0];
  check("  linked to Sarah", kickoff.contactId === sarahId);
  check("  due at local noon", new Date(kickoff.dueDate!).getHours() === 12);
  check("result snapshot lists reminders", first.result.reminders.length === 3 && first.result.participants.length === 2);
  const touched = await db.query.contacts.findMany({ where: eq(contacts.userId, USER) });
  check("touched contacts stamped embeddingStaleAt (no inline embedding call)", touched.every((c) => c.embeddingStaleAt !== null));

  const batch = await db.query.noteBatches.findFirst({ where: eq(noteBatches.id, first.batchId) });
  check("batch row saved", batch?.status === "saved" && batch.anchorBasis === "note");

  // 2. Re-paste with merge into the existing contacts: nothing new is created.
  const again = input();
  again.participants[0].mergeContactId = first.contactIds[0];
  again.participants[1].mergeContactId = first.contactIds[1];
  const second = await saveNoteBatch(USER, again);
  const rows2 = await db.query.interactions.findMany({ where: eq(interactions.userId, USER) });
  const rems2 = await db.query.reminders.findMany({ where: eq(reminders.userId, USER) });
  check("re-paste: still two interactions", rows2.length === 2, String(rows2.length));
  check("re-paste: still three reminders", rems2.length === 3, String(rems2.length));
  check("re-paste: reported as duplicates", second.result.skipped.duplicate === 2 && second.result.participants.every((p) => p.duplicate), JSON.stringify(second.result.skipped));
  check("re-paste: updated, not created", second.updated === 2 && second.created === 0);

  // 3. Undo the first batch: reminders dismissed (not deleted), interactions untouched.
  const undo = await undoNoteBatchForUser(USER, first.batchId);
  check("undo dismissed three reminders", undo.remindersDismissed === 3, String(undo.remindersDismissed));
  const afterUndo = await db.query.reminders.findMany({ where: eq(reminders.userId, USER) });
  check("  rows still exist", afterUndo.length === 3);
  check("  all dismissed", afterUndo.every((r) => r.status === "dismissed"));
  check("  interactions survive", (await db.query.interactions.findMany({ where: eq(interactions.userId, USER) })).length === 2);
  const undone = await db.query.noteBatches.findFirst({ where: eq(noteBatches.id, first.batchId) });
  check("  batch marked undone", undone?.status === "undone" && undone.undoneAt !== null);

  // 4. Paste a third time after undo: the dismissed rows block re-creation.
  const third = await saveNoteBatch(USER, again);
  const rems3 = await db.query.reminders.findMany({ where: eq(reminders.userId, USER) });
  check("post-undo re-paste creates no reminders", rems3.length === 3 && third.remindersCreated === 0, String(rems3.length));

  // 5. Undo of another user's batch is refused.
  let refused = false;
  try { await undoNoteBatchForUser("someone-else", first.batchId); } catch { refused = true; }
  check("undo is user-scoped", refused);

  await reset();
  console.log("\nsmoke-note-batch: all checks passed");
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx scripts/smoke-note-batch.ts`
Expected: `Cannot find module '../src/lib/note-batch-save'`.

- [ ] **Step 3: Implement `src/lib/note-batch-save.ts`**

```ts
/**
 * Everything a confirmed note paste writes, in one place and with no auth dependency, so
 * `scripts/smoke-note-batch.ts` can drive it against PGlite. `src/actions/capture.ts` is a
 * thin `"use server"` wrapper.
 *
 * Idempotency, per row type:
 *   interactions  — `externalId = notes:<sourceHash>:<contactId>` (unique per user)
 *   reminders     — `itemHash = sha256(sourceHash|dueIso|title)` (unique per user, NULLs allowed)
 *   undo          — marks reminders `dismissed`, never deletes, so the hash keeps blocking
 */
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts, interactionMentions, noteBatches, reminders, type NoteBatchResult, type ReminderActionKind } from "@/db/schema";
import type { ParsedNote } from "@/lib/ai";
import type { DatedCommitment } from "@/lib/date-commitment-extract";
import {
  createContactForUser,
  logNoteInteractionForUser,
  updateContactForUser,
} from "@/lib/contact-writes";
import {
  DEFAULT_FOLLOW_UP_WINDOW_DAYS,
  emptyNoteBatchResult,
  noteInteractionExternalId,
  titlesCollide,
  windowDueDate,
  withinCollisionWindow,
} from "@/lib/note-batches";
import { getInboxListId } from "@/lib/reminder-lists";
import { inferReminderActionKind } from "@/lib/reminder-action-kind";
import { buildSuggestionItemHash, isoDay, isoDayToLocalNoon } from "@/lib/suggested-reminder-utils";

export type NoteBatchParticipantInput = {
  notes: string;
  parsed: ParsedNote;
  mergeContactId?: string | null;
  createReminder: boolean;
  relationshipScore: number;
  tagNames: string[];
  followUpDays?: number | null;
  interactionDate?: string | null;
  interactionType?: string | null;
};

export type NoteBatchCommitmentInput = Pick<
  DatedCommitment,
  "title" | "description" | "rawDatePhrase" | "yearInferred" | "personName" | "actionKind" | "confidenceScore" | "sourceExcerpt" | "dateBasis" | "anchorIso"
> & { dueDateIso: string; contactId?: string | null };

export type SaveNoteBatchInput = {
  sourceText: string;
  sourceHash: string;
  anchorIso: string;
  anchorBasis: "note" | "hint" | "upload";
  entryPoint: "capture" | "profile";
  seedContactId?: string | null;
  participants: NoteBatchParticipantInput[];
  commitments: NoteBatchCommitmentInput[];
  skipped: { relative: number; unverifiable: number; past: number };
};

export type SaveNoteBatchOutput = {
  batchId: string;
  created: number;
  updated: number;
  contactIds: string[];
  remindersCreated: number;
  result: NoteBatchResult;
};

/**
 * No `after()`, no embedding API call, no summary regeneration from inside this module:
 * `after()` throws outside a request scope and the embedding call needs a live key, and this
 * runs from smoke scripts. Touched contacts are stamped `embeddingStaleAt` instead; the
 * server action that wraps this kicks the backfill and the brief regeneration in `after()`.
 */
const WRITE_OPTS = { skipRevalidate: true, skipEmbedding: true, skipSummary: true } as const;

function namesMatch(a: string | null | undefined, b: string | null | undefined) {
  return Boolean(a && b) && a!.trim().toLowerCase() === b!.trim().toLowerCase();
}

type ReminderDraft = {
  contactId: string | null;
  sourceInteractionId: string | null;
  title: string;
  description: string | null;
  dueDate: Date;
  reminderType: "extracted_date" | "ai_suggested";
  actionKind: ReminderActionKind;
  dateBasis: NoteBatchResult["reminders"][number]["dateBasis"];
  rawDatePhrase: string | null;
  sourceExcerpt: string | null;
};

export async function saveNoteBatch(userId: string, input: SaveNoteBatchInput): Promise<SaveNoteBatchOutput> {
  if (!input.participants.length && !input.commitments.length) {
    throw new Error("Nothing to save");
  }
  const db = await getDb();
  const result = emptyNoteBatchResult();
  result.skipped = { ...input.skipped, duplicate: 0 };
  const anchor = isoDayToLocalNoon(input.anchorIso);
  const [batch] = await db
    .insert(noteBatches)
    .values({
      userId,
      sourceHash: input.sourceHash,
      sourceText: input.sourceText,
      entryPoint: input.entryPoint,
      seedContactId: input.seedContactId ?? null,
      anchorDate: anchor,
      anchorBasis: input.anchorBasis,
      status: "saved",
      result,
    })
    .returning({ id: noteBatches.id });
  const batchId = batch.id;

  let created = 0;
  let updated = 0;
  const contactIds: string[] = [];
  const interactionIdByContact = new Map<string, string>();
  const contactIdByName = new Map<string, string>();

  // 1. Participants → contacts + interactions.
  for (const p of input.participants) {
    const { parsed } = p;
    let contactId = p.mergeContactId || null;
    let wasCreated = false;
    const fields = {
      company: parsed.company || undefined,
      title: parsed.role || undefined,
      location: parsed.location || undefined,
      email: parsed.email || undefined,
      linkedinUrl: parsed.linkedin_url || undefined,
      howMet: parsed.met_at || undefined,
      aiSummary: parsed.summary || undefined,
      keyFacts: parsed.key_facts,
      sharedInterests: parsed.shared_interests,
      opportunities: parsed.opportunities,
      relationshipScore: p.relationshipScore,
      statedCloseness: p.relationshipScore,
      tagNames: p.tagNames,
    };
    if (contactId) {
      // Merge: never overwrite contacts.notes — the new material lives on the timeline.
      await updateContactForUser(userId, contactId, { fullName: parsed.name || undefined, ...fields }, WRITE_OPTS);
      updated += 1;
    } else {
      if (!parsed.name) throw new Error("A name is required to create a contact");
      const row = await createContactForUser(
        userId,
        { fullName: parsed.name, ...fields, source: "ai_capture", notes: p.notes },
        WRITE_OPTS
      );
      contactId = row.id;
      created += 1;
      wasCreated = true;
    }
    contactIds.push(contactId);
    if (parsed.name) contactIdByName.set(parsed.name.trim().toLowerCase(), contactId);

    const interactionDate = p.interactionDate?.trim() || parsed.interaction_date?.trim() || input.anchorIso;
    const { row, created: interactionCreated } = await logNoteInteractionForUser(
      userId,
      {
        contactId,
        rawNotes: p.notes,
        aiSummary: parsed.summary || undefined,
        topics: parsed.topics,
        actionItems: parsed.action_items,
        interactionType: p.interactionType || "meeting_note",
        source: "capture",
        interactionDate,
        externalId: noteInteractionExternalId(input.sourceHash, contactId),
        noteBatchId: batchId,
      },
      WRITE_OPTS
    );
    interactionIdByContact.set(contactId, row.id);
    if (!interactionCreated) result.skipped.duplicate += 1;
    result.participants.push({ contactId, interactionId: row.id, name: parsed.name || "Unnamed", created: wasCreated, duplicate: !interactionCreated });
  }

  // 2. Dated commitments → reminder drafts.
  const drafts: ReminderDraft[] = [];
  for (const c of input.commitments) {
    const contactId = c.contactId ?? (c.personName ? contactIdByName.get(c.personName.trim().toLowerCase()) ?? null : null);
    drafts.push({
      contactId,
      sourceInteractionId: contactId ? interactionIdByContact.get(contactId) ?? null : null,
      title: c.title,
      description: c.description,
      dueDate: isoDayToLocalNoon(c.dueDateIso),
      reminderType: c.dateBasis === "vague" ? "ai_suggested" : "extracted_date",
      actionKind: c.actionKind,
      dateBasis: c.dateBasis,
      rawDatePhrase: c.rawDatePhrase,
      sourceExcerpt: c.sourceExcerpt,
    });
  }

  // 3. Fallback follow-up per participant — only when the note gave them nothing else.
  for (const p of input.participants) {
    if (!p.createReminder || !p.parsed.name) continue;
    const contactId = contactIdByName.get(p.parsed.name.trim().toLowerCase());
    if (!contactId) continue;
    if (drafts.some((d) => d.contactId === contactId)) continue;
    const days = p.followUpDays || p.parsed.follow_up_days || DEFAULT_FOLLOW_UP_WINDOW_DAYS;
    const title = p.parsed.follow_up_recommendation || `Follow up with ${p.parsed.name}`;
    drafts.push({
      contactId,
      sourceInteractionId: interactionIdByContact.get(contactId) ?? null,
      title,
      description: p.parsed.suggested_next_message || null,
      dueDate: windowDueDate(anchor, days),
      reminderType: "ai_suggested",
      actionKind: inferReminderActionKind({ title, description: p.parsed.suggested_next_message, reminderType: "ai_suggested", contactId }),
      dateBasis: "window",
      rawDatePhrase: null,
      sourceExcerpt: null,
    });
  }

  // 4. Collision rule: a dated commitment beats a window reminder with the same title
  //    within 3 days for the same person.
  const kept = drafts.filter((d) => {
    if (d.dateBasis !== "window") return true;
    return !drafts.some(
      (other) => other !== d && other.dateBasis !== "window" && other.contactId === d.contactId &&
        titlesCollide(other.title, d.title) && withinCollisionWindow(other.dueDate, d.dueDate)
    );
  });

  // 5. Insert reminders, idempotent through itemHash.
  let remindersCreated = 0;
  if (kept.length) {
    const listId = await getInboxListId(userId);
    const inserted = await db
      .insert(reminders)
      .values(
        kept.map((d) => ({
          userId,
          contactId: d.contactId,
          listId,
          title: d.title,
          description: d.description,
          dueDate: d.dueDate,
          status: "pending",
          reminderType: d.reminderType,
          actionKind: d.actionKind,
          createdBy: "ai",
          noteBatchId: batchId,
          sourceInteractionId: d.sourceInteractionId,
          sourceExcerpt: d.sourceExcerpt,
          rawDatePhrase: d.rawDatePhrase,
          dateBasis: d.dateBasis,
          itemHash: buildSuggestionItemHash(input.sourceHash, isoDay(d.dueDate), d.title),
        }))
      )
      .onConflictDoNothing({ target: [reminders.userId, reminders.itemHash] })
      .returning();
    remindersCreated = inserted.length;
    for (const r of inserted) {
      result.reminders.push({
        id: r.id, contactId: r.contactId, title: r.title, dueIso: isoDay(new Date(r.dueDate!)),
        dateBasis: (r.dateBasis ?? "window") as NoteBatchResult["reminders"][number]["dateBasis"],
        rawDatePhrase: r.rawDatePhrase, sourceExcerpt: r.sourceExcerpt,
      });
    }
  }

  if (contactIds.length) {
    await db.update(contacts).set({ embeddingStaleAt: new Date() }).where(and(eq(contacts.userId, userId), inArray(contacts.id, contactIds)));
  }
  await db.update(noteBatches).set({ result }).where(eq(noteBatches.id, batchId));
  return { batchId, created, updated, contactIds, remindersCreated, result };
}

export async function undoNoteBatchForUser(userId: string, batchId: string) {
  const db = await getDb();
  const batch = await db.query.noteBatches.findFirst({
    where: and(eq(noteBatches.id, batchId), eq(noteBatches.userId, userId)),
  });
  if (!batch) throw new Error("Batch not found");
  if (batch.status === "undone") return { remindersDismissed: 0, mentionsRemoved: 0 };

  const dismissed = await db
    .update(reminders)
    .set({ status: "dismissed" })
    .where(and(eq(reminders.userId, userId), eq(reminders.noteBatchId, batchId), eq(reminders.status, "pending")))
    .returning({ id: reminders.id });

  const interactionIds = batch.result.participants.map((p) => p.interactionId).filter((id): id is string => Boolean(id));
  let mentionsRemoved = 0;
  if (interactionIds.length) {
    const removed = await db
      .delete(interactionMentions)
      .where(and(eq(interactionMentions.userId, userId), inArray(interactionMentions.interactionId, interactionIds)))
      .returning({ id: interactionMentions.id });
    mentionsRemoved = removed.length;
  }

  await db.update(noteBatches).set({ status: "undone", undoneAt: new Date() }).where(eq(noteBatches.id, batchId));
  return { remindersDismissed: dismissed.length, mentionsRemoved };
}

export async function dismissNoteReminderForUser(userId: string, reminderId: string) {
  const db = await getDb();
  await db
    .update(reminders)
    .set({ status: "dismissed" })
    .where(and(eq(reminders.id, reminderId), eq(reminders.userId, userId), eq(reminders.status, "pending")));
}
```

`createContactForUser`'s `ContactInput` needs `source`, `relationshipScore`, and `statedCloseness` — confirm they exist on the type (`grep -n "source?\|relationshipScore?\|statedCloseness?" src/lib/contact-writes.ts`); the current `confirmCapture` passes all three through `createContact`, so they do.

- [ ] **Step 4: Run the smoke test until it passes**

Run: `npx tsx scripts/smoke-note-batch.ts`
Expected: all `ok`, then `smoke-note-batch: all checks passed`. Common failures: `getInboxListId` needs `ensureReminderLists` first — check `src/lib/reminder-lists.ts:16` and call `ensureReminderLists(userId)` before `getInboxListId` if it does not self-heal; `createContactForUser` may need `ensureUserSettings` for entitlements (the smoke's `reset` does this).

- [ ] **Step 5: Commit**

```bash
npx tsc --noEmit
git add src/lib/note-batch-save.ts scripts/smoke-note-batch.ts
git commit -m "feat(notes): saveNoteBatch — auto-create reminders with provenance, idempotent re-paste, undo"
```

## Task 6: Wire the action, retire staging, add batch actions, audit `dismissed`

**Files:**
- Modify: `src/actions/capture.ts` (`confirmBulkCapture` at ~310 and `confirmCapture` at ~427)
- Create: `src/actions/note-batches.ts`
- Modify: `src/lib/reminders.ts:149-170` (`listReminders` status filter)
- Modify: `src/actions/reminders.ts:687` region (`listNotificationPanel` already filters `pending`; verify)

**Interfaces:**
- Produces:
  ```ts
  // src/actions/capture.ts
  export async function confirmBulkCapture(items: NoteBatchParticipantInput[], batch: { sourceHash: string; sourceText: string; anchorIso: string; anchorBasis: "note"|"hint"|"upload"; entryPoint?: "capture"|"profile"; seedContactId?: string | null; commitments: NoteBatchCommitmentInput[]; skipped: RejectedCounts }): Promise<SaveNoteBatchOutput>;
  // src/actions/note-batches.ts
  export async function getNoteBatch(batchId: string): Promise<(NoteBatch & { reminderStatus: Record<string, string>; contactNames: Record<string, string> }) | null>;
  export async function undoNoteBatch(batchId: string): Promise<{ remindersDismissed: number; mentionsRemoved: number }>;
  export async function dismissNoteReminder(reminderId: string): Promise<void>;
  ```

- [ ] **Step 1: Replace `confirmBulkCapture` and delete `confirmCapture`**

`confirmCapture` has no callers outside this file. Replace both with:

```ts
export async function confirmBulkCapture(
  items: NoteBatchParticipantInput[],
  batch: {
    sourceHash: string;
    sourceText: string;
    anchorIso: string;
    anchorBasis: "note" | "hint" | "upload";
    entryPoint?: "capture" | "profile";
    seedContactId?: string | null;
    commitments: NoteBatchCommitmentInput[];
    skipped: RejectedCounts;
  }
) {
  const userId = await requireUserId();
  // The hash is recomputed server-side: the client echoes sourceText, and a forged hash
  // could collide with (or evade) another note's dedupe keys.
  const sourceHash = hashSourceNote(batch.sourceText);
  if (sourceHash !== batch.sourceHash) throw new Error("Note text changed since parsing; re-run extraction");

  const out = await saveNoteBatch(userId, {
    sourceText: batch.sourceText,
    sourceHash,
    anchorIso: batch.anchorIso,
    anchorBasis: batch.anchorBasis,
    entryPoint: batch.entryPoint ?? "capture",
    seedContactId: batch.seedContactId ?? null,
    participants: items,
    commitments: batch.commitments,
    skipped: batch.skipped,
  });

  // The lib skipped embeddings and summaries (it must run outside a request scope for the
  // smoke suite); this is the request scope, so schedule them here.
  after(async () => {
    await kickEmbeddingBackfill(userId).catch(() => null);
    for (const id of out.contactIds) {
      await generateAndStorePersonSummary(userId, id).catch(() => null);
    }
  });

  revalidatePath("/");
  revalidatePath("/dashboard");
  revalidatePath("/contacts");
  revalidatePath("/capture");
  revalidatePath("/reminders");
  revalidatePath("/graph");
  for (const id of out.contactIds) revalidatePath(`/contacts/${id}`);
  return out;
}
```

Import `saveNoteBatch, type NoteBatchParticipantInput, type NoteBatchCommitmentInput` from `@/lib/note-batch-save`, `after` from `next/server`, `kickEmbeddingBackfill` from `@/lib/embedding-backfill`, and `generateAndStorePersonSummary` from `@/lib/person-summary` (Task 13 renames it via sed). Remove the now-unused imports (`suggestedReminders`, `reminders`, `buildSuggestionItemHash`, `isoDayToLocalNoon`, `createContact`, `updateContact`, `logInteraction`, `randomUUID`) and the `SuggestedReminderSubmission` type. In `parseBulkCaptureNotes` return `sourceText: corpus` alongside `sourceHash` (the client echoes both) and drop `captureBatchId` (the batch id is now minted on save). Re-export the two input types from the action file is not allowed (`"use server"`), so the panel imports them from `@/lib/note-batch-save`.

- [ ] **Step 2: Create `src/actions/note-batches.ts`**

```ts
"use server";

import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { contacts, noteBatches, reminders } from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import { dismissNoteReminderForUser, undoNoteBatchForUser } from "@/lib/note-batch-save";
import { revalidateReminderPaths } from "@/lib/reminder-paths";

export async function getNoteBatch(batchId: string) {
  const userId = await requireUserId();
  const db = await getDb();
  const batch = await db.query.noteBatches.findFirst({
    where: and(eq(noteBatches.id, batchId), eq(noteBatches.userId, userId)),
  });
  if (!batch) return null;

  const reminderIds = batch.result.reminders.map((r) => r.id);
  const contactIds = [
    ...new Set([
      ...batch.result.participants.map((p) => p.contactId),
      ...batch.result.mentions.map((m) => m.contactId),
      ...batch.result.reminders.map((r) => r.contactId).filter((id): id is string => Boolean(id)),
    ]),
  ];
  const [reminderRows, contactRows] = await Promise.all([
    reminderIds.length
      ? db.select({ id: reminders.id, status: reminders.status }).from(reminders).where(and(eq(reminders.userId, userId), inArray(reminders.id, reminderIds)))
      : Promise.resolve([]),
    contactIds.length
      ? db.select({ id: contacts.id, fullName: contacts.fullName }).from(contacts).where(and(eq(contacts.userId, userId), inArray(contacts.id, contactIds)))
      : Promise.resolve([]),
  ]);
  return {
    ...batch,
    reminderStatus: Object.fromEntries(reminderRows.map((r) => [r.id, r.status])),
    contactNames: Object.fromEntries(contactRows.map((c) => [c.id, c.fullName])),
  };
}

export async function undoNoteBatch(batchId: string) {
  const userId = await requireUserId();
  const out = await undoNoteBatchForUser(userId, batchId);
  revalidateReminderPaths();
  revalidatePath(`/capture/${batchId}`);
  revalidatePath("/contacts");
  return out;
}

export async function dismissNoteReminder(reminderId: string) {
  const userId = await requireUserId();
  await dismissNoteReminderForUser(userId, reminderId);
  revalidateReminderPaths();
}
```

Read `node_modules/next/dist/docs/01-app/03-api-reference/01-directives/use-server.md` before writing this file.

- [ ] **Step 3: Audit reminder queries for the `dismissed` status**

`grep -n "status" src/lib/reminders.ts src/actions/reminders.ts src/lib/calendar-feed.ts src/lib/extension/*.ts src/lib/admin-user-detail.ts`. Every read must either filter `status = 'pending'` explicitly or exclude `dismissed`. Known spot: `listReminders` in `src/lib/reminders.ts` around line 165 handles `"all"` by returning every row — change the filter so `"all"` means `r.status !== "dismissed"`. Confirm `listNotificationPanel` (`src/actions/reminders.ts:702`) and the ICS feed (`src/lib/calendar-feed.ts`) already use `eq(reminders.status, "pending")`; leave them. Record each file you checked in the commit message body.

- [ ] **Step 4: Typecheck, run the two smoke scripts, commit**

```bash
npx tsc --noEmit
npx tsx scripts/smoke-note-batch.ts
git add src/actions/capture.ts src/actions/note-batches.ts src/lib/reminders.ts
git commit -m "feat(notes): confirmBulkCapture writes through saveNoteBatch; batch undo/dismiss actions; dismissed status excluded from lists"
```

`tsc` will now fail in `src/components/chat/bulk-notes-panel.tsx` (the confirm payload changed). That is expected and fixed in Task 7; commit anyway so the panel change is its own reviewable diff, or fold Tasks 6 and 7 into one commit if the reviewer prefers a green tree at every commit.

## Task 7: Results page, panel routing, "From notes" chip

**Files:**
- Create: `src/app/(app)/(main)/capture/[batchId]/page.tsx`
- Create: `src/components/capture/note-batch-result.tsx`
- Modify: `src/components/chat/bulk-notes-panel.tsx` (state ~114-125, `saveAccepted` ~211-270, parse handler ~418-470, `SuggestionReviewItem` usage in the done step ~700)
- Modify: `src/components/capture/capture-form.tsx:138-150` (`onSaved`)
- Modify: `src/components/reminders/reminder-card.tsx:30-46, 85-110` (chip link)
- Modify: `src/components/reminders/reminders-view.tsx`, `src/components/dashboard/reminders-dashboard-card.tsx`, `src/components/dashboard/dashboard-sections.tsx` (pass `noteBatchId` through)

**Interfaces:**
- Consumes: `getNoteBatch`, `undoNoteBatch`, `dismissNoteReminder` (Task 6); `confirmBulkCapture` new signature; `deleteContact` from `@/actions/contacts`.
- Produces: `NoteBatchResultView` client component; `BulkNotesPanel.onSaved` now receives `SaveNoteBatchOutput`; `ReminderCard` accepts `noteBatchId?: string | null`.

- [ ] **Step 1: Read the page convention**

Read `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/page.md` (params are a Promise) and mirror `src/app/(app)/(main)/contacts/[id]/page.tsx`.

- [ ] **Step 2: Create the page**

```tsx
import { notFound } from "next/navigation";
import { getNoteBatch } from "@/actions/note-batches";
import { NoteBatchResultView } from "@/components/capture/note-batch-result";

export default async function NoteBatchPage({ params }: { params: Promise<{ batchId: string }> }) {
  const { batchId } = await params;
  const batch = await getNoteBatch(batchId);
  if (!batch) notFound();
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="font-[family-name:var(--font-display)] text-3xl text-ink">What your notes produced</h1>
        <p className="mt-1 text-muted-foreground">
          Everything below was created from this paste. Dismiss anything that is wrong, or undo the whole batch.
        </p>
      </div>
      <NoteBatchResultView
        batchId={batch.id}
        status={batch.status}
        anchorIso={batch.anchorDate.toISOString().slice(0, 10)}
        anchorBasis={batch.anchorBasis}
        result={batch.result}
        reminderStatus={batch.reminderStatus}
        contactNames={batch.contactNames}
      />
    </div>
  );
}
```

- [ ] **Step 3: Create `NoteBatchResultView`**

```tsx
"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "@/lib/toast";
import { deleteContact } from "@/actions/contacts";
import { dismissNoteReminder, undoNoteBatch } from "@/actions/note-batches";
import type { NoteBatchResult } from "@/lib/note-batches";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const BASIS_LABEL: Record<string, string> = {
  absolute: "date in your notes",
  relative: "counted from",
  vague: "no date given — default 2 weeks from",
  window: "follow-up window from",
};
const ANCHOR_LABEL: Record<string, string> = {
  note: "the date in your notes",
  hint: "the calendar/email date",
  upload: "when you pasted",
};

export function NoteBatchResultView({
  batchId, status, anchorIso, anchorBasis, result, reminderStatus, contactNames,
}: {
  batchId: string;
  status: "saved" | "undone";
  anchorIso: string;
  anchorBasis: "note" | "hint" | "upload";
  result: NoteBatchResult;
  reminderStatus: Record<string, string>;
  contactNames: Record<string, string>;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [local, setLocal] = useState(reminderStatus);
  const undone = status === "undone";

  function dismiss(id: string) {
    start(async () => {
      try {
        await dismissNoteReminder(id);
        setLocal((s) => ({ ...s, [id]: "dismissed" }));
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not dismiss");
      }
    });
  }

  function undo() {
    start(async () => {
      try {
        const out = await undoNoteBatch(batchId);
        toast.success(`Undone: ${out.remindersDismissed} reminders dismissed`);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Undo failed");
      }
    });
  }

  function removeContact(contactId: string) {
    if (!confirm("Delete this contact and its notes?")) return;
    start(async () => {
      try {
        await deleteContact(contactId);
        toast.success("Contact deleted");
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Delete failed");
      }
    });
  }

  const name = (id: string | null) => (id ? contactNames[id] ?? "Unknown" : "No one");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-border/70 bg-muted/30 px-4 py-3 text-sm">
        <span className="text-muted-foreground">
          Relative dates counted from <strong className="text-ink">{anchorIso}</strong> ({ANCHOR_LABEL[anchorBasis]}).
        </span>
        {undone ? (
          <Badge variant="secondary">Undone</Badge>
        ) : (
          <Button variant="outline" size="sm" disabled={pending} onClick={undo}>Undo this batch</Button>
        )}
      </div>

      <Card className="border-border/70 shadow-none">
        <CardHeader><CardTitle>People you spoke to</CardTitle></CardHeader>
        <CardContent>
          <ul className="space-y-2">
            {result.participants.map((p) => (
              <li key={p.contactId} className="flex items-center justify-between gap-2 text-sm">
                <span>
                  <Link href={`/contacts/${p.contactId}`} className="text-primary underline">{p.name}</Link>
                  {p.created && <Badge variant="secondary" className="ml-2 text-[10px]">New</Badge>}
                  {p.duplicate && <Badge variant="secondary" className="ml-2 text-[10px]">Already logged</Badge>}
                </span>
                {p.created && (
                  <Button variant="ghost" size="sm" disabled={pending} onClick={() => removeContact(p.contactId)}>Delete contact</Button>
                )}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {(result.mentions.length > 0 || result.unresolvedMentions.length > 0) && (
        <Card className="border-border/70 shadow-none">
          <CardHeader><CardTitle>People mentioned</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            {result.mentions.map((m) => (
              <p key={`${m.interactionId}-${m.contactId}`}>
                “{m.text}” → <Link href={`/contacts/${m.contactId}`} className="text-primary underline">{name(m.contactId)}</Link>
                <span className="text-muted-foreground"> · {Math.round(m.confidence * 100)}%</span>
              </p>
            ))}
            {result.unresolvedMentions.map((m) => (
              <p key={m.text} className="flex items-center justify-between gap-2">
                <span>“{m.text}”{m.context ? <span className="text-muted-foreground"> — {m.context}</span> : null}</span>
                <Link href={`/contacts/new?name=${encodeURIComponent(m.text)}`} className="text-xs text-primary underline">Add as contact</Link>
              </p>
            ))}
          </CardContent>
        </Card>
      )}

      <Card className="border-border/70 shadow-none">
        <CardHeader><CardTitle>Reminders created</CardTitle></CardHeader>
        <CardContent>
          {result.reminders.length === 0 ? (
            <p className="text-sm text-muted-foreground">No reminders came out of these notes.</p>
          ) : (
            <ul className="space-y-2">
              {result.reminders.map((r) => {
                const st = local[r.id] ?? "pending";
                return (
                  <li key={r.id} className="flex items-start justify-between gap-2 rounded-xl border border-border/60 px-3 py-2 text-sm">
                    <div>
                      <p className={st !== "pending" ? "line-through text-muted-foreground" : ""}>{r.title}</p>
                      <p className="text-xs text-muted-foreground">
                        {r.dueIso} · {name(r.contactId)}
                        {r.dateBasis !== "absolute" && <> · {BASIS_LABEL[r.dateBasis]} {anchorIso}</>}
                        {r.rawDatePhrase && <> · “{r.rawDatePhrase}”</>}
                      </p>
                    </div>
                    {st === "pending" ? (
                      <Button variant="ghost" size="sm" disabled={pending} onClick={() => dismiss(r.id)}>Dismiss</Button>
                    ) : (
                      <Badge variant="secondary" className="text-[10px] capitalize">{st}</Badge>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {(result.skipped.relative + result.skipped.unverifiable + result.skipped.past + result.skipped.duplicate) > 0 && (
            <p className="mt-3 text-xs text-muted-foreground">
              Skipped: {result.skipped.past} already past, {result.skipped.relative} unclear timing, {result.skipped.unverifiable} unverifiable, {result.skipped.duplicate} already logged.
            </p>
          )}
        </CardContent>
      </Card>

      <div className="flex gap-2">
        <Link href="/capture"><Button variant="outline" size="sm">Paste more notes</Button></Link>
        <Link href="/reminders"><Button variant="ghost" size="sm">Open reminders</Button></Link>
      </div>
    </div>
  );
}
```

`/contacts/new?name=` — check whether a create route exists (`ls src/app/\(app\)/\(main\)/contacts/`). If not, link to `/capture?mode=structured` instead and note it in the commit.

- [ ] **Step 4: Update `BulkNotesPanel`**

1. Replace state `captureBatchId` with `sourceText: string | null`, add `anchorIso: string | null` and `anchorBasis: "note"|"hint"|"upload" | null`. In the parse handler set them from `res.sourceText`, `res.anchorIso`, `res.anchorBasis` (all returned by `parseBulkCaptureNotes` after Task 2/6).
2. `saveAccepted`: build the new payload:

```ts
        const res = await confirmBulkCapture(payload, {
          sourceHash: sourceHash!,
          sourceText: sourceText!,
          anchorIso: anchorIso!,
          anchorBasis: anchorBasis ?? "upload",
          entryPoint: "capture",
          commitments: checkedSuggestions.map((s) => ({
            title: s.title,
            description: s.description,
            rawDatePhrase: s.rawDatePhrase,
            dueDateIso: s.dueDateIso,
            yearInferred: s.yearInferred,
            personName: s.personNameOverride ?? s.personName,
            actionKind: s.actionKind,
            confidenceScore: s.confidenceScore,
            sourceExcerpt: s.sourceExcerpt,
            dateBasis: s.dateBasis,
            anchorIso: s.anchorIso,
          })),
          skipped: skipped ?? { relative: 0, unverifiable: 0, past: 0 },
        });
        toast.success(`Saved: ${res.created} created, ${res.updated} updated, ${res.remindersCreated} reminders`);
        if (onSaved) onSaved(res); else { resetToPaste(); router.push(`/capture/${res.batchId}`); }
```

3. `onSaved` prop type becomes `(result: SaveNoteBatchOutput) => void` (import the type from `@/lib/note-batch-save`).
4. In the done step, relabel the suggested reminders section heading to "Reminders that will be created" and change the save button label logic: `${checkedDates} reminders` instead of `dates`. The checkbox semantics stay (unchecked = not created).

- [ ] **Step 5: Route from the capture form and wizard**

`capture-form.tsx` `onSaved`: `router.push(`/capture/${res.batchId}`)`. `wizard-capture.tsx`: keep its current behavior (it advances the wizard) — just update the type if it destructures the result.

- [ ] **Step 6: "From notes" chip**

In `reminder-card.tsx` add prop `noteBatchId?: string | null`. Where the type badge renders (~line 140), when `noteBatchId` is set wrap the badge in `<Link href={`/capture/${noteBatchId}`}>` and force the label `"From notes"`. Thread `noteBatchId: r.noteBatchId` through the three list components named above (each maps DB rows to card props; add the field to their row types).

- [ ] **Step 7: Verify in the browser**

```bash
npx tsc --noEmit && npx eslint src/components/capture src/components/chat/bulk-notes-panel.tsx src/app/\(app\)/\(main\)/capture
```

Then start the worktree preview (per `.claude/launch.json`; port 3001) with a Gemini key in `.env.local`, open `/capture`, paste:

```
Coffee with Sarah Chen (Stripe, PM) on Sept 1. Kickoff is Sept 20. She'll intro me to Raj in two weeks. Send her the deck soon.
```

Accept Sarah, save. Expected: redirect to `/capture/<batchId>` listing Sarah (New), three reminders (Kickoff 2026-09-20 absolute; Intro to Raj 2026-09-15 "counted from 2026-09-01"; Send her the deck 2026-09-15 vague), and Undo working. Then `/reminders` shows "From notes" chips linking back. Screenshot both.

- [ ] **Step 8: Commit**

```bash
git add -A src/app src/components scripts
git commit -m "feat(notes): results page with per-reminder dismiss and batch undo; From-notes chip"
```

**Slice 2 ships here.** Open a PR titled "Auto-create reminders from notes with a results page and undo".

---

# Slice 3 — Participants vs. mentions

## Task 8: `resolveMentions` (pure) + smoke

**Files:**
- Create: `src/lib/mention-resolution.ts`
- Create: `scripts/smoke-mention-resolution.ts`

**Interfaces:**
- Consumes: `buildDuplicateIndex`, `findDuplicateCandidatesIndexed`, `type DuplicateSubject` from `src/lib/duplicates.ts`
- Produces:
  ```ts
  export type MentionCandidate = { name: string; context: string | null; company?: string | null; nearPerson?: string | null };
  export type MentionMatchedBy = "exact_name" | "name_company" | "first_name_unique";
  export type ResolvedMention = { text: string; context: string | null; nearPerson: string | null; contactId: string; confidence: number; matchedBy: MentionMatchedBy };
  export type UnresolvedMention = { text: string; context: string | null; nearPerson: string | null };
  export function resolveMentions(subjects: DuplicateSubject[], mentions: MentionCandidate[], ctx?: { excludeContactIds?: Iterable<string> }): { resolved: ResolvedMention[]; unresolved: UnresolvedMention[] };
  ```

Confidence tiers (a deliberate loosening of the duplicate matcher, which treats a bare full name as 0.60 because it is deciding whether to *merge*; a mention only *links*): name + company 0.90 (`name_company`); exact full name, unique among contacts 0.80 (`exact_name`); single-token first name, unique among contacts' first names 0.70 (`first_name_unique`, company must match when the mention gives one). Ambiguous names are unresolved. Contacts in `excludeContactIds` (the batch's participants) are never mention targets.

- [ ] **Step 1: Write the failing smoke test**

```ts
/**
 * Mention resolution: who "Raj" or "Sarah from Stripe" is, given the user's contacts.
 * Pure — no DB, no AI.
 * Run: npx tsx scripts/smoke-mention-resolution.ts
 */
import { resolveMentions } from "../src/lib/mention-resolution";
import type { DuplicateSubject } from "../src/lib/duplicates";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}
function subject(id: string, fullName: string, company: string | null = null): DuplicateSubject {
  return { id, fullName, company, email: null, linkedinUrl: null, xHandle: null, title: null };
}

const contacts = [
  subject("raj", "Raj Patel", "Acme"),
  subject("sarah-stripe", "Sarah Chen", "Stripe"),
  subject("sarah-other", "Sarah Kim", "Figma"),
  subject("dev", "Dev Patel", null),
  subject("mira", "Mira Okafor", "Stripe"),
];

// 1. Exact unique full name → exact_name.
{
  const { resolved, unresolved } = resolveMentions(contacts, [{ name: "Raj Patel", context: "her cofounder" }]);
  check("exact full name resolves", resolved.length === 1 && resolved[0].contactId === "raj" && resolved[0].matchedBy === "exact_name");
  check("  confidence 0.8", resolved[0].confidence === 0.8);
  check("  nothing unresolved", unresolved.length === 0);
}
// 2. Name + company → name_company at 0.9.
{
  const { resolved } = resolveMentions(contacts, [{ name: "Sarah Chen", context: null, company: "Stripe" }]);
  check("name + company", resolved[0]?.contactId === "sarah-stripe" && resolved[0].matchedBy === "name_company" && resolved[0].confidence === 0.9);
}
// 3. Unique first name → first_name_unique at 0.7.
{
  const { resolved } = resolveMentions(contacts, [{ name: "Mira", context: null }]);
  check("unique first name", resolved[0]?.contactId === "mira" && resolved[0].matchedBy === "first_name_unique" && resolved[0].confidence === 0.7);
}
// 4. Ambiguous first name → unresolved.
{
  const { resolved, unresolved } = resolveMentions(contacts, [{ name: "Sarah", context: "from the panel" }]);
  check("ambiguous first name unresolved", resolved.length === 0 && unresolved.length === 1 && unresolved[0].text === "Sarah");
  check("  context preserved", unresolved[0].context === "from the panel");
}
// 5. Ambiguous first name + company disambiguates.
{
  const { resolved } = resolveMentions(contacts, [{ name: "Sarah", context: null, company: "Figma" }]);
  check("first name + company disambiguates", resolved[0]?.contactId === "sarah-other" && resolved[0].matchedBy === "first_name_unique");
}
// 6. Unknown name → unresolved.
{
  const { resolved, unresolved } = resolveMentions(contacts, [{ name: "Priya Nair", context: null }]);
  check("unknown full name unresolved", resolved.length === 0 && unresolved.length === 1);
}
// 7. Participants are excluded as targets.
{
  const { resolved, unresolved } = resolveMentions(contacts, [{ name: "Raj Patel", context: null }], { excludeContactIds: ["raj"] });
  check("participant excluded", resolved.length === 0 && unresolved.length === 1);
}
// 8. Case/whitespace/punctuation insensitive; duplicates in the input collapse.
{
  const { resolved } = resolveMentions(contacts, [{ name: "  raj PATEL. ", context: null }, { name: "Raj Patel", context: null }]);
  check("normalized + deduped", resolved.length === 1 && resolved[0].contactId === "raj");
}
// 9. Two contacts with the same full name and no company on the mention → unresolved.
{
  const dupes = [...contacts, subject("raj2", "Raj Patel", "Globex")];
  const { resolved, unresolved } = resolveMentions(dupes, [{ name: "Raj Patel", context: null }]);
  check("duplicate full names unresolved without company", resolved.length === 0 && unresolved.length === 1);
  const withCo = resolveMentions(dupes, [{ name: "Raj Patel", context: null, company: "Globex" }]);
  check("  company picks one", withCo.resolved[0]?.contactId === "raj2");
}

console.log("\nsmoke-mention-resolution: all checks passed");
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx scripts/smoke-mention-resolution.ts` → `Cannot find module '../src/lib/mention-resolution'`.

- [ ] **Step 3: Implement**

```ts
/**
 * Resolves people *mentioned* in a note (not spoken to) to existing contacts.
 *
 * Looser than `findDuplicateCandidatesIndexed` on purpose: that decides whether to MERGE
 * two records, where a false positive corrupts data. A mention only LINKS, and a wrong link
 * is one click to remove — so a unique exact name, or a unique first name, is enough.
 * Ambiguity always resolves to "unresolved"; the results view offers those as new contacts.
 */
import {
  buildDuplicateIndex,
  findDuplicateCandidatesIndexed,
  type DuplicateSubject,
} from "@/lib/duplicates";

export type MentionCandidate = { name: string; context: string | null; company?: string | null; nearPerson?: string | null };
export type MentionMatchedBy = "exact_name" | "name_company" | "first_name_unique";
export type ResolvedMention = { text: string; context: string | null; nearPerson: string | null; contactId: string; confidence: number; matchedBy: MentionMatchedBy };
export type UnresolvedMention = { text: string; context: string | null; nearPerson: string | null };

function normalizeName(s: string | null | undefined) {
  return (s || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function normalizeCompany(s: string | null | undefined) {
  return (s || "").trim().toLowerCase();
}

export function resolveMentions(
  subjects: DuplicateSubject[],
  mentions: MentionCandidate[],
  ctx?: { excludeContactIds?: Iterable<string> }
): { resolved: ResolvedMention[]; unresolved: UnresolvedMention[] } {
  const excluded = new Set(ctx?.excludeContactIds ?? []);
  const pool = subjects.filter((s) => !excluded.has(s.id));
  const index = buildDuplicateIndex(pool);
  const byFullName = new Map<string, DuplicateSubject[]>();
  const byFirstName = new Map<string, DuplicateSubject[]>();
  for (const s of pool) {
    const full = normalizeName(s.fullName);
    if (!full) continue;
    byFullName.set(full, [...(byFullName.get(full) ?? []), s]);
    const first = full.split(" ")[0];
    byFirstName.set(first, [...(byFirstName.get(first) ?? []), s]);
  }

  const resolved: ResolvedMention[] = [];
  const unresolved: UnresolvedMention[] = [];
  const seen = new Set<string>();

  for (const m of mentions) {
    const text = m.name.trim();
    const norm = normalizeName(text);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    const company = normalizeCompany(m.company);
    const base = { text, context: m.context ?? null, nearPerson: m.nearPerson ?? null };
    const onlyWithCompany = (list: DuplicateSubject[]) =>
      company ? list.filter((s) => normalizeCompany(s.company) === company) : list;

    // Tier 1: name + company through the duplicate matcher (≥ 0.85 = its own merge bar).
    if (company && norm.includes(" ")) {
      const top = findDuplicateCandidatesIndexed(index, { fullName: text, company: m.company })[0];
      if (top && top.confidence >= 0.85) {
        resolved.push({ ...base, contactId: top.contact.id, confidence: 0.9, matchedBy: "name_company" });
        continue;
      }
    }
    // Tier 2: exact full name, unique (company narrows when given).
    const fullMatches = onlyWithCompany(byFullName.get(norm) ?? []);
    if (fullMatches.length === 1) {
      resolved.push({ ...base, contactId: fullMatches[0].id, confidence: company ? 0.9 : 0.8, matchedBy: company ? "name_company" : "exact_name" });
      continue;
    }
    if (fullMatches.length > 1) { unresolved.push(base); continue; }
    // Tier 3: a single-token mention that is a unique first name.
    if (!norm.includes(" ")) {
      const firstMatches = onlyWithCompany(byFirstName.get(norm) ?? []);
      if (firstMatches.length === 1) {
        resolved.push({ ...base, contactId: firstMatches[0].id, confidence: 0.7, matchedBy: "first_name_unique" });
        continue;
      }
    }
    unresolved.push(base);
  }
  return { resolved, unresolved };
}
```

- [ ] **Step 4: Run until green, commit**

```bash
npx tsx scripts/smoke-mention-resolution.ts && npx tsc --noEmit
git add src/lib/mention-resolution.ts scripts/smoke-mention-resolution.ts
git commit -m "feat(notes): resolve mentioned names to contacts"
```

## Task 9: `role` and `mentions` in the people pass (both prompt paths)

**Files:**
- Modify: `src/lib/ai.ts` (`noteParseSchema` ~59, `multiPersonNoteParseSchema` ~96, `personIdentitySchema` ~120, `multiPersonIdentitySchema` ~127, `PERSON_FIELD_SHAPE` ~846, single-pass prompt ~919-981, identify prompt ~990-1020, two-pass merge ~1090-1140)
- Create: `scripts/smoke-note-parse-schema.ts`

**Interfaces:**
- Produces:
  ```ts
  export type NoteMention = { name: string; context: string | null; near_person: string | null };
  export const noteMentionSchema: z.ZodType<...>;
  // ParsedNote gains: role: "participant" | "mentioned"   (default "participant")
  // ParsedMultiPersonNotes gains: mentions: NoteMention[]  (default [])
  ```

- [ ] **Step 1: Write the failing schema smoke test**

```ts
/**
 * The people-pass zod schemas must accept model output that omits the new fields (older
 * prompts, terse models) and default them, so the capture path never throws on shape.
 * Run: npx tsx scripts/smoke-note-parse-schema.ts
 */
import { multiPersonNoteParseSchema } from "../src/lib/ai";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const minimalPerson = { name: "Sarah Chen", source_excerpt: "Coffee with Sarah." };
{
  const parsed = multiPersonNoteParseSchema.parse({ people: [minimalPerson] });
  check("role defaults to participant", parsed.people[0].role === "participant");
  check("mentions default to []", Array.isArray(parsed.mentions) && parsed.mentions.length === 0);
}
{
  const parsed = multiPersonNoteParseSchema.parse({
    people: [{ ...minimalPerson, role: "mentioned" }],
    mentions: [{ name: "Raj", context: "her cofounder" }, { name: "Mira", context: null, near_person: "Sarah Chen" }],
  });
  check("role mentioned round-trips", parsed.people[0].role === "mentioned");
  check("mentions parsed", parsed.mentions.length === 2 && parsed.mentions[0].near_person === null && parsed.mentions[1].near_person === "Sarah Chen");
}
{
  const parsed = multiPersonNoteParseSchema.parse({ people: [{ ...minimalPerson, role: "bogus" }] });
  check("unknown role falls back to participant", parsed.people[0].role === "participant");
}
console.log("\nsmoke-note-parse-schema: all checks passed");
```

Importing `../src/lib/ai` pulls the provider SDKs but makes no network call; if it throws on a missing env var at import time, set the fake Clerk keys at the top as in the other smokes.

- [ ] **Step 2: Run to verify it fails** — `npx tsx scripts/smoke-note-parse-schema.ts` → `role defaults to participant failed` (property undefined).

- [ ] **Step 3: Implement in `src/lib/ai.ts`**

1. Add near the other coercers:
   ```ts
   const personRole = z
     .string()
     .nullish()
     .transform((v): "participant" | "mentioned" => (v === "mentioned" ? "mentioned" : "participant"));
   export const noteMentionSchema = z.object({
     name: z.string().min(1),
     context: nullStr.optional().transform((v) => v ?? null),
     near_person: nullStr.optional().transform((v) => v ?? null),
   });
   export type NoteMention = z.infer<typeof noteMentionSchema>;
   const mentionList = z.array(noteMentionSchema).nullish().transform((v) => (v ?? []).filter((m) => m.name.trim()));
   ```
2. `noteParseSchema`: add `role: personRole,` after `name`. `multiPersonNoteParseSchema`: add `mentions: mentionList,`. `personIdentitySchema`: add `role: personRole,`. `multiPersonIdentitySchema`: add `mentions: mentionList,`. `personDetailBatchSchema` inherits from `noteParseSchema`.
3. `PERSON_FIELD_SHAPE`: add `"role": "participant"|"mentioned",` as the second line.
4. Single-pass prompt: add `"mentions": [ { "name": string, "context": string|null, "near_person": string|null } ],` to the shape (after `interaction_date`), and these rules after "Create one object per distinct person…":
   ```
   - people[] is for PARTICIPANTS: people the user actually talked with, met, or messaged in these notes. Set role "participant".
   - Anyone only referred to — a cofounder, a boss, "she'll intro me to Raj", a speaker they watched — is a MENTION. Put them in mentions[] with the sentence fragment as context and near_person = the participant whose section mentioned them. Do NOT create a people[] entry for them unless the notes give real profile detail (role, company, contact info); if you do, set role "mentioned".
   ```
5. Identify prompt (two-pass): add `"mentions": [ { "name": string, "context": string|null, "near_person": string|null } ]` to the shape, `"role": "participant"|"mentioned"` to each people entry, and the same two rules. In `parseMultiPersonTwoPass`, carry `role: requested.role` into `merged` (add `role` to the `peopleIds` entries when pushing seed people: `role: "participant"`), and return `mentions: identity.mentions` in both the empty and the final return. In `parseMultiPersonSinglePass` return `mentions: parsed.mentions`.
6. Seed people from hints are always participants.

- [ ] **Step 4: Run, typecheck, commit**

```bash
npx tsx scripts/smoke-note-parse-schema.ts && npx tsc --noEmit
git add src/lib/ai.ts scripts/smoke-note-parse-schema.ts
git commit -m "feat(notes): participant/mention roles in the people pass"
```

## Task 10: Mentions through preview, save, results, and profile

**Files:**
- Modify: `src/actions/capture.ts` (`parseBulkCaptureNotes` people loop + return)
- Modify: `src/lib/note-batch-save.ts` (`SaveNoteBatchInput.mentions`, write step)
- Modify: `src/components/chat/bulk-notes-panel.tsx` (hold + echo mentions; show a "Mentioned" strip on the done step)
- Create: `src/lib/contact-mentions.ts`, `src/components/contacts/contact-mentions-section.tsx`
- Modify: `src/app/(app)/(main)/contacts/[id]/page.tsx`
- Modify: `scripts/smoke-note-batch.ts` (mention assertions)

**Interfaces:**
- Produces:
  ```ts
  // capture.ts preview return
  mentions: Array<{ text: string; context: string | null; nearPerson: string | null; contactId: string | null; confidence: number; matchedBy: MentionMatchedBy | null }>;
  // note-batch-save.ts
  export type NoteBatchMentionInput = { text: string; context: string | null; nearPerson: string | null; contactId: string | null; confidence: number; matchedBy: MentionMatchedBy | "user_pick" | null };
  SaveNoteBatchInput.mentions?: NoteBatchMentionInput[];
  // contact-mentions.ts
  export type ContactMentionRow = { interactionId: string; interactionDate: Date; line: string; otherContactId: string; otherContactName: string; mentionText: string };
  export async function listContactMentions(userId: string, contactId: string): Promise<{ mentionedIn: ContactMentionRow[]; mentions: ContactMentionRow[] }>;
  ```

- [ ] **Step 1: Extend the smoke test first**

In `scripts/smoke-note-batch.ts` add `mentions` to `input()`:

```ts
    mentions: [
      { text: "Raj", context: "she'll intro me to Raj", nearPerson: "Sarah Chen", contactId: null, confidence: 0, matchedBy: null }, // unresolved
    ],
```

and before the first save seed a contact `Mira Okafor` for USER, then add a resolved mention `{ text: "Mira", context: null, nearPerson: "Sarah Chen", contactId: <miraId>, confidence: 0.7, matchedBy: "first_name_unique" }`. After the first save assert:

```ts
  const mentionRows = await db.query.interactionMentions.findMany({ where: eq(interactionMentions.userId, USER) });
  check("one mention link written", mentionRows.length === 1 && mentionRows[0].contactId === miraId && mentionRows[0].matchedBy === "first_name_unique");
  check("  hangs on Sarah's interaction", mentionRows[0].interactionId === rows.find((r) => r.contactId === sarahId)!.id);
  check("unresolved mention recorded in result", first.result.unresolvedMentions.length === 1 && first.result.unresolvedMentions[0].text === "Raj");
```

After undo: `check("undo removed mention links", undo.mentionsRemoved === 1)`. After the re-paste (step 2) assert the count is still 1 (unique index). Import `interactionMentions` from the schema.

- [ ] **Step 2: Run — expect failures on the mention assertions.**

- [ ] **Step 3: Save path**

In `note-batch-save.ts` add the `NoteBatchMentionInput` type, `mentions?: NoteBatchMentionInput[]` on the input, and after the participant loop:

```ts
  // 1b. Mentions → links on the nearest participant's interaction. A dates-only batch has
  //     no interaction to hang them on, so they stay in the result as unresolved.
  const participantIds = new Set(contactIds);
  const firstInteraction = result.participants[0]?.interactionId ?? null;
  const mentionRows: (typeof interactionMentions.$inferInsert)[] = [];
  for (const m of input.mentions ?? []) {
    if (!m.contactId || participantIds.has(m.contactId)) {
      result.unresolvedMentions.push({ text: m.text, context: m.context });
      continue;
    }
    const nearId = m.nearPerson ? contactIdByName.get(m.nearPerson.trim().toLowerCase()) : undefined;
    const interactionId = (nearId && interactionIdByContact.get(nearId)) || firstInteraction;
    if (!interactionId) { result.unresolvedMentions.push({ text: m.text, context: m.context }); continue; }
    mentionRows.push({ userId, interactionId, contactId: m.contactId, mentionText: m.text, confidence: m.confidence, matchedBy: m.matchedBy ?? "user_pick" });
    result.mentions.push({ interactionId, contactId: m.contactId, text: m.text, confidence: m.confidence, matchedBy: m.matchedBy ?? "user_pick" });
  }
  if (mentionRows.length) {
    await db.insert(interactionMentions).values(mentionRows).onConflictDoNothing({ target: [interactionMentions.interactionId, interactionMentions.contactId] });
  }
```

Import `interactionMentions` (already imported for undo) and `type MentionMatchedBy` from `@/lib/mention-resolution`.

- [ ] **Step 4: Preview path in `capture.ts`**

After computing `items`, split roles and resolve:

```ts
    const participants = people.filter((p) => p.presence !== "mentioned");
    const demoted = people.filter((p) => p.presence === "mentioned");
    const candidates: MentionCandidate[] = [
      ...personParse.mentions.map((m) => ({ name: m.name, context: m.context, nearPerson: m.near_person })),
      ...demoted.map((p) => ({ name: p.name!, context: p.summary, company: p.company, nearPerson: null })),
    ];
    const { resolved, unresolved } = resolveMentions(
      existing.map((c) => ({ id: c.id, fullName: c.fullName, email: c.email, linkedinUrl: c.linkedinUrl, xHandle: c.xHandle, company: c.company, title: c.title })),
      candidates,
      { excludeContactIds: items.map((i) => i.suggestedMergeId).filter((id): id is string => Boolean(id)) }
    );
    const mentions = [
      ...resolved.map((m) => ({ text: m.text, context: m.context, nearPerson: m.nearPerson, contactId: m.contactId, confidence: m.confidence, matchedBy: m.matchedBy })),
      ...unresolved.map((m) => ({ text: m.text, context: m.context, nearPerson: m.nearPerson, contactId: null, confidence: 0, matchedBy: null })),
    ];
```

In `confirmBulkCapture` add `mentions?: NoteBatchMentionInput[]` to the `batch` parameter type and pass `mentions: batch.mentions ?? []` into `saveNoteBatch`. Build `items` from `participants` (not `people`), return `mentions`, and change the empty check to `!participants.length && !commitmentResult.commitments.length && !mentions.length`. Import `resolveMentions, type MentionCandidate` from `@/lib/mention-resolution`.

- [ ] **Step 5: Panel**

Add `const [mentions, setMentions] = useState<PreviewMention[]>([])` (type = element of the preview `mentions` array; define it in `src/lib/note-batches.ts` as `export type PreviewMention = {...}` so both sides import it). Set from `res.mentions` after parse; reset in `resetToPaste`; pass `mentions` in the `confirmBulkCapture` batch object. On the done step, above the reminders review, render:

```tsx
{mentions.length > 0 && (
  <div className="rounded-xl border border-border/60 bg-muted/30 p-3 text-xs">
    <p className="mb-1 font-medium">Mentioned, not met</p>
    <ul className="space-y-0.5">
      {mentions.map((m) => (
        <li key={m.text}>
          “{m.text}” {m.contactId ? <>→ linked to an existing contact ({Math.round(m.confidence * 100)}%)</> : <span className="text-muted-foreground">— no match; you can add them after saving</span>}
        </li>
      ))}
    </ul>
  </div>
)}
```

- [ ] **Step 6: Profile "Mentioned in"**

`src/lib/contact-mentions.ts`:

```ts
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts, interactionMentions, interactions } from "@/db/schema";

export type ContactMentionRow = { interactionId: string; interactionDate: Date; line: string; otherContactId: string; otherContactName: string; mentionText: string };

function oneLine(aiSummary: string | null, rawNotes: string | null) {
  const text = (aiSummary || rawNotes || "").trim();
  const line = text.split(/\n/)[0]?.trim() || text;
  return line.length > 140 ? `${line.slice(0, 137)}…` : line;
}

/** Both directions: notes about others that name this contact, and this contact's notes that name others. */
export async function listContactMentions(userId: string, contactId: string) {
  const db = await getDb();
  const mentionedIn = await db
    .select({ interactionId: interactions.id, interactionDate: interactions.interactionDate, aiSummary: interactions.aiSummary, rawNotes: interactions.rawNotes, otherContactId: contacts.id, otherContactName: contacts.fullName, mentionText: interactionMentions.mentionText })
    .from(interactionMentions)
    .innerJoin(interactions, eq(interactions.id, interactionMentions.interactionId))
    .innerJoin(contacts, eq(contacts.id, interactions.contactId))
    .where(and(eq(interactionMentions.userId, userId), eq(interactionMentions.contactId, contactId)))
    .orderBy(desc(interactions.interactionDate))
    .limit(20);
  const mentions = await db
    .select({ interactionId: interactions.id, interactionDate: interactions.interactionDate, aiSummary: interactions.aiSummary, rawNotes: interactions.rawNotes, otherContactId: contacts.id, otherContactName: contacts.fullName, mentionText: interactionMentions.mentionText })
    .from(interactionMentions)
    .innerJoin(interactions, eq(interactions.id, interactionMentions.interactionId))
    .innerJoin(contacts, eq(contacts.id, interactionMentions.contactId))
    .where(and(eq(interactionMentions.userId, userId), eq(interactions.contactId, contactId)))
    .orderBy(desc(interactions.interactionDate))
    .limit(20);
  const shape = (r: (typeof mentionedIn)[number]): ContactMentionRow => ({ interactionId: r.interactionId, interactionDate: r.interactionDate, line: oneLine(r.aiSummary, r.rawNotes), otherContactId: r.otherContactId, otherContactName: r.otherContactName, mentionText: r.mentionText });
  return { mentionedIn: mentionedIn.map(shape), mentions: mentions.map(shape) };
}
```

`src/components/contacts/contact-mentions-section.tsx` (server component, no `"use client"`): a `Card` titled "Mentioned in" with two lists: "In notes about others" (`mentionedIn`: `<date> · in your notes about <Link otherContactName> — <line>`) and "People named in these notes" (`mentions`: `<Link otherContactName> · "<mentionText>" · <date>`). Return `null` when both are empty. Date via `format(new Date(d), "MMM d, yyyy")` from `date-fns`.

Page: start `const mentionsPromise = requireUserId().then((u) => listContactMentions(u, id)).catch(() => ({ mentionedIn: [], mentions: [] }));` with the other eager promises; render `<Suspense fallback={null}><StreamedMentions data={mentionsPromise} /></Suspense>` after `ContactRemindersSection`, where `StreamedMentions` awaits and renders `ContactMentionsSection`.

- [ ] **Step 7: Verify and commit**

```bash
npx tsx scripts/smoke-note-batch.ts && npx tsc --noEmit
```

Browser: paste `Coffee with Sarah Chen (Stripe). She said her cofounder Raj Patel is hiring; she'll intro me to Mira next week.` with contacts Raj Patel and Mira Okafor pre-existing. Expected: one participant card (Sarah), done step lists Raj and Mira as linked mentions, results page shows them, both Raj's and Mira's profiles show "Mentioned in … your notes about Sarah Chen", Sarah's profile lists them under "People named in these notes". Screenshot.

```bash
git add -A src scripts
git commit -m "feat(notes): mentions are linked to contacts and shown on both profiles"
```

**Slice 3 ships here.**

---

# Slice 4 — Action items with completion state

## Task 11: `action-items.ts` (hash, diff, sync, list) + smoke

**Files:**
- Create: `src/lib/action-items.ts`
- Create: `scripts/smoke-action-items.ts`

**Interfaces:**
- Produces:
  ```ts
  export const MAX_ACTION_ITEMS_PER_INTERACTION = 10;
  export function actionItemHash(interactionId: string, text: string): string;                 // sha256(`${interactionId}|${text.trim().toLowerCase()}`)
  export type ExistingActionItem = { id: string; itemHash: string; status: "open" | "done"; reminderId: string | null };
  export function diffActionItems(existing: ExistingActionItem[], incoming: string[]): { insert: { text: string; position: number; itemHash: string }[]; deleteIds: string[] };
  export async function syncActionItems(userId: string, interactionId: string, contactId: string, texts: string[]): Promise<{ inserted: { id: string; text: string }[]; deletedIds: string[] }>;
  export async function listOpenActionItems(userId: string, contactId: string): Promise<{ id: string; text: string; interactionId: string; interactionDate: Date; reminderId: string | null }[]>;
  export async function setActionItemStatusForUser(userId: string, id: string, status: "open" | "done"): Promise<{ contactId: string; reminderId: string | null } | null>;
  ```
  `diffActionItems` never deletes a row that is `done` or has a `reminderId`; it dedupes incoming by hash and caps at `MAX_ACTION_ITEMS_PER_INTERACTION`.

- [ ] **Step 1: Write the failing smoke test**

```ts
/**
 * Action-item sync: the diff rules, and hash parity between TypeScript and the SQL backfill
 * in src/db/index.ts (ADMIN_V2_STATEMENTS). If those two formulas ever disagree, a
 * re-sync duplicates every legacy item.
 * Writes to local PGlite. Stop the worktree dev server first.
 * Run: npx tsx scripts/smoke-action-items.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke-action-items";
process.env.CLERK_SECRET_KEY ||= "sk_test_smoke-action-items";
delete process.env.DATABASE_URL;

import { eq, sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import { actionItems, contacts, interactions, userSettings } from "../src/db/schema";
import { actionItemHash, diffActionItems, listOpenActionItems, setActionItemStatusForUser, syncActionItems } from "../src/lib/action-items";
import { ensureUserSettings } from "../src/lib/user-settings";

const USER = "smoke-action-items-user";
function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

// --- pure ---
{
  const iid = "00000000-0000-0000-0000-000000000001";
  const existing = [
    { id: "a", itemHash: actionItemHash(iid, "Send the deck"), status: "open" as const, reminderId: null },
    { id: "b", itemHash: actionItemHash(iid, "Intro to Raj"), status: "done" as const, reminderId: null },
    { id: "c", itemHash: actionItemHash(iid, "Book follow-up"), status: "open" as const, reminderId: "r1" },
    { id: "d", itemHash: actionItemHash(iid, "Old item"), status: "open" as const, reminderId: null },
  ];
  const hash = (t: string) => actionItemHash(iid, t);
  const d = diffActionItems(existing, ["send the deck", "  Send the deck ", "New thing", ""], hash);
  check("hash is case/whitespace-insensitive", d.insert.length === 1 && d.insert[0].text === "New thing");
  check("unchanged open item kept", !d.deleteIds.includes("a"));
  check("done item never deleted", !d.deleteIds.includes("b"));
  check("item with reminder never deleted", !d.deleteIds.includes("c"));
  check("removed open item deleted", d.deleteIds.includes("d"));
  const capped = diffActionItems([], Array.from({ length: 15 }, (_, i) => `item ${i}`), hash);
  check("capped at 10", capped.insert.length === 10);
  check("positions are 0..n-1", capped.insert.every((x, i) => x.position === i));
}

// --- DB ---
async function main() {
  const db = await getDb();
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await ensureUserSettings(USER);
  const [c] = await db.insert(contacts).values({ userId: USER, fullName: "Sarah Chen" }).returning();
  const [i] = await db.insert(interactions).values({ userId: USER, contactId: c.id, rawNotes: "x", actionItems: ["Send the deck", "  Intro to Raj "] }).returning();

  // Hash parity with the SQL formula used by the backfill.
  const sqlHash = rowsOf<{ h: string }>(await db.execute(sql`select encode(sha256(convert_to(${i.id}::text || '|' || lower(btrim(${"  Intro to Raj "})), 'UTF8')), 'hex') as h`))[0].h;
  check("SQL hash equals TS hash", sqlHash === actionItemHash(i.id, "  Intro to Raj "), `${sqlHash} vs ${actionItemHash(i.id, "  Intro to Raj ")}`);

  // The backfill statement (re-run here) picks up the legacy string[].
  await db.execute(sql`INSERT INTO action_items (user_id, contact_id, interaction_id, text, position, item_hash)
    SELECT i.user_id, i.contact_id, i.id, a.value, a.ordinality - 1,
           encode(sha256(convert_to(i.id::text || '|' || lower(btrim(a.value)), 'UTF8')), 'hex')
    FROM interactions i, jsonb_array_elements_text(COALESCE(i.action_items, '[]'::jsonb)) WITH ORDINALITY a
    WHERE i.id = ${i.id} AND btrim(a.value) <> ''
    ON CONFLICT (user_id, item_hash) DO NOTHING`);
  let rows = await db.query.actionItems.findMany({ where: eq(actionItems.interactionId, i.id) });
  check("backfill created two rows", rows.length === 2, String(rows.length));

  // syncActionItems is idempotent against the backfilled rows and applies the diff.
  const s1 = await syncActionItems(USER, i.id, c.id, ["Send the deck", "Intro to Raj"]);
  check("sync after backfill inserts nothing", s1.inserted.length === 0 && s1.deletedIds.length === 0);
  await setActionItemStatusForUser(USER, rows[0].id, "done");
  const s2 = await syncActionItems(USER, i.id, c.id, ["Intro to Raj", "Ping legal"]);
  rows = await db.query.actionItems.findMany({ where: eq(actionItems.interactionId, i.id) });
  check("sync: new item inserted", s2.inserted.length === 1 && s2.inserted[0].text === "Ping legal");
  check("sync: done row survives even though it left the list", rows.some((r) => r.status === "done"));
  const open = await listOpenActionItems(USER, c.id);
  check("open list excludes done", open.length === 2 && open.every((o) => o.text !== rows.find((r) => r.status === "done")!.text));
  check("status change is user-scoped", (await setActionItemStatusForUser("someone-else", rows[0].id, "open")) === null);

  await db.delete(contacts).where(eq(contacts.userId, USER));
  console.log("\nsmoke-action-items: all checks passed");
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
```

Note: the SQL in this smoke and in `ADMIN_V2_STATEMENTS` (Task 3) must be identical except for the `WHERE i.id = …` clause. Both use `btrim`, which trims spaces only; the TypeScript hasher mirrors that rather than using `String.prototype.trim`.

- [ ] **Step 2: Run — expect module-not-found.**

- [ ] **Step 3: Implement `src/lib/action-items.ts`**

```ts
/**
 * Action items as rows with completion state. `interactions.action_items` (string[]) stays
 * as a write-through denorm for the timeline and the extension; this table is what the
 * profile checklist and reminders link to.
 */
import { createHash } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { actionItems, interactions } from "@/db/schema";

export const MAX_ACTION_ITEMS_PER_INTERACTION = 10;

/** Must equal the SQL in src/db/index.ts ADMIN_V2_STATEMENTS: sha256(id || '|' || lower(btrim(text))). */
export function actionItemHash(interactionId: string, text: string) {
  return createHash("sha256").update(`${interactionId}|${text.replace(/^ +| +$/g, "").toLowerCase()}`).digest("hex");
}

export type ExistingActionItem = { id: string; itemHash: string; status: "open" | "done"; reminderId: string | null };

export function diffActionItems(
  existing: ExistingActionItem[],
  incoming: string[],
  hash: (text: string) => string = (t) => t.trim().toLowerCase()
) {
  const byHash = new Map(existing.map((e) => [e.itemHash, e]));
  const seen = new Set<string>();
  const insert: { text: string; position: number; itemHash: string }[] = [];
  let position = 0;
  for (const raw of incoming) {
    const text = raw.trim();
    if (!text) continue;
    const itemHash = hash(text);
    if (seen.has(itemHash)) continue;
    seen.add(itemHash);
    if (!byHash.has(itemHash)) insert.push({ text, position, itemHash });
    position += 1;
    if (position >= MAX_ACTION_ITEMS_PER_INTERACTION) break;
  }
  const deleteIds = existing
    .filter((e) => !seen.has(e.itemHash) && e.status !== "done" && !e.reminderId)
    .map((e) => e.id);
  return { insert, deleteIds };
}
```

The default hasher exists only so the pure function is usable without an interaction id; `syncActionItems` always passes `(t) => actionItemHash(interactionId, t)`, and so does the smoke.

Then the DB functions:

```ts
export async function syncActionItems(userId: string, interactionId: string, contactId: string, texts: string[]) {
  const db = await getDb();
  const existing = await db
    .select({ id: actionItems.id, itemHash: actionItems.itemHash, status: actionItems.status, reminderId: actionItems.reminderId })
    .from(actionItems)
    .where(and(eq(actionItems.userId, userId), eq(actionItems.interactionId, interactionId)));
  const { insert, deleteIds } = diffActionItems(existing, texts, (t) => actionItemHash(interactionId, t));
  let inserted: { id: string; text: string }[] = [];
  if (insert.length) {
    inserted = await db
      .insert(actionItems)
      .values(insert.map((x) => ({ userId, contactId, interactionId, text: x.text, position: x.position, itemHash: x.itemHash })))
      .onConflictDoNothing({ target: [actionItems.userId, actionItems.itemHash] })
      .returning({ id: actionItems.id, text: actionItems.text });
  }
  if (deleteIds.length) {
    await db.delete(actionItems).where(and(eq(actionItems.userId, userId), inArray(actionItems.id, deleteIds)));
  }
  return { inserted, deletedIds: deleteIds };
}

export async function listOpenActionItems(userId: string, contactId: string) {
  const db = await getDb();
  return db
    .select({ id: actionItems.id, text: actionItems.text, interactionId: actionItems.interactionId, interactionDate: interactions.interactionDate, reminderId: actionItems.reminderId })
    .from(actionItems)
    .innerJoin(interactions, eq(interactions.id, actionItems.interactionId))
    .where(and(eq(actionItems.userId, userId), eq(actionItems.contactId, contactId), eq(actionItems.status, "open")))
    .orderBy(desc(interactions.interactionDate), actionItems.position);
}

export async function setActionItemStatusForUser(userId: string, id: string, status: "open" | "done") {
  const db = await getDb();
  const [row] = await db
    .update(actionItems)
    .set({ status, completedAt: status === "done" ? new Date() : null })
    .where(and(eq(actionItems.id, id), eq(actionItems.userId, userId)))
    .returning({ contactId: actionItems.contactId, reminderId: actionItems.reminderId });
  return row ?? null;
}
```

- [ ] **Step 4: Run until green; commit**

```bash
npx tsx scripts/smoke-action-items.ts && npx tsc --noEmit
git add src/lib/action-items.ts scripts/smoke-action-items.ts
git commit -m "feat(notes): action items as rows with hash-keyed sync"
```

## Task 12: Wire sync, per-item reminders, completion links, checklist

**Files:**
- Modify: `src/lib/contact-writes.ts` (`logInteractionForUser` after the insert)
- Modify: `src/actions/contacts.ts:739-807` (`updateInteraction`)
- Modify: `src/lib/note-batch-save.ts` (per-item window reminders + link)
- Modify: `src/lib/reminders.ts:662` (`completeReminder`)
- Create: `src/actions/action-items.ts`, `src/components/contacts/contact-next-steps.tsx`
- Modify: `src/app/(app)/(main)/contacts/[id]/page.tsx`
- Modify: `scripts/smoke-note-batch.ts`

**Interfaces:**
- Produces: `setActionItemStatus(id, status)` server action; `ContactNextSteps` client component `{ items: OpenActionItem[] }` where `OpenActionItem = { id; text; interactionId; interactionDate: string; reminderId }`.

- [ ] **Step 1: Extend the note-batch smoke**

Sarah's participant input already has `action_items: ["Send Sarah the deck"]`. Change the reminder expectations: `check("four pending reminders", rems.length === 4, …)`, add:

```ts
  const deck = rems.find((r) => r.title === "Send Sarah the deck")!;
  check("action item became a window reminder", Boolean(deck) && deck.dateBasis === "window" && deck.reminderType === "ai_suggested");
  check("  due anchor + 14d", isoDayOf(deck.dueDate!) === "2026-09-15");
  const items = await db.query.actionItems.findMany({ where: eq(actionItems.userId, USER) });
  check("action item row linked to its reminder", items.length === 1 && items[0].reminderId === deck.id);
  check("result lists the action item", first.result.actionItems.length === 1 && first.result.actionItems[0].reminderId === deck.id);
```

(Add a local `isoDayOf` helper or import `isoDay` from suggested-reminder-utils; import `actionItems`.) Update the undo expectation to 4 dismissed and the re-paste expectation to 4. Add a collision case: give Dev an action item `"Book kickoff"` and a commitment `{ title: "Kickoff", personName: "Dev Patel", dueDateIso: "2026-09-16", dateBasis: "absolute", rawDatePhrase: "Sept 16", … }` — expect no window reminder titled "Book kickoff" (titles collide, dates within 3 days), the action item row still exists with `reminderId === null`, and Dev has no fallback follow-up.

- [ ] **Step 2: Run — expect the new checks to fail.**

- [ ] **Step 3: Wire the sync**

`contact-writes.ts` `logInteractionForUser`: after the insert and before the embedding rebuild:

```ts
  if (input.actionItems?.length) {
    const { syncActionItems } = await import("@/lib/action-items");
    await syncActionItems(userId, row.id, input.contactId, input.actionItems);
  }
```

`actions/contacts.ts` `updateInteraction`: after the update, `if (input.actionItems !== undefined) { const { syncActionItems } = await import("@/lib/action-items"); await syncActionItems(userId, interactionId, existing.contactId, input.actionItems); }`.

- [ ] **Step 4: Per-item reminders in `saveNoteBatch`**

`logNoteInteractionForUser` already synced the rows (via `logInteractionForUser`). After each participant's interaction, when `interactionCreated`:

```ts
    if (interactionCreated && parsed.action_items.length) {
      const openItems = await db
        .select({ id: actionItems.id, text: actionItems.text, reminderId: actionItems.reminderId })
        .from(actionItems)
        .where(and(eq(actionItems.userId, userId), eq(actionItems.interactionId, row.id)));
      for (const item of openItems) {
        if (item.reminderId) continue;
        drafts.push({
          contactId, sourceInteractionId: row.id, title: item.text, description: null,
          dueDate: windowDueDate(anchor), reminderType: "ai_suggested",
          actionKind: inferReminderActionKind({ title: item.text, description: null, reminderType: "ai_suggested", contactId }),
          dateBasis: "window", rawDatePhrase: null, sourceExcerpt: null, actionItemId: item.id,
        });
        result.actionItems.push({ id: item.id, contactId, text: item.text, reminderId: null });
      }
    }
```

Move the `drafts` declaration above the participant loop; add `actionItemId: string | null` to `ReminderDraft` (null for the others). In the insert map add `actionItemId: d.actionItemId`. After insert, for each inserted row with `actionItemId`, `await db.update(actionItems).set({ reminderId: r.id }).where(eq(actionItems.id, r.actionItemId))` and patch `result.actionItems` entry's `reminderId`. The existing collision filter already drops window drafts that collide with a dated one; the fallback follow-up rule (`drafts.some(d => d.contactId === contactId)`) now also sees action-item drafts, which is the intended "only when nothing else was created". Import `actionItems` from the schema.

- [ ] **Step 5: Completion links**

`src/lib/reminders.ts` `completeReminder`: after the update, `await db.update(actionItems).set({ status: "done", completedAt: new Date() }).where(and(eq(actionItems.userId, userId), eq(actionItems.reminderId, reminderId)));` (import `actionItems`).

`src/actions/action-items.ts`:

```ts
"use server";

import { revalidatePath } from "next/cache";
import { requireUserId } from "@/lib/auth";
import { setActionItemStatusForUser } from "@/lib/action-items";
import { completeReminder } from "@/lib/reminders";
import { revalidateReminderPaths } from "@/lib/reminder-paths";

export async function setActionItemStatus(id: string, status: "open" | "done") {
  const userId = await requireUserId();
  const row = await setActionItemStatusForUser(userId, id, status);
  if (!row) throw new Error("Action item not found");
  if (status === "done" && row.reminderId) await completeReminder(userId, row.reminderId);
  revalidateReminderPaths(row.contactId);
  revalidatePath(`/contacts/${row.contactId}`);
  return row;
}
```

- [ ] **Step 6: Checklist component + page**

`src/components/contacts/contact-next-steps.tsx` (`"use client"`): props `{ items: OpenActionItem[] }`; renders a list of `Checkbox` rows (from `@/components/ui/checkbox`) with the text, a muted `format(date, "MMM d")`, and, when `reminderId`, a small "reminder set" badge. Checking calls `setActionItemStatus(id, "done")` inside `useTransition`, optimistically hides the row, toasts on error, then `router.refresh()`. Empty state: `Nothing open — everything from your notes is done.`

Page: add `const nextStepsPromise = requireUserId().then((u) => listOpenActionItems(u, id)).catch(() => [])` to the eager promises and render `<ContactNextSteps items={…} />` inside the overview area for now (Task 14 moves it into the brief card). Serialize `interactionDate` to ISO before passing to the client component.

- [ ] **Step 7: Preview count in the panel**

In `bulk-notes-panel.tsx`'s done step, under the accepted list, render `const itemCount = accepted.reduce((n, i) => n + i.parsed.action_items.length, 0)` as `{itemCount} action item{itemCount === 1 ? "" : "s"} will also become reminders due {anchorIso ? format(addDays(new Date(`${anchorIso}T12:00:00`), 14), "MMM d") : "in 2 weeks"}` (skip when zero; `addDays`/`format` from `date-fns`). This is the "will create N reminders" preview the spec asks for.

- [ ] **Step 8: Verify, commit**

```bash
npx tsx scripts/smoke-note-batch.ts && npx tsx scripts/smoke-action-items.ts && npx tsc --noEmit
```

Browser: paste a note with three undated action items for one participant; expect three window reminders on the results page, the profile checklist showing three open items, checking one marks its reminder done on `/reminders`, and completing a reminder there removes its item from the checklist.

```bash
git add -A src scripts
git commit -m "feat(notes): action items sync on every note write, get their own reminders, and show as a checklist"
```

**Slice 4 ships here.**

---

# Slice 5 — Contact brief

## Task 13: `contact-brief.ts` replaces `person-summary.ts` + smoke

**Files:**
- Create: `src/lib/contact-brief.ts`
- Delete: `src/lib/person-summary.ts`
- Modify call sites: `src/lib/contact-writes.ts:703, 782`, `src/actions/contacts.ts:28, 799, 858`, `src/lib/extension/writes.ts:25, 226, 275`
- Create: `scripts/smoke-contact-brief.ts`

**Interfaces:**
- Produces:
  ```ts
  export type RecentDiscussion = { interactionId: string; dateIso: string; line: string };
  export const RECENT_DISCUSSIONS_LIMIT = 5;
  export function buildRecentDiscussions(rows: { id: string; interactionDate: Date | string; interactionType: string; aiSummary: string | null; rawNotes: string | null }[]): RecentDiscussion[];
  export function isBriefStale(brief: { generatedAt: Date | string } | null, lastInteractionAt: Date | string | null): boolean;
  export async function generateAndStoreContactBrief(userId: string, contactId: string, options?: { force?: boolean }): Promise<{ summary: string | null; standing: string | null } | null>;
  export async function getContactBrief(userId: string, contactId: string): Promise<ContactBrief | null>;
  ```
  `generateAndStoreContactBrief` keeps every behavior of `generateAndStorePersonSummary` (same `hasSignal` gate, same profile block, same deterministic fallback for the paragraph, writes `contacts.aiSummary`, rebuilds the embedding) and additionally upserts `contact_briefs`. The `operation` label changes to `"contact.brief"`.

- [ ] **Step 1: Write the failing smoke test**

```ts
/**
 * The contact brief's deterministic parts — recent discussions and staleness — must work
 * with no AI key at all, and the store path must write them even when the model call fails.
 * Writes to local PGlite. Stop the worktree dev server first.
 * Run: npx tsx scripts/smoke-contact-brief.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke-brief";
process.env.CLERK_SECRET_KEY ||= "sk_test_smoke-brief";
delete process.env.DATABASE_URL;
// Force the no-key fallback path: local dev may carry provider keys in .env.local.
delete process.env.GEMINI_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contactBriefs, contacts, interactions, userSettings } from "../src/db/schema";
import { buildRecentDiscussions, generateAndStoreContactBrief, getContactBrief, isBriefStale } from "../src/lib/contact-brief";
import { ensureUserSettings } from "../src/lib/user-settings";

const USER = "smoke-brief-user";
function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

// --- pure ---
{
  const rows = Array.from({ length: 7 }, (_, i) => ({
    id: `i${i}`,
    interactionDate: new Date(2026, 7, 20 - i, 12),
    interactionType: "meeting_note",
    aiSummary: i === 0 ? null : `Summary ${i}. Second sentence that must not appear.`,
    rawNotes: i === 0 ? "Raw first line about the deck\nsecond line" : null,
  }));
  const recent = buildRecentDiscussions(rows);
  check("limited to 5", recent.length === 5);
  check("newest first", recent[0].dateIso === "2026-08-20" && recent[4].dateIso === "2026-08-16");
  check("first sentence of aiSummary", recent[1].line === "Summary 1.");
  check("falls back to first line of rawNotes", recent[0].line === "Raw first line about the deck");
  const empty = buildRecentDiscussions([{ id: "x", interactionDate: new Date(), interactionType: "note", aiSummary: null, rawNotes: "   " }]);
  check("blank interactions dropped", empty.length === 0);
  const long = buildRecentDiscussions([{ id: "x", interactionDate: new Date(), interactionType: "note", aiSummary: null, rawNotes: "a".repeat(300) }]);
  check("line capped at 120 chars", long[0].line.length <= 121);
}
{
  const t0 = new Date(2026, 8, 1, 12);
  const t1 = new Date(2026, 8, 2, 12);
  check("no brief → stale", isBriefStale(null, t0));
  check("brief older than last interaction → stale", isBriefStale({ generatedAt: t0 }, t1));
  check("brief newer → fresh", !isBriefStale({ generatedAt: t1 }, t0));
  check("no interactions → fresh", !isBriefStale({ generatedAt: t0 }, null));
}

// --- DB, no AI key ---
async function main() {
  const db = await getDb();
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await ensureUserSettings(USER);
  const [c] = await db.insert(contacts).values({ userId: USER, fullName: "Sarah Chen", company: "Stripe", title: "PM" }).returning();
  await db.insert(interactions).values([
    { userId: USER, contactId: c.id, interactionType: "meeting_note", interactionDate: new Date(2026, 8, 1, 12), aiSummary: "Talked fundraising and the kickoff." },
    { userId: USER, contactId: c.id, interactionType: "note", interactionDate: new Date(2026, 7, 10, 12), rawNotes: "Met at the summit afterparty." },
  ]);

  const out = await generateAndStoreContactBrief(USER, c.id);
  check("fallback returns a summary", Boolean(out?.summary));
  const brief = await getContactBrief(USER, c.id);
  check("brief row written without AI", brief !== null);
  check("  recent discussions stored", brief!.recentDiscussions.length === 2 && brief!.recentDiscussions[0].line === "Talked fundraising and the kickoff.");
  check("  standing falls back to the paragraph", brief!.standing.length > 0);
  check("  model null on fallback", brief!.model === null);
  const contact = await db.query.contacts.findFirst({ where: eq(contacts.id, c.id) });
  check("contacts.aiSummary still written", Boolean(contact?.aiSummary));

  // Regeneration is an upsert, not a second row.
  await generateAndStoreContactBrief(USER, c.id, { force: true });
  const rows = await db.query.contactBriefs.findMany({ where: eq(contactBriefs.userId, USER) });
  check("upsert keeps one row", rows.length === 1);

  await db.delete(contacts).where(eq(contacts.userId, USER));
  console.log("\nsmoke-contact-brief: all checks passed");
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run — module not found.**

- [ ] **Step 3: Implement `src/lib/contact-brief.ts`**

Start from `git show HEAD:src/lib/person-summary.ts` (keep `buildDeterministicSummary`, the profile block, the `hasSignal` gate). Add:

```ts
export type RecentDiscussion = { interactionId: string; dateIso: string; line: string };
export const RECENT_DISCUSSIONS_LIMIT = 5;

function firstSentence(text: string) {
  const line = text.split(/\n/)[0]?.trim() || text.trim();
  const m = line.match(/^(.+?[.!?])(\s|$)/);
  const s = (m ? m[1] : line).trim();
  return s.length > 120 ? `${s.slice(0, 117)}…` : s;
}

export function buildRecentDiscussions(
  rows: { id: string; interactionDate: Date | string; interactionType: string; aiSummary: string | null; rawNotes: string | null }[]
): RecentDiscussion[] {
  return [...rows]
    .sort((a, b) => new Date(b.interactionDate).getTime() - new Date(a.interactionDate).getTime())
    .map((r) => {
      const text = (r.aiSummary || r.rawNotes || "").trim();
      if (!text) return null;
      return { interactionId: r.id, dateIso: isoDay(new Date(r.interactionDate)), line: firstSentence(text) };
    })
    .filter((x): x is RecentDiscussion => x !== null)
    .slice(0, RECENT_DISCUSSIONS_LIMIT);
}

export function isBriefStale(brief: { generatedAt: Date | string } | null, lastInteractionAt: Date | string | null) {
  if (!brief) return true;
  if (!lastInteractionAt) return false;
  return new Date(brief.generatedAt).getTime() < new Date(lastInteractionAt).getTime();
}

export async function getContactBrief(userId: string, contactId: string) {
  const db = await getDb();
  return (await db.query.contactBriefs.findFirst({ where: and(eq(contactBriefs.contactId, contactId), eq(contactBriefs.userId, userId)) })) ?? null;
}
```

Then `generateAndStoreContactBrief`: same body as the old function up to the AI call, with the schema `z.object({ summary: z.string().min(1), standing: z.string().min(1).max(600) })`, `operation: "contact.brief"`, and the prompt extended with:

```
Return strict JSON: { "summary": string, "standing": string }
summary — 2–4 sentences as before (who, how met, what discussed).
standing — 2–3 sentences on WHERE THINGS STAND RIGHT NOW: the most recent thread, anything the user owes or is waiting on, and the natural next step. Present tense, second person, under 70 words, grounded only in the interactions. If nothing is open, say so plainly.
```

On success `standing = parsed.standing.trim()`, `model = resolveAiModel(...)` from `getAiConfig` (it returns `{ model }`); on failure `standing = summary` (the deterministic paragraph) and `model = null`. After writing `contacts.aiSummary`, upsert:

```ts
  const recentRows = recent.map((i) => ({ id: i.id, interactionDate: i.interactionDate, interactionType: i.interactionType, aiSummary: i.aiSummary, rawNotes: i.rawNotes }));
  await db
    .insert(contactBriefs)
    .values({ contactId, userId, standing, recentDiscussions: buildRecentDiscussions(recentRows), generatedAt: new Date(), basisInteractionId: recent[0]?.id ?? null, model })
    .onConflictDoUpdate({ target: contactBriefs.contactId, set: { standing, recentDiscussions: buildRecentDiscussions(recentRows), generatedAt: new Date(), basisInteractionId: recent[0]?.id ?? null, model } });
```

Return `{ summary, standing }`. Keep the early `return contact.aiSummary` gate but shape it as `{ summary: contact.aiSummary, standing: null }`.

- [ ] **Step 4: Replace call sites and delete the old module**

`sed -i '' 's/generateAndStorePersonSummary/generateAndStoreContactBrief/g; s#@/lib/person-summary#@/lib/contact-brief#g' src/lib/contact-writes.ts src/actions/contacts.ts src/lib/extension/writes.ts`, then `git rm src/lib/person-summary.ts`. In `regenerateContactSummary` (`actions/contacts.ts:856`) return `{ summary: out?.summary ?? null }` to keep its shape for `contact-profile-overview.tsx`.

- [ ] **Step 5: Run, typecheck, commit**

```bash
npx tsx scripts/smoke-contact-brief.ts && npx tsc --noEmit && grep -rn "person-summary" src || echo "no stale imports"
git add -A src scripts
git commit -m "feat(notes): contact brief with standing + deterministic recent discussions replaces person summary"
```

## Task 14: `ContactBriefCard` on the profile

**Files:**
- Create: `src/components/contacts/contact-brief-card.tsx`
- Modify: `src/app/(app)/(main)/contacts/[id]/page.tsx`
- Modify: `src/components/contacts/contact-next-steps.tsx` (export the list body so the card can embed it)

**Interfaces:**
- Consumes: `getContactBrief`, `isBriefStale`, `generateAndStoreContactBrief` (Task 13), `listOpenActionItems` (Task 11), `ContactNextSteps` (Task 12), `regenerateContactSummary`.
- Produces: `ContactBriefCard` props `{ contactId: string; standing: string | null; recentDiscussions: RecentDiscussion[]; nextSteps: OpenActionItem[]; stale: boolean }`.

- [ ] **Step 1: Page data + background regeneration**

Read `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/after.md`. In the page, alongside the other eager promises:

```ts
  const briefPromise = requireUserId().then((u) => getContactBrief(u, id)).catch(() => null);
  const nextStepsPromise = requireUserId().then((u) => listOpenActionItems(u, id)).catch(() => []);
```

After `contact` resolves: `const brief = await briefPromise; const stale = isBriefStale(brief, contact.lastInteractionAt); if (stale) after(() => requireUserId().then((u) => generateAndStoreContactBrief(u, id)).catch(() => null));` — `after` from `next/server`. Render the card between `ContactStatPills` and `ContactProfileOverview`, wrapped in a `reveal-mount` div with `--reveal-delay: 90ms`, passing `standing={brief?.standing ?? null}`, `recentDiscussions={brief?.recentDiscussions ?? []}`, `nextSteps={(await nextStepsPromise).map(serialize)}`, `stale`.

- [ ] **Step 2: The card**

```tsx
"use client";

import Link from "next/link";
import { format } from "date-fns";
import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "@/lib/toast";
import { regenerateContactSummary } from "@/actions/contacts";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ContactNextSteps, type OpenActionItem } from "@/components/contacts/contact-next-steps";
import type { RecentDiscussion } from "@/lib/contact-brief";

export function ContactBriefCard({ contactId, standing, recentDiscussions, nextSteps, stale }: {
  contactId: string; standing: string | null; recentDiscussions: RecentDiscussion[]; nextSteps: OpenActionItem[]; stale: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Card className="border-border/70 shadow-none">
      <CardHeader className="border-b border-border/50">
        <CardTitle>Where things stand</CardTitle>
        <CardAction>
          <Button type="button" variant="ghost" size="sm" className="h-7 gap-1.5 text-xs text-muted-foreground" disabled={pending}
            onClick={() => start(async () => {
              try { await regenerateContactSummary(contactId); router.refresh(); }
              catch (err) { toast.error(err instanceof Error ? err.message : "Could not refresh"); }
            })}>
            <RefreshCw className="size-3.5" /> {stale ? "Updating…" : "Refresh"}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-5 pt-4 lg:grid-cols-[1.2fr_1fr]">
        <div className="space-y-4">
          <p className="text-sm leading-relaxed text-ink">
            {standing ?? "Add notes from a conversation and the brief will appear here."}
          </p>
          {recentDiscussions.length > 0 && (
            <div>
              <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">Recent discussions</p>
              <ul className="space-y-1 text-sm">
                {recentDiscussions.map((d) => (
                  <li key={d.interactionId} className="flex gap-2">
                    <Link href={`#interaction-${d.interactionId}`} className="shrink-0 tabular-nums text-muted-foreground hover:text-primary">
                      {format(new Date(`${d.dateIso}T12:00:00`), "MMM d")}
                    </Link>
                    <span className="text-ink">{d.line}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <div>
          <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">Open next steps</p>
          <ContactNextSteps items={nextSteps} />
        </div>
      </CardContent>
    </Card>
  );
}
```

For the `#interaction-<id>` anchors, add `id={`interaction-${i.id}`}` to each row's wrapper in `contact-timeline.tsx` (the `<li>`/row element rendered per interaction). Remove the temporary `ContactNextSteps` placement from Task 12 Step 6 now that the card owns it.

- [ ] **Step 3: Verify, commit**

`npx tsc --noEmit`, then in the browser open a contact with notes: the card shows standing, up to five dated lines that scroll the timeline into view when clicked, and the checklist; the Refresh button regenerates. Screenshot light and dark (`resize_window` colorScheme).

```bash
git add -A src
git commit -m "feat(notes): 'Where things stand' brief card on the contact profile"
```

**Slice 5 ships here.**

---

# Slice 6 — "Add notes" on the profile

## Task 15: `lockedParticipantId` and `ContactAddNotesCard`

**Files:**
- Modify: `src/components/chat/bulk-notes-panel.tsx` (props ~87-105, parse handler ~418-470, `PersonReviewCard` ~715-900, `saveAccepted`)
- Create: `src/components/contacts/contact-add-notes-card.tsx`
- Modify: `src/app/(app)/(main)/contacts/[id]/page.tsx` (above `ContactTimeline`)

**Interfaces:**
- Produces: `BulkNotesPanel` props `lockedParticipantId?: string | null; lockedParticipantName?: string | null; entryPoint?: "capture" | "profile"`.

- [ ] **Step 1: Panel changes**

1. Add the three props. When `lockedParticipantId` is set:
   - Parse with `hints.seedPeople = [{ name: lockedParticipantName }]` merged into `captureHints` (so the people pass attributes first-person notes to them).
   - In the parse handler, for the item whose `duplicates` includes `lockedParticipantId` OR whose name matches `lockedParticipantName` (case-insensitive) OR, if no item matches and there is exactly one participant, that item: set `mergeContactId: lockedParticipantId` and mark it `locked: true` (add `locked?: boolean` to `ReviewItem`).
   - `PersonReviewCard`: when `item.locked`, replace the "Save as" radio group with a single line `Logging on <lockedParticipantName>'s timeline` and hide the "Create new contact" option.
   - `saveAccepted`: pass `entryPoint: entryPoint ?? "capture"` and `seedContactId: lockedParticipantId ?? null` in the batch object.
2. Default `onSaved` when `entryPoint === "profile"`: `resetToPaste(); router.refresh(); toast.success(<a link to /capture/${res.batchId}>)` — `toast` here is `@/lib/toast`; if it does not support JSX, use `toast.success("Saved — view what was created", { action: { label: "Open", onClick: () => router.push(`/capture/${res.batchId}`) } })` (check the toast helper's signature first: `sed -n 1,40p src/lib/toast.ts`).

- [ ] **Step 2: The card**

```tsx
"use client";

import { useState } from "react";
import { ChevronDown, NotebookPen } from "lucide-react";
import { BulkNotesPanel } from "@/components/chat/bulk-notes-panel";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export function ContactAddNotesCard({ contactId, contactName, hasApiKey }: { contactId: string; contactName: string; hasApiKey: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <Card className="border-border/70 shadow-none">
      <CardHeader className="cursor-pointer" onClick={() => setOpen((o) => !o)}>
        <CardTitle className="flex items-center gap-2 text-base">
          <NotebookPen className="size-4" /> Add notes
          <Button type="button" variant="ghost" size="sm" className="ml-auto h-7 px-2" aria-expanded={open}>
            <ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} />
          </Button>
        </CardTitle>
      </CardHeader>
      {open && (
        <CardContent>
          <p className="mb-3 text-xs text-muted-foreground">
            Paste what you talked about with {contactName}. Dates, action items, and anyone they mentioned are picked up automatically.
          </p>
          <BulkNotesPanel compact lockedParticipantId={contactId} lockedParticipantName={contactName} entryPoint="profile" hasApiKey={hasApiKey} />
        </CardContent>
      )}
    </Card>
  );
}
```

Page: `const settingsPromise = getSettings()` (from `@/actions/settings`, as `capture/page.tsx` does) started eagerly; render `<Reveal><ContactAddNotesCard contactId={contact.id} contactName={displayName} hasApiKey={(await settingsPromise).hasApiKey} /></Reveal>` directly above the `ContactTimeline` `Reveal`.

- [ ] **Step 3: Verify, commit**

Browser: open a contact, expand Add notes, paste `Quick call today. She'll send the term sheet by Friday and wants an intro to Dev Patel.` Expected: one review card locked to this contact (no "Create new contact" radio), save keeps you on the profile, the timeline gains the interaction dated today, reminders for "Send term sheet" (Friday) appear, the mention of Dev Patel links if that contact exists, the brief card refreshes on the next load. Screenshot.

```bash
npx tsc --noEmit && npx eslint src/components/contacts src/components/chat/bulk-notes-panel.tsx
git add -A src
git commit -m "feat(notes): add notes straight from a contact's profile"
```

**Slice 6 ships here.**

---

## Final verification (after all slices)

```bash
npm run db:check
npx tsc --noEmit
for s in relative-date date-commitments note-parse-schema mention-resolution note-batch action-items contact-brief; do npx tsx scripts/smoke-$s.ts || exit 1; done
npx next build
```

Then the end-to-end walk from the spec §10 with the fixture note:

```
Coffee with Sarah Chen (Stripe, PM) and Dev Patel on Sept 1. Kickoff is Sept 20. Sarah will circle back in two weeks about the pilot. Dev said his cofounder Raj Patel is hiring; send Dev the deck soon. Action items: draft the pilot scope, book the kickoff room, ping legal about the DPA.
```

Expected on `/capture/<batchId>`: participants Sarah and Dev (interactions dated 2026-09-01), mention Raj Patel linked (or offered if absent), reminders: Kickoff 09-20 (absolute), circle back 09-15 (relative), "send Dev the deck" 09-15 (vague), three window reminders for the action items (09-15) — "book the kickoff room" is suppressed if titles collide with "Kickoff" within 3 days (they don't: 09-15 vs 09-20 is 5 days; expect it present). Undo dismisses all reminders and removes the Raj link; a re-paste reports duplicates and creates nothing. Each profile shows the brief card, checklist, and "Mentioned in".
