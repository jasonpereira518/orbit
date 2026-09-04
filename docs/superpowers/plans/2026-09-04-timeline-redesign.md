# Timeline Redesign — Design Plan

> **This is a design plan, not a task list.** It settles the visual system, the interaction
> model, and the sequencing. Implementation is expected to follow it slice by slice
> (see "Sequencing"), one PR per slice.

**Goal:** Make the contact Timeline scannable at a glance — every interaction type gets a
color-coded icon — and make it smooth to read, filter, and navigate at the volumes a LinkedIn
import actually produces.

**Architecture:** Color encodes *channel class* via CSS tokens (two reused from `--import-*`,
two new); icon shape and a text label encode the specific type, so the design survives
grayscale and CVD. A pure `src/lib/interaction-meta.ts` becomes the single reconciliation
point for a type vocabulary currently fragmented across two disagreeing lists and a free-text
DB column. The 448px inner scrollbox is removed in favour of page flow plus progressive
disclosure (month → day → row, windowed at 40, dense days collapsed), which requires
overriding the `Card` primitive's `overflow-hidden` with `overflow-clip` so `position: sticky`
works at all.

**Tech Stack:** Next.js 16.2.10 App Router, React 19.2.4, Tailwind v4 (`@theme inline`
tokens), shadcn `base-nova` primitives, lucide-react 1.24.0, `date-fns`. Client component;
mutations stay on the existing server actions in `src/actions/contacts.ts`.

**Scope:** The product-facing contact Timeline only — not the admin console's activity
timeline. The server query is deliberately untouched (see "Deliberately out of scope").

## Global Constraints

- **Next.js differs from training data.** Per `AGENTS.md`, read the relevant guide under
  `node_modules/next/dist/docs/` before relying on any Next API. A fresh worktree has no
  `node_modules` — run `npm ci` *in* the worktree.
- **`"use server"` files export only async functions.** `interaction-meta.ts` and
  `timeline-groups.ts` therefore live in `src/lib/`, never `src/actions/`.
- **No runtime `@/db` import in client-reachable modules** — a *value* import fails the build
  with an opaque `node:fs` chunking error naming neither file. `import type` is erased and
  safe; `src/lib/reminder-action-kind.ts` is the precedent.
- **Every Tailwind class in a lookup map must be a literal string.** Tailwind v4 scans source
  text, so interpolation silently yields unstyled output in production builds only.
- **Baselines:** `npx tsc --noEmit` passes and eslint is clean, so any new error is ours.
- Dates are pinned to local noon (`atLocalNoon`, `src/lib/interaction-date.ts`). Never
  `new Date("YYYY-MM-DD")`.

---

## Context

The contact Timeline (`src/components/contacts/contact-timeline.tsx`, rendered at
`src/app/(app)/(main)/contacts/[id]/page.tsx:289`) is where a user reads the history of a
relationship. It is the component literally titled "Timeline" and the densest list in the
product.

Today **every row looks identical**: no icons, no color, no markers — just a flat
`border-l-2 border-primary/25` rule and a line reading `Mar 4, 2026 · Meeting`. The
interaction type, the most useful signal for scanning ("when did we last actually *meet*,
versus just email?"), is buried as a lowercase word after the date. The list can't be
skimmed; it has to be read.

This change gives every interaction type a color-coded icon and rebuilds the row, grouping,
and navigation around it.

**The data shape is the reason this matters.** LinkedIn message import writes **one
interaction row per message** (`src/lib/import-adapters/linkedin-messages.ts:125-148`,
`interactionType: "linkedin_message"`, `aiSummary = body.slice(0, 240)`). A heavy contact is
hundreds to low-thousands of rows, overwhelmingly one type, clustered into a few dozen days.
The current design renders all of them at once, in a 448px box, each truncated to 160
characters, with the full note reachable only through a modal.

Two real defects surfaced while investigating, both fixed as a consequence:

1. **The type vocabulary is fragmented across two disagreeing lists.** The timeline offers
   `note, meeting, reach_out, in_person, email, linkedin_message, call`
   (`contact-timeline.tsx:67`). Capture offers a *different* set including `message`,
   `coffee`, `event` (`src/components/capture/capture-form.tsx:27`). Other paths write values
   in neither: `"outreach"` (`src/actions/outreach.ts:690`), `"meeting_note"`
   (`src/lib/note-batch-save.ts:185`), a dynamic `channel` (`src/actions/reminders.ts:673`).
   `interaction_type` is free text — `text("interaction_type").default("note").notNull()`
   (`src/db/schema.ts:465`), no DB enum — so all of these land in the timeline and render as
   raw snake_case.
2. **Editing a Capture-created interaction shows a blank Type dropdown.** `openEdit()` does
   `setFormType(i.interactionType)` (line 206); for `coffee` the `<Select>` has no matching
   `<SelectItem>`, so it renders empty. The value survives an untouched save, but the control
   misrepresents the record.

## Decisions

- **Scope: the product-facing contact Timeline only.** Not the admin console's "Activity
  timeline" (`src/lib/admin-timeline.ts`) — a different data model (a 10-arm SQL `UNION ALL`
  whose arm list doubles as a redaction allowlist, guarded by
  `scripts/smoke-admin-unmasked.ts`) with an audience of one.
