/**
 * Profile section readers.
 *
 * Pure functions over a `ParentNode` rather than reads off `document`, so
 * `scripts/smoke-contact-profile-format.ts` can drive them against saved markup. That test
 * is the only warning we get when LinkedIn ships a redesign.
 *
 * Every reader is independently fallible and returns what it managed. A section that
 * yields nothing sets `parseIncomplete`, which is the server's cue to spend a model call
 * — so a broken selector degrades into a slower, costlier capture rather than a wrong one.
 *
 * Selectors are listed most-specific first and fall back to structure. LinkedIn's
 * generated class names churn; `data-*` attributes and section anchors last longer.
 *
 * WRITTEN BLIND: as of this file's authorship no real rendered LinkedIn markup was
 * available to verify these selectors against (see scripts/fixtures/README, or the
 * PENDING banner in scripts/smoke-contact-profile-format.ts). Treat the selector names
 * in `sectionFor`, `entryNodes`, and `readEntry` as a best-effort first draft that a
 * human must confirm against a real page before this is trusted in production.
 */

import type { PageExperience, PageProfile } from "@contract";

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

export type ParsedDateRange = {
  startYear: number | null;
  startMonth: number | null;
  endYear: number | null;
  endMonth: number | null;
  isCurrent: boolean;
};

const EMPTY_RANGE: ParsedDateRange = {
  startYear: null,
  startMonth: null,
  endYear: null,
  endMonth: null,
  isCurrent: false,
};

/**
 * "Mar 2019 - Nov 2023 · 4 yrs 9 mos" -> parts.
 *
 * The trailing duration is ignored on purpose: it is derived from the same two dates, and
 * parsing it adds a second source of truth that can disagree with the first.
 */
export function parseDateRange(text: string): ParsedDateRange {
  const normalized = text.replace(/[–—]/g, "-").toLowerCase();
  const isCurrent = /\bpresent\b/.test(normalized);
  const stamps = [...normalized.matchAll(/([a-z]{3})[a-z]*\.?\s+(\d{4})|(\d{4})/g)].map((m) => {
    if (m[3]) return { month: null as number | null, year: Number(m[3]) };
    return { month: MONTHS[m[1]] ?? null, year: Number(m[2]) };
  });
  if (!stamps.length) return EMPTY_RANGE;

  const [start, end] = stamps;
  return {
    startYear: start?.year ?? null,
    startMonth: start?.month ?? null,
    endYear: isCurrent ? null : end?.year ?? null,
    endMonth: isCurrent ? null : end?.month ?? null,
    isCurrent,
  };
}

function textOf(node: Element | null | undefined): string {
  return (node?.textContent ?? "").replace(/\s+/g, " ").trim();
}

/**
 * LinkedIn renders each entry's visible text twice — once for sighted users and once in a
 * `.visually-hidden` span for screen readers. Taking the whole `textContent` therefore
 * doubles every string. Prefer the aria-hidden copy, which is the visible one.
 */
function visibleText(node: Element | null | undefined): string {
  if (!node) return "";
  const preferred = node.querySelector('[aria-hidden="true"]');
  return textOf(preferred ?? node);
}

function sectionFor(root: ParentNode, anchorId: string): Element | null {
  const anchor = root.querySelector(`#${anchorId}`);
  return anchor?.closest("section") ?? root.querySelector(`section[data-section="${anchorId}"]`);
}

function entryNodes(section: Element | null): Element[] {
  if (!section) return [];
  const items = section.querySelectorAll("li.artdeco-list__item, li.pvs-list__paged-list-item");
  return [...items];
}

function readEntry(node: Element, kind: PageExperience["kind"]): PageExperience | null {
  const lines = [...node.querySelectorAll("span, div")]
    .map(visibleText)
    .filter((t) => t.length > 0);
  const unique = [...new Set(lines)];
  if (!unique.length) return null;

  const dateLine = unique.find((l) => /\b(19|20)\d{2}\b/.test(l) || /present/i.test(l)) ?? "";
  const range = dateLine ? parseDateRange(dateLine) : EMPTY_RANGE;
  const nonDate = unique.filter((l) => l !== dateLine);

  // The first two meaningful lines are the entry's own heading pair. For a role that is
  // title then employer; for a school it is the school then the degree.
  const [first, second] = nonDate;
  const organization = (kind === "role" ? second : first)?.split(" · ")[0]?.trim() ?? "";
  if (!organization) return null;

  // Pulled out of the remainder before it becomes the description, so a location line
  // sitting at index >= 2 isn't also concatenated into the description text.
  const location = nonDate.find((l) => /,\s*[A-Z]{2}\b|Remote/.test(l)) ?? null;
  const rest = nonDate.slice(2).filter((l) => l !== location);

  return {
    kind,
    organization,
    title: (kind === "role" ? first : second)?.trim() || null,
    fieldOfStudy: null,
    location,
    description: rest.join(" ").slice(0, 2000) || null,
    ...range,
  };
}

function readList(root: ParentNode, anchorId: string, kind: PageExperience["kind"]): PageExperience[] {
  const section = sectionFor(root, anchorId);
  return entryNodes(section)
    .map((node) => readEntry(node, kind))
    .filter((e): e is PageExperience => e !== null);
}

function readNames(root: ParentNode, anchorId: string, max: number): string[] {
  const section = sectionFor(root, anchorId);
  return entryNodes(section)
    .map((node) => visibleText(node.querySelector("span, div")))
    .filter((t) => t.length > 0)
    .slice(0, max);
}

export function readProfileSections(root: ParentNode): PageProfile {
  const roles = readList(root, "experience", "role");
  const education = readList(root, "education", "education");
  const experiences = [...roles, ...education];

  const about = visibleText(sectionFor(root, "about")?.querySelector(".display-flex") ?? null) || null;
  const headline = visibleText(root.querySelector(".text-body-medium")) || null;

  const skills = readNames(root, "skills", 60).map((name) => ({ name }));
  const certifications = readNames(root, "licenses_and_certifications", 40).map((name) => ({
    name,
    issuer: null,
    year: null,
  }));
  const volunteering = readNames(root, "volunteering_experience", 30).map((organization) => ({
    organization,
    role: null,
    years: null,
  }));
  const publications = readNames(root, "publications", 30).map((title) => ({
    title,
    publisher: null,
    year: null,
  }));

  return {
    headline,
    about,
    skills,
    certifications,
    volunteering,
    publications,
    experiences,
    // The single condition the server acts on. Anything else read or not, no roles at all
    // means the page told us nothing worth storing.
    parseIncomplete: experiences.length === 0,
  };
}
