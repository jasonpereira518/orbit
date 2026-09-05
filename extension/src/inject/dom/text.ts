/**
 * Turning a rendered page into a text blob worth sending.
 *
 * A raw LinkedIn `main` innerText runs 20-50KB and is mostly other people —
 * "People also viewed", "Others named", recommendations, comment threads. That
 * is three problems at once: token cost, sending third parties' data to a
 * model, and a Chrome Web Store disclosure we'd rather not have to make. So the
 * cleaner is not a nicety, it's part of the contract.
 */

/** Sections whose heading means "this is about other people, not the subject". */
const HEADING_DENYLIST = [
  "people also viewed",
  "more profiles for you",
  "people you may know",
  "others named",
  "others viewed",
  "explore premium",
  "promoted",
  "recommended for you",
  "similar profiles",
  "you might like",
];

const STRIP_SELECTORS = [
  "nav",
  "header",
  "footer",
  "aside",
  "script",
  "style",
  "noscript",
  "svg",
  "[role='navigation']",
  "[role='banner']",
  "[role='contentinfo']",
  "[aria-hidden='true']",
];

/**
 * The primary defense against LinkedIn's duplicated text.
 *
 * LinkedIn renders nearly every field twice — once visible, once for screen
 * readers — so raw text is full of `"Kim Nguyen\nKim Nguyen"`. Note that
 * innerText does NOT save us here: measured in a real browser, it correctly
 * drops `display:none` content but still returns clip-rect screen-reader text,
 * which is precisely the pattern LinkedIn uses. So this line-level dedupe is
 * what actually does the work, and unlike filtering on `.visually-hidden` it
 * doesn't break when they rename a class.
 */
export function collapseRepeatedLines(text: string): string {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) {
      if (out.length && out[out.length - 1] !== "") out.push("");
      continue;
    }
    if (out.length && out[out.length - 1] === line) continue;
    out.push(line);
  }
  return out.join("\n");
}

/**
 * Sections introduced by a denylisted heading, matched on heading *text* rather
 * than a selector — LinkedIn renames classes constantly but "People also
 * viewed" has read the same for years.
 */
function denylistedSections(root: HTMLElement): Element[] {
  const out: Element[] = [];
  const headings = root.querySelectorAll("h1, h2, h3, h4, [role='heading']");
  for (const heading of Array.from(headings)) {
    const label = (heading.textContent ?? "").trim().toLowerCase();
    if (!label) continue;
    if (!HEADING_DENYLIST.some((entry) => label.includes(entry))) continue;
    // Skip the whole section the heading introduces, not just the heading.
    out.push(
      heading.closest("section, article, [data-view-name], li") ?? heading
    );
  }
  return out;
}

export type CleanTextResult = {
  blob: string;
  truncated: boolean;
  charCount: number;
};

/**
 * Extract readable text from a subtree.
 *
 * innerText rather than textContent: it respects layout, so `display:none`
 * content stays out and line breaks survive. It does not exclude clip-rect
 * screen-reader text — `collapseRepeatedLines` handles that.
 */
export function cleanText(
  element: Element | null,
  maxChars: number
): CleanTextResult {
  if (!element) return { blob: "", truncated: false, charCount: 0 };
  const root = element as HTMLElement;

  // Read innerText from the LIVE element, never a clone.
  //
  // A detached clone has no layout, so innerText silently degrades to
  // textContent \u2014 which pulls back in exactly the CSS-hidden duplicate spans
  // that using innerText was meant to exclude. Measured on a real page, the
  // clone approach produced *more* text than the untouched original.
  //
  // So instead of removing nodes from a copy, we mark which live nodes to skip
  // and read innerText from the surviving subtrees. Nothing on the user's page
  // is ever mutated.
  const skip = new Set<Element>();
  try {
    for (const node of Array.from(root.querySelectorAll(STRIP_SELECTORS.join(",")))) {
      skip.add(node);
    }
    for (const section of denylistedSections(root)) {
      if (section !== root) skip.add(section);
    }
  } catch {
    // A hostile or exotic DOM shouldn't cost us the whole extraction.
  }

  const parts: string[] = [];
  const collect = (node: HTMLElement, depth: number) => {
    if (skip.has(node)) return;
    const containsSkipped =
      depth < 6 && [...skip].some((s) => s !== node && node.contains(s));
    if (!containsSkipped || node.children.length === 0) {
      parts.push(node.innerText ?? node.textContent ?? "");
      return;
    }
    for (const child of Array.from(node.children)) {
      collect(child as HTMLElement, depth + 1);
    }
  };

  try {
    collect(root, 0);
  } catch {
    parts.push(root.innerText ?? "");
  }

  const collapsed = collapseRepeatedLines(parts.join("\n"))
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const truncated = collapsed.length > maxChars;
  return {
    blob: truncated ? collapsed.slice(0, maxChars) : collapsed,
    truncated,
    charCount: collapsed.length,
  };
}

/** The user's current selection, when they've highlighted something. */
export function selectionText(maxChars: number): CleanTextResult | null {
  try {
    const selection = window.getSelection?.()?.toString().trim();
    if (!selection || selection.length < 20) return null;
    const collapsed = collapseRepeatedLines(selection).trim();
    const truncated = collapsed.length > maxChars;
    return {
      blob: truncated ? collapsed.slice(0, maxChars) : collapsed,
      truncated,
      charCount: collapsed.length,
    };
  } catch {
    return null;
  }
}
