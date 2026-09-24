/**
 * State that belongs to the person on screen, not to the panel.
 *
 * Every field here is a decision the user took about one page: "no, add this
 * one as new", "this one is now saved". Held in plain component state they
 * outlived the page that produced them — a "no, add as new" taken on one
 * ambiguous profile still suppressed the known-contact view three people later,
 * and the seal ring drawn on a save stayed drawn for everyone after.
 *
 * The rule is one line, but it is the rule the panel kept getting wrong, so it
 * lives here where it can be tested without a browser.
 */

export type PageScope = {
  /** The page these decisions were taken on. */
  url: string | null;
  /** The user chose "no — add as new" over a known or ambiguous match. */
  forceCreate: boolean;
  /** The seal ring has been drawn for a save on this page. */
  sealed: boolean;
};

export function emptyScope(url: string | null): PageScope {
  return { url, forceCreate: false, sealed: false };
}

/**
 * The scope that applies to `url`: the one we are holding if it was taken on
 * this same page, otherwise a fresh one.
 *
 * Note this is a *read*, not a write — a stale scope is never carried forward
 * and then corrected later. That ordering matters: correcting it later means
 * rendering one frame with the previous person's decisions applied to the new
 * person, which is exactly the bug.
 */
export function scopeFor(held: PageScope, url: string | null): PageScope {
  return held.url === url ? held : emptyScope(url);
}