- **Color rides on CSS tokens**, reusing two `--import-*` tokens whose meaning is already
  identical and minting two new hues. See "Palette".
- **Color is never the only signal.** Every row carries a distinct icon shape *and* a text
  label. The design must survive monochrome and colorblindness.
- **No new UI primitive.** No tabs/collapsible/accordion/scroll-area — none exist in
  `src/components/ui/`, and every disclosure here is a `useState` boolean.
- **The server query is not touched.** See "Deliberately out of scope".

## Palette

**Color encodes the *channel class*; the icon shape and a text label encode the specific
type.** Five tones, four chromatic. The most common row — a note you wrote — is deliberately
achromatic, so color comes to mean "something happened *with someone*."

### Why tokens, not Tailwind palette classes

The obvious cheap move is raw palette classes in a lookup map, as
`src/components/dashboard/closeness-tier-badge.tsx` does with
`emerald-500/15 · sky-500/15 · amber-500/15`. **That is ruled out by evidence:**
`ContactStatPills` renders on *this same page*, a few hundred pixels above the timeline, and
calls `closenessTierChipClass()` (`src/lib/closeness.ts:488`) — emitting exactly
`bg-emerald-500/10 text-emerald-700 dark:text-emerald-300` for "inner orbit", sky for "mid",
amber for "outer". Assigning emerald to `meeting` and sky to `email` would put two different
meanings behind the same chip color on one screen. So: tokens, and hues chosen against what
is already spent.

`--chart-*` is unusable regardless — `globals.css` documents that those hues **invert between
themes** (chart-4 is gold in light, blue in dark), so no stable kind→color mapping can be
built on them.

### Reuse where the meaning is already identical

Two `--import-*` tokens mean precisely what a timeline family means. Reusing them is
reinforcement, not hue-borrowing:

| Reused token | Why it is the same meaning |
|---|---|
| `--import-messages` (terracotta) | The LinkedIn **Messages** importer is what writes `interaction_type = 'linkedin_message'`. The hue already means "written correspondence". |
| `--import-connections` (indigo) | `src/lib/linkedin-timeline-events.ts` writes `reach_out` for a connection event — the **Connections** importer. The hue already means "network event". |

`--import-calendar` is deliberately **not** reused for meetings, even though
`src/lib/calendar-sync.ts:280` writes `meeting`. Its light value `#b8873a` measures ~3.2:1 on
`#ffffff`; darkening it to clear 4.5:1 lands it visually on top of `--tier-lifetime`
`#8a6423` — the exact collision that token's comment forbids.

### Two new tokens

The unclaimed span is the violet→rose arc. Teal (`--primary`, `--chart-1`), green
(`--chart-2/3`, closeness emerald), gold (`--import-calendar`, `--tier-lifetime`,
`--chart-4`), rust (`--import-messages`, `--chart-5`, `--destructive`), blue (`--tier-pro`,
closeness sky) and indigo (`--import-connections`) are all spent. Add to `:root`, `.dark`, and
the `@theme inline` block alongside the `--import-*` lines, with a comment in the house style
recording *why* these hues and what they avoid:

