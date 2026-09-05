# Timeline: colour-coded interaction families, and a panel you can live in

**Date:** 2026-09-04
**Status:** Implemented (this PR)
**Predecessor:** PR #126, "Give contact profiles a real timeline and one way to log an interaction"

## Problem

Verified against the code before any of it was written.

- **Colour carried almost no information.** Every node was `--primary` for the four types
  marked `tone: "warm"` and `--muted-foreground` for the other six
  (`contact-timeline.tsx:317-327`). Ten kinds of contact arrived on the profile as two, so a
  year of LinkedIn DMs and a year of coffees were told apart only by a 14px lucide glyph. The
  module header at `interaction-types.ts:23-25` already stated the intent — "so a year of real
  meetings reads differently at a glance from a year of LinkedIn messages" — and the binary did
  not deliver it.
- **No way to narrow a long history.** No filter of any kind. `max-h-[28rem]` of scroll and a
  month scrubber, or nothing.
- **No keyboard path.** Every row was its own tab stop, so a contact with two hundred
  interactions put two hundred stops in the middle of the page, and there was no way to move
  between them other than Tab.
- **The scrubber spaced months evenly** regardless of the real gaps between them
  (`timeline-date-scrubber.tsx:57`, `justify-between`), was not keyboard-navigable, and was
  `hidden sm:flex` — so the viewport that fits the fewest rows had no way to travel at all.
- **Absolute dates only.** "Mar 4, 2026" where "3 weeks ago" is the question being asked.
- **The payload was unbounded in width.** `getContact` selected every column of every
  interaction, full `raw_notes` included, and handed the lot to a client component on every
  profile view (`src/actions/contacts.ts:597-618`) — to render a two-line clamp.

## Decisions taken

Settled during design; recorded so nothing relitigates them.

| Decision | Choice | Why |
|---|---|---|
| What colour encodes | Four **families**, not ten hues | Ten hues on one rail is confetti, and ten accessible hues that survive light, dark and the `.yc-theme` retint do not exist. The lucide icon already distinguishes all ten types. |
| Which four | together / live / written / yours | They answer the question the timeline exists to answer — how much of the person was actually there. |
| Family for `reach_out` and `note` | `yours`, near-neutral | The point of the scheme, not an omission: coloured nodes are things that happened *with* the person, grey ones are your own bookkeeping, so on a typical profile the colour that appears means something. |
| Token source | Four new `--interaction-*` | Every existing candidate means something else. `--primary` is an accent that flips hue between themes, `--ink` is strong text, `--chart-*` are data series that also flip, `--import-*` are claimed. The `--tier-lifetime` comment in `globals.css` exists because this exact mistake was made once already. |
| Second, hue-free channel | `together` is a filled disc, the rest outline | The distinction that matters most stays legible in greyscale and under any colour blindness. |
| `tone: "warm" \| "plain"` | Replaced by `family` | It drew the same line as `family === "together"` in a second place that could drift. `isWarmInteractionType` survives, derived. |
| Date grammar | Calendar days, not elapsed time | The timeline is a client component rendered on the server first. A minute-granularity label is guaranteed to disagree with itself across hydration. |
| Time gaps | Words in the spine, not a proportional rail | Spacing the rail by elapsed time collapses a dense month into an unreadable smear and still cannot say *how long* a silence was. "11 months quiet" can. |
| Windowing | Bound the render, never the query | `formatInteractionFrequency` counts rows in a 90-day window from the same array, and the closeness fallback reads `interactions.length > 0`. A `LIMIT` survives both; a `WHERE` does not. Client-side windowing also keeps deep links reachable. |
| Filter state | `useState` in `ContactTimeline` | Not the URL: `page.tsx` calls `notFound()` before any Suspense boundary, so every param change re-runs `getContact` and `getClosenessCohort` server-side. A colour filter is not worth a round trip. |

