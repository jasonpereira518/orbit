/**
 * The one place in this extension that acts on the page instead of reading it.
 *
 * Every other file under `inject/` follows one rule: read what the user's browser already
 * rendered, once, and never navigate, click, scroll, or paginate. That rule is suspended
 * here, deliberately and narrowly, because LinkedIn collapses long careers behind
 * "Show all N experiences" and a capture that silently omits half of someone's history is
 * worse than one that takes a second longer. The repo owner signed off on this exact
 * tradeoff — see task-10 of the LinkedIn-experience SDD — on the condition that the
 * exception stay contained to this one file and be bounded on every axis that matters:
 *
 *   - it runs only from an explicit "Capture experience" press, never on page load or on
 *     panel open, so nothing happens to a page the user is merely reading — the adapter
 *     only calls `expandProfileSections` when the panel passed `withProfile: true`, which
 *     only that button sets;
 *   - it clicks at most MAX_CLICKS controls and gives up after TIME_BUDGET_MS of wall clock,
 *     whichever comes first;
 *   - it only ever clicks controls found *inside* a profile section (`main section`) that
 *     is not itself inside global chrome/navigation or a "not the subject" section (see
 *     `excludedRegions` in `./text`, the same list the READ path uses to keep those out of
 *     the text blob — one definition, not two that can drift), and never a control whose
 *     visible label it does not recognize (see `isExpandControl`) — an unrecognized control
 *     is left alone rather than guessed at;
 *   - it does not scroll, and it does not follow a "Show all" rendered as an `<a href>`,
 *     because that navigates to a different page rather than expanding in place; that case
 *     is the fallback's job, not this module's;
 *   - it never re-clicks a node it has already tried (`seen`), so a control that re-renders
 *     under the same DOM node after a click cannot be double-counted or loop forever.
 *
 * When this fails or runs out of budget, the caller (the LinkedIn adapter) still returns
 * whatever `readProfileSections` managed to read, plus a warning; the panel's fallback is
 * to prompt the user to open `/in/<slug>/details/experience`, which LinkedIn serves
 * uncollapsed and which this module never needs to touch.
 */

// Relative, not the `@/` alias: `./text` is a sibling in this same `dom/` directory, and
// keeping this alias-free matches `adapters/linkedin-profile.ts` and `adapters/linkedin.ts`,
// which need to stay importable by `scripts/smoke-contact-profile-format.ts` from repo
// root — that script resolves under the ROOT tsconfig, where `@/*` points elsewhere.
import { excludedRegions, visibleText } from "./text";

/** Exported so a smoke test can assert the cap actually bites rather than hardcoding 12. */
export const MAX_CLICKS = 12;
const TIME_BUDGET_MS = 4000;
const SETTLE_MS = 250;

/** Only these. An unrecognized control is left alone. */
const EXPAND_LABELS = [/^see more$/i, /^…see more$/i, /^show all \d+ /i, /^show \d+ more/i];

/**
 * Pure predicate: does this element look like an in-place "show more" control?
 *
 * Exported so `scripts/smoke-contact-profile-format.ts` can exercise the label matching
 * and the anchor rejection against synthetic markup without a browser — this and
 * `expandProfileSections`'s section-scoped, excluded-region-aware `querySelectorAll` are
 * the only two places that decide what gets clicked, and this half of the decision needs
 * no live page to test.
 */
export function isExpandControl(el: Element): boolean {
  // `visibleText`, not raw `textContent`: LinkedIn's real accessible-button markup
  // duplicates the label — `<span aria-hidden="true">…see more</span><span
  // class="visually-hidden">…see more</span>` — and raw `textContent` concatenates both
  // copies into `"…see more…see more"`, which none of the anchored `^…$` regexes below
  // match. `visibleText` prefers the `aria-hidden="true"` copy, which is the one a sighted
  // user actually sees, so this recognizes the button on the real page, not just in a
  // synthetic single-label fixture.
  const label = visibleText(el);
  if (!label) return false;
  if (!EXPAND_LABELS.some((re) => re.test(label))) return false;
  // Reject every anchor, not just one with an href: an href-less anchor can gain one
  // dynamically, or carry a click handler that navigates anyway, and LinkedIn's real
  // expanders are buttons — excluding all of them costs nothing. This also means the check
  // never has to lean on `HTMLAnchorElement.href`'s URL-resolution semantics (which
  // linkedom, used by the smoke test above, does not fully model) to decide whether a given
  // anchor "really" navigates.
  if (el.tagName === "A") return false;
  return true;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export async function expandProfileSections(
  root: ParentNode = document
): Promise<{ clicked: number; timedOut: boolean; capped: boolean }> {
  const started = Date.now();
  let clicked = 0;
  const seen = new WeakSet<Element>();

  while (clicked < MAX_CLICKS) {
    if (Date.now() - started > TIME_BUDGET_MS) {
      return { clicked, timedOut: true, capped: false };
    }

    // Scoped to `main section` on purpose, and re-excluded on every pass (the DOM can
    // change between clicks — a lazy-loaded "People also viewed" carousel, for instance):
    // never global navigation or chrome, and never a "not the subject" section, even one
    // nested *inside* `main section` (see `excludedRegions` in `./text`).
    const excluded = excludedRegions(root);
    const control = [
      ...root.querySelectorAll("main section button, main section [role='button']"),
    ].find(
      (el) =>
        !seen.has(el) &&
        !excluded.some((region) => region.contains(el)) &&
        isExpandControl(el)
    );
    if (!control) return { clicked, timedOut: false, capped: false };

    seen.add(control);
    try {
      (control as HTMLElement).click();
      clicked++;
    } catch {
      // A detached or disabled node — skip it and keep going.
    }
    await sleep(SETTLE_MS);
  }

  // The loop exited because the click cap was hit, not because the page ran out of
  // controls — there may still be more collapsed sections. Distinct from `timedOut` so the
  // caller can warn "expansion was truncated" specifically, rather than folding it into a
  // generic incomplete-read warning.
  return { clicked, timedOut: false, capped: true };
}