- `--interaction-met` — violet (~275°). Light and dark values must differ: a light violet dark
  enough for `#ffffff` reads as near-black on `--card` `#1a2438`, the failure
  `--tier-lifetime`'s comment already documents.
- `--interaction-call` — rose/magenta (~335°).

Exact hex values get picked and **measured** during implementation, to this bar: ≥4.5:1
against both `--card` and `--muted` in light, ≥4.5:1 against `--card` in dark, and ≥3:1 for
the icon against its own tinted chip (WCAG 1.4.11). Record the measured numbers in the PR.

### The five tones

Collapsing the fragmented vocabulary. `note` is neutral — the most common type, and it
doubles as the unknown-type fallback for free:

| tone | raw values mapped | icon | chip |
|---|---|---|---|
| `note` | `note`, `meeting_note`, **+ unknown** | `NotebookPen` (unknown: `CircleDashed`) | `bg-muted text-muted-foreground` |
| `met` | `meeting`, `event`, `in_person`, `coffee` | `CalendarCheck` / `PartyPopper` / `Handshake` / `Coffee` | `bg-interaction-met/12 text-interaction-met` |
| `call` | `call` | `Phone` | `bg-interaction-call/12 text-interaction-call` |
| `correspondence` | `email`, `linkedin_message`, `message` | `Mail` / `MessageSquare` / `MessageCircle` | `bg-import-messages/12 text-import-messages` |
| `network` | `reach_out`, `outreach` | `Send` | `bg-import-connections/12 text-import-connections` |

Four scheduled/physical types share the `met` tone but keep **distinct icons**. That is the
thesis working: color answers "what kind of contact was this", the icon answers "which one",
and merging them buys two well-separated hues instead of three adjacent purples that no one
could tell apart — which is the failure mode color-coding exists to avoid.

Every class must be a **literal string** in the lookup map. Tailwind v4 scans source text, so
an interpolated `` `bg-interaction-${tone}/12` `` silently yields unstyled chips in a
production build. This follows `SOURCE_META` in `import-history.tsx`.

Icons are verified present in the installed **lucide-react 1.24.0**: `NotebookPen`,
`CircleDashed`, `CalendarCheck`, `PartyPopper`, `Handshake`, `Coffee`, `Phone`, `Mail`,
`MessageSquare`, `MessageCircle`, `Send`, `Ellipsis`. There is **no `Linkedin` brand glyph** —
use `MessageSquare`, matching `import-history.tsx`. (`MoreHorizontal` and `Filter` *do* still
exist as aliases; `Ellipsis` and `ListFilter` are the v1 canonical names.)

Chip render: `grid size-8 place-items-center rounded-[10px] ring-1 ring-inset` + the tone
classes, icon at `size-4`. The chip is `aria-hidden`; the adjacent text label carries the
meaning for assistive tech, and is **never tinted** — one color moment per row, and
`--import-messages` at ~3.9:1 on white is below AA for text anyway.

**New module `src/lib/interaction-meta.ts`** (pure, no React, no runtime `@/db` import — a
*value* import from `@/db` in a client-reachable module fails the build with an opaque
`node:fs` chunking error; `src/lib/reminder-action-kind.ts` shows the safe `import type`
pattern). Exports `TONE_CLASSES`, `INTERACTION_TYPE_OPTIONS`, `typeLabel(raw)`, and
`interactionTypeMeta(rawType)` → `{ key, label, Icon, tone, known }`.

Normalization is an **open lookup, not a closed `Record`**: slugify (lowercase, trim,
non-alphanumerics → `_`), apply an alias table (`outreach`→`reach_out`,
`meeting_note`→`note` — matching the server-side precedent at `src/actions/knowledge.ts:77`,
plus `zoom`/`phone`→`call`, `sms`/`dm`→`message`, `irl`→`in_person`), then fall back to
`{ Icon: CircleDashed, tone: "note", label: titleize(raw), known: false }`. Unknowns still
render a full-size chip, so **row geometry never depends on whether the type is recognized**,
and a `sr-only` "(unrecognized type)" tells screen readers what the dashed ring conveys
visually. This is the single place the two disagreeing type lists get reconciled — it fixes
defect #1 for every consumer.