Explicitly out of scope: the admin "Activity timeline" at `/admin/users/[userId]`, which is a
different taxonomy (`AdminTimelineKind`) for a different audience; the `kindOf` buckets in
`src/actions/knowledge.ts:76-84`, which are a third vocabulary whose counts are user-visible on
another page; and any change to `interactions.interaction_type`, which stays free text.

## 1. The families

Four families over the ten existing types, in `src/lib/interaction-types.ts`.

| Family | Types | Meaning |
|---|---|---|
| `together` | `meeting`, `in_person`, `event`, `intro` | Time actually spent with them |
| `live` | `call` | Real-time, but across a distance |
| `written` | `email`, `message`, `linkedin_message` | Asynchronous exchange |
| `yours` | `reach_out`, `note` | Your own record — nothing confirmed happened |

`INTERACTION_FAMILIES` carries the label, hint and the class strings each surface applies. The
strings are written out in full because Tailwind extracts class names statically —
`bg-interaction-${family}/12` compiles to nothing.

## 2. The tokens

Declared in `:root` and `.dark`, exposed through `@theme inline` as `--color-interaction-*`,
following the `--import-*` pattern exactly. The `.yc-theme` block retints only `--primary`,
`--accent` and `--admin-nav-hover`, so no third declaration is needed.

| Token | Light | Dark |
|---|---|---|
| `--interaction-together` | `#6d5009` | `#f5cd7a` |
| `--interaction-live` | `#a8375f` | `#f5a3c0` |
| `--interaction-written` | `#4a63c9` | `#8aa9f2` |
| `--interaction-yours` | `#6b7380` | `#8f9db2` |

Measured, not eyeballed:

```
LIGHT (vs #ffffff card / #fbfbf9 bg)      DARK (vs #1a2438 card / #212c42 sheet)
 together  7.50 / 7.23   L* 36.0           together 10.27 / 9.24   L* 84.2
 live      6.22 / 6.00   L* 41.0           live      8.04 / 7.24   L* 75.7
 written   5.36 / 5.17   L* 45.1           written   6.68 / 6.01   L* 69.6
 yours     4.78 / 4.62   L* 48.2           yours     5.64 / 5.08   L* 64.3
```

Every value clears 4.5:1, so the tokens carry text as readily as icons — well above the 3:1 the
icon use requires.

**The lightness ladder is the accessibility mechanism, not a side effect.** It runs monotonically
with presence: darker as presence rises in light mode, brighter as presence rises in dark. That
stagger is what separates `together` (gold, ~75°) from `live` (rose, ~350°), which are the
classic red-green confusion pair and converge under deuteranopia. 5.0 L\* apart in light, 8.5 in
dark, plus different icons. It is the standard the dark chart ramp already sets in the same file
("five distinct HUES with staggered lightness, so series stay separable in grayscale").

Accepted adjacencies, all off this surface: `together` gold sits near `--tier-lifetime` (nav and
settings), `--import-calendar` (`/imports`) and dark `--chart-4` (charts). `ClosenessTierBadge`'s
amber is one click away on the contacts list but never on a profile.

Colour is never the only code. Weight (filled vs outline) carries the primary distinction, hue
carries the family, the ten lucide icons carry the type, and the type label is on every row and
every chip.

## 3. Filtering, and the two traps

`canStep`/`onStep` and `sameDaySiblings` want opposite things, so a naive filter breaks one:

- Filter the render but step through the full list → the sheet moves to an interaction that is
  not on the spine behind it.
- Filter the source list → `move()` sends a partial day to `reorderSameDayInteractions`, which
  rejects any `orderedIds` that is not exactly the day's full set
  (`src/actions/contacts.ts:860-867`) and throws.

So: **stepping reads `visible`, reorder reads `sorted`**, and reorder is disabled entirely while
a filter is on — under a filter the sibling being swapped with is usually off screen, and the
arrows would appear to do nothing.

The open row is **derived during render** (`openId`), not reconciled in an effect, so it holds for
every cause at once. Without it, a selection that leaves the list makes both step directions
false, and the guard at `interaction-detail-sheet.tsx:258` unmounts the entire stepper block —
stranding the reader inside an interaction with no navigation and no explanation.

