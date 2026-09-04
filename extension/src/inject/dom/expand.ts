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
 *   - it only ever clicks controls found *inside* a profile section (`main section`),
 *     never global chrome or navigation, and never a control whose visible label it does
 *     not recognize (see `isExpandControl`) — an unrecognized control is left alone rather
 *     than guessed at;
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

const MAX_CLICKS = 12;
const TIME_BUDGET_MS = 4000;
const SETTLE_MS = 250;

/** Only these. An unrecognized control is left alone. */
const EXPAND_LABELS = [/^see more$/i, /^…see more$/i, /^show all \d+ /i, /^show \d+ more/i];

/**
 * Pure predicate: does this element look like an in-place "show more" control?
 *
 * Exported so `scripts/smoke-contact-profile-format.ts` can exercise the label matching
 * and the navigating-anchor rejection against synthetic markup without a browser — this and
 * `expandProfileSections`'s section-scoped `querySelectorAll` are the only two places that
 * decide what gets clicked, and this half of the decision needs no live page to test.
 */
export function isExpandControl(el: Element): boolean {
  const label = (el.textContent ?? "").replace(/\s+/g, " ").trim();
  if (!label) return false;
  if (!EXPAND_LABELS.some((re) => re.test(label))) return false;
  // A link that navigates is not an in-place expansion; that is the fallback's job.
  if (el.tagName === "A" && (el as HTMLAnchorElement).href) return false;
  return true;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export async function expandProfileSections(
  root: ParentNode = document
): Promise<{ clicked: number; timedOut: boolean }> {
  const started = Date.now();
  let clicked = 0;
  const seen = new WeakSet<Element>();

  while (clicked < MAX_CLICKS) {
    if (Date.now() - started > TIME_BUDGET_MS) {
      return { clicked, timedOut: true };
    }

    // Scoped to `main section` on purpose: never global navigation, never chrome
    // outside a profile section.
    const control = [...root.querySelectorAll("main section button, main section [role='button']")]
      .find((el) => !seen.has(el) && isExpandControl(el));
    if (!control) break;

    seen.add(control);
    try {
      (control as HTMLElement).click();
      clicked++;
    } catch {
      // A detached or disabled node — skip it and keep going.
    }
    await sleep(SETTLE_MS);
  }

  return { clicked, timedOut: false };
}