Also fix defect #2 while here: the editor's `<Select>` gets an extra `<SelectItem>` for the
record's current type when that value isn't canonical, so editing a `coffee` interaction shows
"Coffee" rather than a blank control.

**New module `src/lib/interaction-meta.ts`** (pure, no React, no runtime `@/db` import — a
*value* import from `@/db` in a client-reachable module fails the build with an opaque
`node:fs` chunking error; `src/lib/reminder-action-kind.ts` shows the safe `import type`
pattern). Exports `INTERACTION_FAMILIES`, `resolveInteractionMeta(rawType)` →
`{ family, icon, chip, label }` with normalization (lowercase, trim) and the `note` fallback,
and `humanizeType(raw)` for the label of an unmapped value. This is the single place the two
disagreeing type lists get reconciled, and it fixes defect #1 for every consumer.

Also fix defect #2 while here: the editor's `<Select>` gets an extra `<SelectItem>` for the
record's current type when that value isn't in the canonical list, so editing a `coffee`
interaction shows "Coffee / hangout" rather than a blank control.

## Layout and interaction

### Kill the inner scrollbox

`<main>` is the real scroll container — `app-shell.tsx:129` is
`overflow-y-auto overscroll-contain` (only chat and constellation set `isViewportLocked`,
which the contact page does not). There is no sticky desktop header. So the timeline can
simply flow in the page, and a sticky group header pins at the top of the visible area.

Removing the 448px box removes a nested scroll axis, iOS momentum trapping, sticky headers
that pin inside a small window rather than at the top of what you're reading, a custom
IntersectionObserver `root`, and two-container anchor scrolling. Height gets bounded by
**content policy** (windowing, below) instead of a CSS clamp.

**This is the riskiest change in the branch.** `Card` sets `overflow-hidden` in its base
classes (`src/components/ui/card.tsx:20`), and an `overflow: hidden` ancestor is a scrollport
— so **sticky inside the Card silently does nothing**.

Override with **`overflow-clip`**, not `overflow-visible`, on this one Card's `className`
(`cn` is `twMerge`, so the later class wins). `overflow-clip` clips identically for the
`rounded-xl` ring — so nothing bleeds past the corners — but, unlike `overflow-hidden`, it
creates **no scrollport**, which is exactly what unblocks `position: sticky`. This is
strictly better than `overflow-visible`, which would fix sticky at the cost of the card's
corner clipping.

It fails *silently* and looks fine in a short list, so it must be verified on a contact with
100+ rows across 10+ months. If sticky still misbehaves, bisect for a transformed or filtered
ancestor (a transform creates a containing block) — the `Reveal` wrapper is the first
suspect, though its keyframe declares only a `from` block so it should leave no lingering
transform. **Fallback: drop the sticky and render plain month headers** — nothing else in the
redesign depends on it.

- Month headers: `sticky top-0 z-10` with **opaque `bg-card`** (not `bg-card/95
  backdrop-blur` — translucency over a non-scrollport shows bleed), full-bleed via
  `-mx-(--card-spacing) px-(--card-spacing)`.
- **Only the month header is sticky.** Stacked month+day stickies need hardcoded pixel
  offsets that break at different text sizes, for little gain once dense days collapse.
- `scroll-mt` grows so anchored rows don't land under the sticky header: rows `scroll-mt-14`,
  month sections `scroll-mt-2`, Card keeps `scroll-mt-24`.

### Hierarchy: month → day → row

Absolute dates, not relative buckets. This is a memory archive, and the main entry point into
it is a brief that says "Mar 12" (`contact-brief-card.tsx:45`) — recency buckets make the
thing the user was told to look for unaddressable, and "Earlier" would hold 96% of a heavy
contact's history. One concession at the day level: `Today` / `Yesterday` render as words,
still beside the date. The month header carries the year, so day headers omit it.