Chips are drawn only for families the contact actually has, with counts from the full history. The
filtered-empty case gets its own copy; the existing empty state keys on `sorted.length === 0` and
says "Log your first interaction", which would be a lie to someone who filtered to `live`.

## 4. Keyboard

Rows stay `<button>` inside `<ul>`/`<li>`. Not `role="listbox"`/`option`: activation opens a modal
sheet, which is not selecting an option, and `aria-expanded` is already on the button.

Roving tabindex — exactly one row carries `tabIndex={0}`. Up/Down move, Home/End jump,
PageUp/PageDown travel by month. `preventDefault()` on all of them, or the scroll container
scrolls natively *and* `.focus()` scrolls, which reads as the list jumping twice. The active row
is resolved from `document.activeElement` first so two quick presses advance twice before state
catches up, and the roving position is held **by id**: `useRefreshOnVisible` replaces the rows on
every tab focus and a numeric index would silently drift onto a different interaction.

`scroll-mt-8` on the row, not `scroll-mt-4`: the sticky month heading is about 1.75rem, so the old
1rem left a focused first row scrolled-to and then covered.

The house focus ring (`focus-visible:ring-[3px] ring-ring/50`) throughout, including the scrubber,
which was the only `ring-offset` in the codebase — an offset ring is clipped by the timeline's own
scroll container at the top and bottom edges.

## 5. Deep links

`revealInteraction` in `contact-brief-card.tsx` now dispatches `orbit:reveal-interaction` before
scrolling. The timeline clears its filter, expands its window, and scrolls once the row exists.

This is required, not defensive: `flashSection` retries every 32ms for two seconds, requires
`offsetParent !== null`, and then **gives up silently**. A "recent discussion" naming a row behind
a filter would simply do nothing. `ContactBriefCard` and `ContactTimeline` are siblings under a
Server Component with no shared state, so the event is the cheapest correct channel — the same
one `flashSection` itself uses.

## 6. Payload

The `interactions` relation now selects five columns plus `notesPreview`, a `left(raw_notes, 600)`
computed in SQL. The detail sheet is unaffected — it already loaded the full row lazily through
`getInteractionDetail`. `actionItems` is dropped from the crossing shape: it was on the type and in
the mapping but never read, since the "N open" chip comes from `listOpenActionItems`.

Columns are restricted, **rows are not**, and the distinction is load-bearing: `page.tsx:129` feeds
`interactions.length > 0` into the closeness fallback, and `formatInteractionFrequency` counts rows
in a 90-day window from the same array.

`getContact`'s other caller, `capture/page.tsx`, reads only the id and the name, so it benefits for
free — though it is still loading every interaction and reminder for two fields, which is worth a
follow-up.

## 7. Verification

No schema change. `SCHEMA_VERSION` stays at 26 and `smoke-schema-ddl` passes against the recorded
fingerprint; `left(...)` is a select expression, not a column.

`scripts/check-interaction-contrast.mjs` reads the four tokens back out of `globals.css` and
fails if any drops below 4.5:1 on the card or the page ground of its own theme, or if the L\*
ladder stops being monotonic. The ladder is the accessibility mechanism, so it needed to be a
gate rather than a paragraph — it caught `yours` at 4.31:1 against `--background` during this
work, which no screenshot would have shown.

`scripts/smoke-timeline-vocabulary.ts` (pure) covers what is pure: every type resolves to a real
family, every legacy `interaction_type` still on disk lands on one, each class string names the
token it claims to, `warm` still draws exactly the `together` line, and the date grammar against a
fixed anchor — including the stability-across-the-hours case, which is the whole reason it counts
calendar days.

Everything else is manual, because this repo has no component test harness: the four families
rendering, each filter and its counts, driving the spine by keyboard alone, stepping the sheet
under an active filter, reorder disabled while filtered, a deep link landing on a row the filter
was hiding a moment earlier, light and dark, 375px, and `prefers-reduced-motion`.
