/**
 * Pure logic for the onboarding "About you" step: the closed answer sets, the own-LinkedIn
 * URL reader, and the two sentences composed from the taps. No DB, no React, no network, so
 * the server save path, the step UI and a `pure` smoke can all import it.
 */
import { linkedinSlug } from "@/lib/duplicates";
import { canonicalLinkedInUrl } from "@/lib/linkedin-paste";
import type { CareerProfile } from "@/db/schema";

export const AIM_KINDS = [
  "internship",
  "full_time",
  "switch_roles",
  "grow",
  "grad_school",
  "explore",
  "build",
] as const;
export type AimKind = (typeof AIM_KINDS)[number];

export const TIMELINES = ["this_term", "this_year", "no_rush"] as const;
export type Timeline = (typeof TIMELINES)[number];

export const FIELDS = ["product", "software", "finance", "consulting", "design", "research"] as const;
export type Field = (typeof FIELDS)[number];

export const AIM_LABELS: Record<AimKind, string> = {
  internship: "Internship",
  full_time: "Full-time job",
  switch_roles: "Switch roles",
  grow: "Grow where I am",
  grad_school: "Grad school or research",
  explore: "Explore a field",
  build: "Build something",
};

export const TIMELINE_LABELS: Record<Timeline, string> = {
  this_term: "This term",
  this_year: "This year",
  no_rush: "No rush",
};

export const FIELD_LABELS: Record<Field, string> = {
  product: "Product",
  software: "Software",
  finance: "Finance",
  consulting: "Consulting",
  design: "Design",
  research: "Research",
};

export const FIELD_ROLE_TITLE: Record<Field, string> = {
  product: "Product Manager",
  software: "Software Engineer",
  finance: "Financial Analyst",
  consulting: "Consultant",
  design: "Product Designer",
  research: "Research Scientist",
};

export function isJobHuntingAim(kind: AimKind): boolean {
  return kind === "internship" || kind === "full_time" || kind === "switch_roles";
}

export type AboutAnswers = {
  aim: AimKind | null;
  timeline: Timeline | null;
  field: Field | null;
  companies: string[];
  schools: string[];
  headline: string | null;
};

const HOST_RE = /^(?:https?:\/\/)?(?:[a-z0-9-]+\.)?linkedin\.com\/in\//i;

/** The person's own profile URL: only `linkedin.com/in/<slug>`, never a company or school page. */
export function parseOwnLinkedInUrl(
  raw: string
): { ok: true; url: string; slug: string } | { ok: false; message: string } {
  const text = raw.trim();
  const slug = HOST_RE.test(text) ? linkedinSlug(text) : "";
  if (!slug) {
    return { ok: false, message: "Paste the link to your own profile, like linkedin.com/in/your-name." };
  }
  return { ok: true, url: canonicalLinkedInUrl(slug), slug };
}

/** "at A", "at A or B", "at A, B, or C"; "" when none. */
function atCompanies(companies: string[]): string {
  const c = companies.map((x) => x.trim()).filter(Boolean);
  if (c.length === 0) return "";
  if (c.length === 1) return ` at ${c[0]}`;
  if (c.length === 2) return ` at ${c[0]} or ${c[1]}`;
  return ` at ${c.slice(0, -1).join(", ")}, or ${c[c.length - 1]}`;
}

const WHEN: Record<Timeline, string> = { this_term: " this term", this_year: " this year", no_rush: "" };

const GOAL: Record<AimKind, (f: string | null, at: string, when: string) => string> = {
  internship: (f, at, when) => `Land ${f ? `a ${f}` : "an"} internship${at}${when}`,
  full_time: (f, at, when) => `Land a ${f ? `${f} ` : "full-time "}role${at}${when}`,
  switch_roles: (f, at, when) => `Switch ${f ? `into ${f}` : "roles"}${at}${when}`,
  grow: (f, _at, when) => `Grow ${f ? `in ${f}` : "where I am"}${when}`,
  grad_school: (f, _at, when) => `Get into grad school${f ? ` for ${f}` : ""}${when}`,
  explore: (f) => (f ? `Explore ${f}` : "Explore what's out there"),
  build: (f, _at, when) => `Build something${f ? ` in ${f}` : ""}${when}`,
};

export function composeGoalSentence(a: AboutAnswers): string | null {
  if (!a.aim) return null;
  const field = a.field ? FIELD_LABELS[a.field].toLowerCase() : null;
  const when = a.timeline ? WHEN[a.timeline] : "";
  return `${GOAL[a.aim](field, atCompanies(a.companies), when)}.`;
}

const INTRO: Record<AimKind, (f: string | null) => string> = {
  internship: (f) => `aiming for ${f ? `${f} ` : ""}internships`,
  full_time: (f) => `aiming for ${f ? `${f} roles` : "a full-time role"}`,
  switch_roles: (f) => (f ? `switching into ${f}` : "switching roles"),
  grow: (f) => (f ? `growing in ${f}` : "growing where they are"),
  grad_school: (f) => `headed to grad school${f ? ` for ${f}` : ""}`,
  explore: (f) => (f ? `exploring ${f}` : "exploring options"),
  build: (f) => `building something${f ? ` in ${f}` : ""}`,
};

export function composeSelfIntro(a: AboutAnswers): string | null {
  const headline = a.headline?.trim() || null;
  const field = a.field ? FIELD_LABELS[a.field].toLowerCase() : null;
  const aim = a.aim ? INTRO[a.aim](field) : null;
  if (headline && aim) return `${headline}, ${aim}.`;
  if (headline) return `${headline}.`;
  if (aim) return `${aim[0].toUpperCase()}${aim.slice(1)}.`;
  return null;
}

/**
 * The plain-language search the weekly "People to meet" run hands to Find people, or null
 * when there is nothing to anchor on. Companies are capped at 3 so the sentence stays a
 * search, not a list.
 */
export function buildDiscoveryQuery(input: {
  aim: CareerProfile["aim"] | null;
  companies: string[];
  schools: string[];
}): string | null {
  const school = input.schools.map((s) => s.trim()).find(Boolean) ?? null;
  const field = input.aim?.field ? FIELD_LABELS[input.aim.field as Field].toLowerCase() : null;
  const at = atCompanies(input.companies.map((c) => c.trim()).filter(Boolean).slice(0, 3));
  const what = field ? ` working in ${field}${at}` : at ? ` working${at}` : "";
  if (school) return `${school} alumni${what}`;
  if (what) return `People${what}`;
  return null; // an aim alone is not searchable
}