Once the header carries the date, **the row shows no date at all** — that is the point of
grouping — and **no time of day**: `interactionDate` is unreliable at time granularity
(imports fall back to `atLocalNoon` or import time). The row is: type label, summary clamped
to two lines, action items, and one action affordance.

### Replace the scrubber with "Jump to"

Delete `src/components/contacts/timeline-date-scrubber.tsx` (verified: `contact-timeline.tsx`
is its only importer; its `monthKeyFromDate`/`monthLabel`/`monthShort` helpers move to
`src/lib/timeline-groups.ts` in the same commit). It is `hidden sm:flex` so touch gets
nothing, it degenerates past ~20 months inside its fixed-height rail, and its whole job was
navigating a window that no longer exists.

Replace with a **"Jump to" `Select`** in the card header listing months with counts
(`Mar 2024 · 12`). One control, touch-friendly, keyboard-reachable, stable at 60 months, and
it deletes an IntersectionObserver.

### Filtering — client-side, no URL state

Everything is already in memory; URL state would mean `router.replace` + `refresh` re-running
the whole heavy profile page per keystroke, and collides with the contacts-list `?q=`
semantics.

- **Type filter**: single `Select`, options derived from **the types present on this contact**
  with counts (`All types (312)`, `LinkedIn (287)`, `Meeting (14)`), each option prefixed with
  its tone chip so the control doubles as the **color key** — the honest answer to "how does a
  user learn what violet means" without a permanent legend strip. Data-derived, so a free-text
  type can never crash it. Hidden entirely when ≤1 distinct type.
  Note a single `Select` is deliberate: `src/components/ui/dropdown-menu.tsx` exports only
  Root/Trigger/Content/Label/Item/Separator — there is **no `DropdownMenuCheckboxItem`** — so
  multi-select would mean hand-building `Popover` + `Checkbox`. Not worth it in v1.
- **Search**: `Input type="search"` over `aiSummary + rawNotes + actionItems`. Searching
  `rawNotes` is the point — that's where LinkedIn message bodies live. Rendered only at ≥10
  interactions. Filter on `useDeferredValue`, not a debounce; there's no network to protect.
- Filters apply **before** grouping, so empty months/days disappear and "Jump to" is rebuilt
  from surviving months.

### Progressive disclosure — delete the notes Sheet

Opening a modal to read one paragraph is the most expensive interaction in the current
design, and for LinkedIn-heavy contacts it is the *only* way to read anything.

Summary renders in a `line-clamp-2` paragraph (CSS clamp — delete `oneLine()`'s
`slice(0, 157)`). When `rawNotes` exists and differs from the summary, a `Show note` /
`Hide note` text button expands the full note in place, `whitespace-pre-wrap break-words`.
No height animation — animated collapse in a long list is a classic scroll-jank source, and
instant is smoother than a janky 200ms.

**Do not use `ExpandableText`** despite it existing: it takes a single string and owns its
`expanded` state internally, whereas we need two fields (short summary → different longer
note) and hoisted state (deep-link reveal must expand a row from outside). It also runs a
`ResizeObserver` per instance to detect overflow — 40+ observers to answer a question
`note !== summary` answers for free. Match its visual language
(`text-xs font-medium text-primary underline-offset-2 hover:underline`), don't use it.

### Row actions — one fixed-width `⋯` menu

Replace the 1–3 conditional ghost icon buttons with a single `DropdownMenu` in a `shrink-0`
slot with a **fixed `size-8` on every row**, which makes the current jitter and right-edge
misalignment structurally impossible. Menu items are text+icon, so they self-label (three
unlabeled icons is a discoverability problem as well as a visual one): `Edit` always;
`Move earlier`/`Move later` omitted when the day has one item, present-but-disabled at the
ends when it has more.

Visibility: `opacity-0` revealed by `group-hover/row`, `group-focus-within/row`, a
`data-menu-open` attribute driven by React state, **and an explicit
`[@media(hover:none)]:opacity-100`**. Tailwind v4 gates `hover:` behind
`@media (hover: hover)`, so the repo's existing hover-reveal idiom
(`reminder-list-sidebar.tsx:125`) is *already* permanently invisible on touch — copying it
without the fallback would ship a timeline that cannot be edited on a phone. Never use
`hidden`/`display:none` for the reveal; it must stay in the tab order.

