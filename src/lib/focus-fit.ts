/**
 * How well a contact matches what the user does and what they are job-hunting for.
 *
 * The user's side comes from their LinkedIn export: skills (Skills.csv) and the job titles they
 * have alerts for (SavedJobAlerts.csv). Pure, 0..1, and deliberately NOT part of closeness:
 * closeness is how well you know someone and drives the constellation; this is "worth
 * reaching out to for what you are doing now" and only ever nudges a ranking.
 *
 * Why not reuse `goalRelevanceComponent`: it divides hits by the number of goals, so sixty skills
 * would dilute every goal, and it matches on any shared token, so "Project Management" would hit
 * on "project". Here each skill is judged on its own and the total is capped.
 *
 * ponytail: word-prefix matching on title and industry, no synonyms or embeddings. It misses
 * "SWE" for "Software Engineer" and over-matches generic words ("management"). Upgrade path: match
 * the contact's own LinkedIn skills (contact_profiles.skills) and use the embedding column.
 */

export type UserFocus = {
  skills: string[];
  /** Job titles from saved job alerts, e.g. "Software Engineer". */
  roleKeywords: string[];
  /** The role held now. Not scored; carried for the prompt block. */
  role?: { title: string; company: string } | null;
};

export type FocusContact = {
  title?: string | null;
  industry?: string | null;
  headline?: string | null;
};

const STOPWORDS = new Set(["and", "the", "for", "with", "of", "in", "to", "at", "a", "an", "or", "ai"]);

/** Titles on the hiring side of a job search. Only count while the user has job alerts. */
const RECRUITING_TITLE = /\b(recruit|talent|sourcer|sourcing|hiring|staffing|headhunt)/i;

const SKILL_HITS_CAP = 3;
const PREFIX = 5;

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9+#]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

/** Two words match when they share their first five letters (or are equal): manager ~ management. */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  const n = Math.min(PREFIX, a.length, b.length);
  return n >= 4 && a.slice(0, n) === b.slice(0, n);
}

/** A term hits when at least half its significant words appear in the contact's text. */
function termHits(term: string, haystack: string[]): boolean {
  const own = words(term);
  if (!own.length) return false;
  const matched = own.filter((w) => haystack.some((h) => sameWord(w, h))).length;
  return matched >= Math.ceil(own.length / 2);
}

export function focusFitComponent(contact: FocusContact, focus: UserFocus | null | undefined): number {
  if (!focus || (!focus.skills.length && !focus.roleKeywords.length)) return 0;

  const text = [contact.title, contact.headline, contact.industry].filter(Boolean).join(" ");
  if (!text.trim()) return 0;
  const haystack = words(text);
  if (!haystack.length) return 0;

  // Up to 0.6 for skills, each judged on its own and capped, so a long list cannot dilute and
  // a contact who matches everything cannot run away with the ranking.
  const skillHits = focus.skills.filter((s) => termHits(s, haystack)).length;
  let score = 0.6 * (Math.min(SKILL_HITS_CAP, skillHits) / SKILL_HITS_CAP);

  if (focus.roleKeywords.length) {
    // Someone in the role family you are looking at: a peer, or someone who can speak to it.
    if (focus.roleKeywords.some((k) => termHits(k, haystack))) score += 0.25;
    // And the people who actually place people, while you are searching.
    if (RECRUITING_TITLE.test(contact.title ?? "")) score += 0.15;
  }
  return Math.min(1, score);
}
