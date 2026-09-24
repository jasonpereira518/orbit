/**
 * Turn a real, rendered page into a fixture that is safe to commit.
 *
 * Why this exists: the LinkedIn work-history readers were reverted (68fff0df)
 * because their selectors had never run against real rendered markup — the
 * fixtures they were tested on were written by hand from memory. Real markup
 * only exists in a signed-in browser, and a signed-in LinkedIn page is full of
 * other people. So the fixture saver captures the real DOM and this module
 * makes it fit for a public repository.
 *
 * What it guarantees, mechanically:
 *   - no scripts (except JSON-LD, which adapters read), styles, frames, media
 *   - no attributes the adapters don't read (tracking ids, inline handlers)
 *   - every LinkedIn slug, X handle, email and phone number replaced, and
 *     every person it can identify renamed to a pseudonym — CONSISTENTLY, so
 *     the page still reads the same way to an adapter, just about someone else
 *   - long prose (bios, posts, messages) scrambled letter-for-letter, keeping
 *     its shape so text-cleaning code sees realistic lengths
 *   - a final leak check: if any real value it collected survives anywhere in
 *     the output, it refuses to produce a file at all
 *
 * What it cannot guarantee: names it had no way to identify. It learns names
 * from the adapter's own reading of the page and from every link to a profile;
 * a name in plain text with no link is invisible to it. A person reviews every
 * fixture before it is committed — this makes that review short, not optional.
 */
import { isLikelyPersonName } from "@/inject/dom/names";
import { isReservedXPath, xHandle } from "@/inject/dom/url";

/** Pseudonyms that pass `isLikelyPersonName`, so name heuristics still fire. */
const NAME_POOL = [
  "Avery Quill",
  "Blake Harrow",
  "Casey Linden",
  "Drew Maddox",
  "Emery Stone",
  "Finley Rowe",
  "Gray Hollis",
  "Harper Venn",
  "Indigo Marsh",
  "Jules Arden",
  "Kendall Pike",
  "Logan Sayer",
  "Morgan Tate",
  "Noel Bracken",
  "Oakley Fenn",
  "Parker Lowe",
  "Quinn Ashby",
  "Reese Calder",
  "Sage Whitlow",
  "Taylor Brook",
];

const PROSE_MIN_CHARS = 120;
const REMOVE_ELEMENTS =
  "style, noscript, iframe, frame, svg, canvas, video, audio, template, object, embed, picture source, base";