No drag-and-drop reordering — a multi-week project once touch and keyboard equivalents are
owed, for swapping two notes typed on the same day.

### Volume — client-side window, no virtualization

Each row is ~10–14 DOM nodes; **~150 rows is where interaction starts to feel heavy, ~500+ is
unambiguously broken**, and LinkedIn imports clear both routinely.

- Window the *filtered* list: `INITIAL_ROWS = 40`, `PAGE = 40`, with an explicit
  `Show 40 more · 272 remaining` button.
- **Explicit button, not the auto-load sentinel** from `contacts-list.tsx:255`. That pattern
  exists because each page there is a network fetch. Here everything is in memory, so a
  sentinel only removes the user's control over page length — and because Reminders,
  Mentions and Related People sit below the timeline in the same scroll container,
  auto-loading makes the rest of the profile asymptotically unreachable.
- **Collapse dense day groups**: a day with >6 items shows 3 plus
  `Show 37 more from this day`. This is what actually tames the LinkedIn shape.
- **No virtualization**: it needs measured row heights (these vary with action items and
  expansion), breaks `#interaction-<id>` for unmounted rows, breaks find-in-page, fights
  sticky headers, and adds a dependency.

This fixes *rendering*, not *payload* — the server still ships every row's full `rawNotes`.
That's the follow-up, below.

### Deep links must never be unreachable

`contact-brief-card.tsx:45` links to `#interaction-<id>`, and rows are anchor targets. A
single `revealInteraction(id)` owns this: clear both filters → grow the window past the
target's index → expand its day group → `rAF` → `scrollIntoView` → `flashSection`. Because
the whole array is client-side these are synchronous state updates, so a target can never be
filtered, paged, or collapsed out of reach.

Reuse the existing global `SectionFlash` (`src/components/layout/section-flash.tsx`, mounted
in `src/app/(app)/layout.tsx`) — it retries for 2000ms and skips `offsetParent === null`
targets, so a row revealed synchronously lands well inside its window. Keep the `<Link href>`
for middle-click/copy-link and add an explicit `onClick`: that file's own comment documents
that a Next hash-only navigation on the current route reliably fires neither a pathname
change nor `hashchange`.

### Empty, loading, and feedback states

