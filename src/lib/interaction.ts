/**
 * Interaction recipes — the settled hover / press / focus treatments.
 *
 * These exist because the app had grown three competing hover languages: a
 * background wash on list rows, a border+shadow lift on cards, and a third
 * ring+shadow treatment behind `Card`'s `interactive` prop that no call site
 * ever used. The first two are real and distinct — a row and a card are
 * different kinds of target and should not look alike — so both survive here
 * and the third was deleted.
 *
 * Compose with `cn()` like any other class string.
 *
 * All four use the motion tokens from the `@theme` block in globals.css
 * (mirrored in `src/lib/motion.ts`): `duration-fast` is 120ms, the interaction
 * tier, and `ease-house` is the shared arrival curve. Exemplars that already do
 * this by hand: `contacts/contact-timeline.tsx:686`, `contacts/contacts-list.tsx:444`.
 */

/**
 * A row inside a bordered list — the `divide-y` pattern used by contacts,
 * recruiters, and knowledge. The wash is `/40` against the page ground.
 *
 * Focus gets the SAME background as hover, not just a ring. Keyboard users were
 * getting strictly less feedback than mouse users everywhere except
 * `contacts-list.tsx:435`, which was the only row in the app to do this.
 */
export const ROW_HOVER =
  "transition-[color,background-color,translate] duration-fast ease-house " +
  "hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none " +
  "focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset " +
  "focus-ring-fallback";

/**
 * A row nested inside a card that already carries its own padding and ground.
 * The wash steps up to `/60` because it sits on `bg-card`, not on the page.
 */
export const ROW_HOVER_INSET =
  "rounded-lg transition-[color,background-color,translate] duration-fast ease-house " +
  "hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none " +
  "focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset " +
  "focus-ring-fallback";

/**
 * A clickable card surface. Border and shadow rather than a wash, so a card
 * never reads as an oversized row.
 *
 * The property list is explicit: `border-color` is named alongside `box-shadow`
 * because the hover changes both, and transitioning only the shadow left the
 * border snapping while the shadow eased.
 */
export const CARD_HOVER =
  "transition-[border-color,box-shadow,background-color,translate] duration-fast ease-house " +
  "hover:border-primary/30 hover:shadow-md";

/**
 * Press feedback for pressables that are not `<Button>` — Links, and rows with
 * `role="link"`.
 *
 * A 1px nudge rather than a scale, because that is what `ui/button.tsx` already
 * chose (`active:not-aria-[haspopup]:translate-y-px`). One press language across
 * the app beats a marginally better one applied to half of it.
 *
 * Composes with `ROW_HOVER` / `ROW_HOVER_INSET` / `CARD_HOVER` with no extra
 * work: all three name `translate` in their transition property list, so the
 * nudge eases on the interaction tier instead of snapping. On a bare element
 * with no transition of its own it still works — it just snaps, which for a 1px
 * press is barely perceptible.
 */
export const PRESS = "active:translate-y-px";