const KEEP_META = /^(og:|twitter:|description$|hovercard-subject-tag$)/i;
const KEEP_ATTRS = new Set([
  "class",
  "id",
  "href",
  "src",
  "alt",
  "title",
  "role",
  "aria-label",
  "aria-hidden",
  "itemprop",
  "itemtype",
  "itemscope",
  "data-testid",
  "data-bio-text",
  "email",
  "name",
  "content",
  "property",
  "rel",
  "type",
  "width",
  "height",
  "datetime",
  "lang",
  "dir",
]);
/** Attributes whose *text* can carry a name or an address. */
const TEXT_ATTRS = ["alt", "title", "aria-label", "content", "email"];

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const LINKEDIN_IN = /(linkedin\.com\/in\/)([^/?#"'\s<>]+)/gi;
const X_PROFILE =
  /((?:^|\/\/|\.)(?:x|twitter)\.com\/)(?:#!\/)?@?([A-Za-z0-9_]{1,15})(?=[/?#"'\s<>]|$)/gi;
const PHONE_LIKE = /\+?\d[\d\s().-]{7,}\d/g;

export type SanitizeReport = {
  people: number;
  slugs: number;
  handles: number;
  emails: number;
  phones: number;
  proseBlocks: number;
  removedElements: number;
};

export type SanitizeResult =
  | { ok: true; html: string; url: string; report: SanitizeReport }
  | { ok: false; leaks: string[] };

type Known = {
  /** The page's own URL — mapped too, so the fixture records where it "lives". */
  url: string;
  /** People the adapter already recognized: the subject, list candidates. */
  names: Array<string | null | undefined>;
};

class Pseudonyms {
  readonly names = new Map<string, string>();
  readonly slugs = new Map<string, string>();
  readonly handles = new Map<string, string>();
  readonly emails = new Map<string, string>();
  phones = 0;

  name(real: string): string {
    const key = real.trim().toLowerCase();
    let fake = this.names.get(key);
    if (!fake) {
      fake = NAME_POOL[this.names.size % NAME_POOL.length];
      // Past the pool, keep names distinct AND name-shaped (letters only).
      const lap = Math.floor(this.names.size / NAME_POOL.length);
      if (lap > 0) fake = `${fake}-${"abcdefghij"[lap % 10]}`;
      this.names.set(key, fake);
    }
    return fake;
  }

  slug(real: string): string {
    const key = real.toLowerCase();
    let fake = this.slugs.get(key);
    if (!fake) {
      fake = `person-${this.slugs.size + 1}`;
      this.slugs.set(key, fake);
    }
    return fake;
  }

  handle(real: string): string {
    const key = real.toLowerCase();
    let fake = this.handles.get(key);
    if (!fake) {
      fake = `xuser${this.handles.size + 1}`;
      this.handles.set(key, fake);
    }
    return fake;
  }

  email(real: string): string {
    const key = real.toLowerCase();
    let fake = this.emails.get(key);
    if (!fake) {
      fake = `person${this.emails.size + 1}@example.com`;
      this.emails.set(key, fake);
    }
    return fake;
  }
}

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Letters to x/X and digits to 0, keeping every length, space and mark. */
function scramble(text: string): string {
  return text
    .replace(/\p{Lu}/gu, "X")
    .replace(/\p{Ll}/gu, "x")
    .replace(/\p{L}/gu, "x")
    .replace(/\d/g, "0");
}

function rewriteText(text: string, p: Pseudonyms, nameRules: NameRule[]): string {
  let out = text
    .replace(EMAIL, (m) => p.email(m))
    .replace(LINKEDIN_IN, (_m, prefix: string, slug: string) => `${prefix}${p.slug(slug)}`)
    .replace(X_PROFILE, (m, prefix: string, handle: string) =>
      isReservedXPath(handle) ? m : `${prefix}${p.handle(handle)}`
    )
    .replace(PHONE_LIKE, (m) => {
      // A date range ("2019 - 2021") is phone-shaped; a phone has 9+ digits.
      if ((m.match(/\d/g) ?? []).length < 9) return m;
      p.phones++;
      return "+1 555 0100";
    });
  for (const rule of nameRules) out = out.replace(rule.pattern, rule.replacement);
  return out;
}

type NameRule = { pattern: RegExp; replacement: string };

/**
 * Full names first, then each name's own parts ("Message Amara" must not keep
 * "Amara"). Parts shorter than 3 letters are skipped: "Li" as a whole word
 * would scramble ordinary text for no privacy gain.
 */
function buildNameRules(p: Pseudonyms): NameRule[] {
  const full: NameRule[] = [];
  const parts: NameRule[] = [];
  const entries = [...p.names.entries()].sort((a, b) => b[0].length - a[0].length);
  for (const [real, fake] of entries) {
    full.push({
      // Not `\\b`: it is ASCII-only even under the `u` flag, so a name ending
      // in "é" would never match and the real name would survive.
      pattern: new RegExp(`(?<![\\p{L}])${escapeRegExp(real)}(?![\\p{L}])`, "giu"),
      replacement: fake,
    });
    const realParts = real.split(/\s+/);
    const fakeParts = fake.split(/\s+/);
    realParts.forEach((part, i) => {
      if (part.length < 3) return;
      parts.push({
        pattern: new RegExp(`(?<![\\p{L}])${escapeRegExp(part)}(?![\\p{L}])`, "giu"),
        replacement: fakeParts[Math.min(i, fakeParts.length - 1)],
      });
    });
  }
  return [...full, ...parts];
}

function scrambleJsonStrings(value: unknown, rewrite: (s: string) => string): unknown {
  if (typeof value === "string") {
    const rewritten = rewrite(value);
    return rewritten.length >= PROSE_MIN_CHARS ? scramble(rewritten) : rewritten;
  }
  if (Array.isArray(value)) return value.map((v) => scrambleJsonStrings(v, rewrite));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, scrambleJsonStrings(v, rewrite)])
    );
  }
  return value;
}