- **No interactions at all**: muted icon, `No history yet`, one line of copy, and two CTAs —
  primary `Add interaction` (same editor the header's Add opens), secondary `Import messages`
  → `/imports`. The current bare `<p>` has no CTA at all despite an Add button sitting in the
  header.
- **Filtered to nothing**: a *different* state — `No interactions match "coffee"` plus
  `Clear filters`. Never reuse the "no history" copy; it would tell the user something false.
- **Loading**: nothing to add. The timeline renders synchronously inside `<Reveal>` and is not
  behind a Suspense boundary.
- **In-flight**: the affected row gets `aria-busy` and `opacity-70`; the menu closes
  optimistically. After a successful add, `logInteraction` returns the inserted row, so stash
  `pendingRevealId` and reveal it once the refreshed props contain it.

### Accessibility

- Card gets `role="region" aria-labelledby`; `CardTitle` gets `role="heading" aria-level={2}`
  (it renders a styled `div` today, so the timeline currently contributes nothing to the
  document outline). Month `<section aria-labelledby>` + `<h3>`; day `<h4>` + `<ol>`/`<li>`;
  rows `tabIndex={-1}` for programmatic focus.
- Focus order: `Add` → `Jump to` → type → search → per row, `Show note` then `⋯` (content
  before actions) → day's `Show more` → list's `Show more`.
- One visually-hidden `aria-live="polite"` region for filter result counts, window growth,
  and reorder confirmations — **a reorder currently produces no feedback at all**, success or
  failure.
- Focus management: when the last `Show more` unmounts, move focus to the first newly revealed
  row; after a reorder re-focus the moved row's menu trigger (it otherwise drops to `<body>`).
- `scrollIntoView` uses `behavior: "smooth"` only when `usePrefersReducedMotion()` is false.

## Files

**Rewritten**
- `src/components/contacts/contact-timeline.tsx` — the only stateful component; owns filters,
  window, expansion sets, deep-link resolution, mutations, editor target. ~220 lines, down
  from 514.

**Modified**
- `src/app/globals.css` — 2 new tokens × 2 themes (`:root` + `.dark`) plus their
  `@theme inline` registrations, next to the `--import-*` block, with a house-style comment
  recording the hue reasoning. No `.yc-theme` override: these classify content, not chrome,
  and the timeline never renders in the admin shell.

**New**
- `src/lib/interaction-meta.ts` — the type→{key, label, Icon, tone, known} map, alias table,
  open-lookup normalization, unknown fallback, plus `TONE_CLASSES` and
  `INTERACTION_TYPE_OPTIONS`. Pure; `import type` only.
- `src/lib/timeline-groups.ts` — pure `groupInteractions(items, { query, type })` →
  `{ months: [{ key, label, days: [{ key, label, items }] }], total, matched, typeCounts }`,
  plus the month helpers rescued from the scrubber. Pure so the grouping/filtering invariants
  are testable without a renderer.
- `src/lib/timeline-reveal.ts` — `TIMELINE_REVEAL_EVENT` + `revealInteraction(id)`, mirroring
  `flashSection`.
- `src/components/contacts/contact-timeline-row.tsx` — one `<li>`. `React.memo`'d, so parent
  callbacks must be `useCallback`-stable or the memo is theatre.
- `src/components/contacts/contact-timeline-toolbar.tsx` — jump-to-month, type filter, search,
  live region. Presentational; each piece self-hides.
- `src/components/contacts/contact-timeline-editor.tsx` — the add/edit Sheet lifted
  **verbatim**, mounted with `key={editing?.id ?? "new"}` so reset is free. Zero behavior
  change beyond the unknown-type `SelectItem` fix.
- `src/components/contacts/contact-timeline-empty.tsx` — both empty states.

**Deleted**
- `src/components/contacts/timeline-date-scrubber.tsx`

**Touched (one line)**
- `src/components/contacts/contact-brief-card.tsx:45` — add `onClick={() => revealInteraction(id)}`.

**Not touched**: `contacts/[id]/page.tsx` (prop shape unchanged), `src/actions/contacts.ts`,
`src/components/ui/*`.

## Sequencing

Each step is independently reviewable:

1. Tokens in `globals.css` (isolated, no consumers yet — eyeball both themes in devtools and
   record the measured contrast ratios).
2. `interaction-meta.ts` + `timeline-groups.ts` + extract `contact-timeline-editor.tsx`
   verbatim. Pure/no-op; no visible change.
3. Color-coded icon chips on the *existing* row, before any layout change. **The headline
   change, shippable on its own, and one reviewable diff for "color arrives".**
4. Remove the scrollbox, add `overflow-clip`, day grouping + sticky month header, strip the date off rows. **Prove sticky-at-volume here** — this is the main risk and everything after depends on the answer.
5. Row rewrite: `⋯` menu, line-clamp + `Show note`, delete the notes Sheet and `oneLine()`.
6. Window + collapsed day groups + `Show more`.
7. Toolbar (jump-to, filter, search, live region); delete the scrubber.
8. `revealInteraction` + brief-card `onClick`; empty states; post-save reveal; focus management.

## Verification

There is **no component test infrastructure** — `npm test` runs DB-level smoke scripts against
PGlite (`scripts/run-smoke.ts`), none of which touch this component. So:

- `npx tsc --noEmit` and `npx eslint` on changed files. Baseline is 0 errors / ~36 warnings, so
  any error is ours.
- Pure-logic check: `groupInteractions` and `interactionTypeMeta` are pure and importable —
  exercise them from a throwaway `tsx` script (grouping boundaries, the alias table, unknown
  types, empty filter results) rather than only clicking. Note `tsx` scripts need an explicit
  `process.exit(0)` in this repo.
- Grep the built output (or just the source) to confirm **every tone class is a literal
  string** — an interpolated class silently yields unstyled chips only in a production build,
  so `npm run build` and check a chip renders tinted, not just `next dev`.
- Manual passes in the browser preview against three fixtures — a contact with 0
  interactions, one with ~5, one with 300+ from a LinkedIn import — each at 375px and desktop,
  in **both light and dark**, checking: sticky month header behavior, that `overflow-clip`
  still clips cleanly at the Card's `rounded-xl` ring, chip contrast against `--card` and
  `--muted`, and that no row jitters as the `⋯` menu appears.
- A grayscale pass (devtools rendering → disable color, or a CVD simulation): the timeline must
  stay fully usable, since icon shape and text label are meant to carry the type on their own.
- Touch emulation specifically (not just a narrow viewport) to confirm the `⋯` menu is
  reachable — this is the `(hover: none)` trap.
- Keyboard-only run: tab through toolbar → rows → show-more, confirming focus never lands on
  an invisible control and returns sanely after a reorder and after the editor closes.
- Deep-link run: from the brief card's "Recent discussions", and by pasting a
  `#interaction-<id>` URL for a row 300 deep behind an active search.
- Note the worktree gotcha: a fresh worktree has no `node_modules` (`npm ci` in it) and no
  `.env`, so it runs demo-mode on local PGlite.

## Deliberately out of scope

- **`limit` on the server query.** `contacts/[id]/page.tsx:164` computes
  `formatInteractionFrequency` over the **full** interaction set and `:130` derives
  `hasLoggedInteraction` from `interactions.length`; `capture/page.tsx:24` is a second caller.
  Adding a limit degrades the frequency label with **no error** — a silent-degradation trap,
  not a compile error. The follow-up is a `listContactInteractionsPage` + an
  `interactionLimit` option returning a precomputed count/frequency; the index
  `interactions_user_contact_type_date_idx` already covers it. The UI above is deliberately
  shaped so that swap is a prop change.
- **Delete an interaction** — no `deleteInteraction` server action exists anywhere; it needs
  the action, a confirm dialog, and a decision about briefs that reference the row.
- Drag-and-drop reordering; virtualization; multi-select or date-range filters; URL-persisted
  filter state; inline (non-Sheet) editing; swapping the native date input for the existing
  `date-picker` primitive (a clean standalone change).
- **Threading LinkedIn messages into conversations** — `source` + `externalId` would support
  it, but it's a data-model feature wearing a UI costume. Collapsed day groups get most of the
  benefit for a fraction of the work.
- Rendering `sentiment` / `topics` (columns exist, nothing displays them).
- The admin activity timeline.
- **A pre-existing contrast bug found while picking hues, worth its own change:**
  `--import-calendar` light `#b8873a` measures ~3.2:1 on `#ffffff` and is used as *text*
  (`text-import-calendar`) in `import-history.tsx` and `calendar-import-section.tsx:79-81` —
  below AA. Fixing it means darkening it into `--tier-lifetime` territory or re-hueing it;
  both are palette decisions that belong in their own PR, not smuggled into this one.
- **Aligning the other type lists.** Once `interaction-meta.ts` exists, `capture-form.tsx:27`
  should source `INTERACTION_TYPE_OPTIONS` from it instead of its own divergent list, and the
  admin contact table should print `typeLabel(row.interactionType)` rather than the raw
  column. Both are follow-ups — this PR establishes the module and converts the timeline only,
  so the diff stays reviewable.

## Open questions for review

1. **The two new hues.** Violet (~275°) and rose (~335°) are the recommendation, on the
   grounds that every other arc is spent and the closeness tiers already own emerald/sky/amber
   *on this same page*. Exact hex values are deliberately unpicked here — they need measuring,
   and they are the one decision most worth a second opinion before code exists.
2. **Merging `meeting` / `event` / `in_person` / `coffee` into one `met` tone.** This buys two
   well-separated hues instead of three adjacent purples, and leans on icon shape to
   distinguish. If meeting-vs-coffee is a distinction worth a color, that's a deliberate trade
   to reverse.
3. **Deleting the month scrubber** for a "Jump to" control. The dot rail is more distinctive;
   it is also desktop-only and degrades past ~20 months. Worth confirming nobody loves it.