function canonicalHref(
  raw: string,
  base: string,
  rewrite: (s: string) => string
): string {
  // Query strings and fragments are where tracking ids live — LinkedIn's
  // `miniProfileUrn` carries another member's internal id. Adapters never need
  // them, so every URL keeps only origin and path.
  if (/^mailto:/i.test(raw)) return rewrite(raw.replace(/\?.*$/, ""));
  try {
    const url = new URL(raw, base);
    return rewrite(`${url.origin}${url.pathname}`);
  } catch {
    return rewrite(raw);
  }
}

export function sanitizeFixture(html: string, known: Known): SanitizeResult {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const p = new Pseudonyms();
  const report: SanitizeReport = {
    people: 0,
    slugs: 0,
    handles: 0,
    emails: 0,
    phones: 0,
    proseBlocks: 0,
    removedElements: 0,
  };

  /* 1. Structure: drop everything no adapter reads. */
  const drop = (el: Element) => {
    el.remove();
    report.removedElements++;
  };
  doc.querySelectorAll(REMOVE_ELEMENTS).forEach(drop);
  doc.querySelectorAll("script").forEach((el) => {
    if (el.getAttribute("type") !== "application/ld+json") drop(el);
  });
  doc.querySelectorAll("link").forEach((el) => {
    if (el.getAttribute("rel") !== "canonical") drop(el);
  });
  doc.querySelectorAll("meta").forEach((el) => {
    const key = el.getAttribute("property") ?? el.getAttribute("name") ?? "";
    if (el.getAttribute("charset") === null && !KEEP_META.test(key)) drop(el);
  });
  const comments = doc.createTreeWalker(doc, 128 /* NodeFilter.SHOW_COMMENT */);
  const deadComments: Node[] = [];
  while (comments.nextNode()) deadComments.push(comments.currentNode);
  deadComments.forEach((node) => node.parentNode?.removeChild(node));

  for (const el of doc.querySelectorAll("*")) {
    for (const attr of [...el.attributes]) {
      if (!KEEP_ATTRS.has(attr.name)) el.removeAttribute(attr.name);
    }
  }

  /* 2. Learn every person before rewriting anyone, so replacement is global. */
  for (const name of known.names) if (name && isLikelyPersonName(name)) p.name(name);
  for (const a of doc.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href") ?? "";
    const isProfile =
      /linkedin\.com\/in\//i.test(href) ||
      /^\/in\//.test(href) ||
      (/(?:x|twitter)\.com\//i.test(href) && Boolean(xHandle(href)));
    if (!isProfile) continue;
    for (const candidate of [
      a.textContent,
      a.getAttribute("aria-label"),
      a.querySelector("img")?.getAttribute("alt"),
    ]) {
      const text = candidate?.replace(/\s+/g, " ").trim();
      if (text && isLikelyPersonName(text)) p.name(text);
    }
  }
  // Seed the subject's own identifiers first, so the subject is always
  // person-1 / xuser1 regardless of what the page links to first.
  known.url.replace(LINKEDIN_IN, (m, _prefix: string, slug: string) => {
    p.slug(slug);
    return m;
  });

  // Record the originals now: the leak check runs against these.
  // A surviving first name alone is still a leak ("Message Amara"), so each
  // name's parts count too — above 3 letters, where a match is meaningful.
  const namePart = new Set<string>();
  const secretsOf = () => {
    for (const real of p.names.keys()) {
      for (const part of real.split(/\s+/)) if (part.length > 3) namePart.add(part);
    }
    return [
      ...p.names.keys(),
      ...namePart,
      ...p.slugs.keys(),
      ...p.handles.keys(),
      ...p.emails.keys(),
    ];
  };

  const nameRules = buildNameRules(p);
  const rewrite = (s: string) => rewriteText(s, p, nameRules);

  /* 3. Rewrite attributes. */
  for (const el of doc.querySelectorAll("*")) {
    const href = el.getAttribute("href");
    if (href) el.setAttribute("href", canonicalHref(href, known.url, rewrite));
    const src = el.getAttribute("src");
    if (src) {
      // Keep the host family: LinkedIn's photo reader matches media.licdn.com.
      el.setAttribute(
        "src",
        /licdn\.com/i.test(src)
          ? "https://media.licdn.com/fixture/image.jpg"
          : "https://example.com/fixture/image.jpg"
      );
    }
    for (const name of TEXT_ATTRS) {
      const value = el.getAttribute(name);
      if (value === null) continue;
      const isImageMeta =
        el.tagName === "META" && /image/i.test(el.getAttribute("property") ?? "");
      el.setAttribute(
        name,
        isImageMeta ? "https://media.licdn.com/fixture/image.jpg" : rewrite(value)
      );
    }
  }

  /* 4. Rewrite text: JSON-LD structurally, everything else by node. */
  for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const data = JSON.parse(script.textContent ?? "null");
      script.textContent = JSON.stringify(scrambleJsonStrings(data, rewrite));
    } catch {
      script.remove();
    }
  }
  const texts = doc.createTreeWalker(doc, 4 /* NodeFilter.SHOW_TEXT */);
  const textNodes: Text[] = [];
  while (texts.nextNode()) textNodes.push(texts.currentNode as Text);
  for (const node of textNodes) {
    if (node.parentElement?.tagName === "SCRIPT") continue;
    const rewritten = rewrite(node.data);
    if (rewritten.trim().length >= PROSE_MIN_CHARS) {
      node.data = scramble(rewritten);
      report.proseBlocks++;
    } else {
      node.data = rewritten;
    }
  }
  // `document.title` is a text node too, but rewrite it explicitly in case the
  // parser kept it outside the walk.
  if (doc.title) doc.title = rewrite(doc.title);

  report.people = p.names.size;
  report.slugs = p.slugs.size;
  report.handles = p.handles.size;
  report.emails = p.emails.size;
  report.phones = p.phones;

  const url = rewrite(known.url.replace(/[?#].*$/, ""));
  const body = `<!doctype html>\n${doc.documentElement.outerHTML}`;

  /* 5. Refuse, rather than trust, if anything it knew about survived. */
  const haystack = body.toLowerCase();
  const leaks = secretsOf().filter((secret) => {
    if (secret.length < 3) return false;
    // Bounded by letters and digits ONLY. Treating "-" as part of a word let
    // `member-amara-osei` hide a slug from this check — and the leak check is
    // the one place that must err toward refusing.
    return new RegExp(`(?<![\\p{L}\\d])${escapeRegExp(secret)}(?![\\p{L}\\d])`, "iu").test(
      haystack
    );
  });
  if (leaks.length) {
    // Deliberately report *kinds*, never the values: this goes on screen.
    return {
      ok: false,
      leaks: leaks.map((secret) =>
        p.emails.has(secret)
          ? "an email address"
          : p.slugs.has(secret)
            ? "a LinkedIn profile address"
            : p.handles.has(secret)
              ? "an X handle"
              : namePart.has(secret)
                ? "part of a person's name"
                : "a person's name"
      ),
    };
  }

  const header = `<!-- orbit-fixture: sanitized; url="${url}"; people=${report.people}; review before committing -->\n`;
  return { ok: true, html: header + body, url, report };
}
