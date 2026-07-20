import type { Contact } from "@/db/schema";

function normalize(s: string | null | undefined) {
  return (s || "").trim().toLowerCase();
}

/** Strip punctuation/accents-ish noise for fuzzy name compares. */
function normalizeName(s: string | null | undefined) {
  return normalize(s)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshtein(a: string, b: string) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Array(b.length + 1);
  const curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

/** 0–1 similarity from edit distance; short names need near-exact match. */
export function nameSimilarity(a: string | null | undefined, b: string | null | undefined) {
  const left = normalizeName(a);
  const right = normalizeName(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  const maxLen = Math.max(left.length, right.length);
  if (maxLen < 4) return 0;
  const distance = levenshtein(left, right);
  return Math.max(0, 1 - distance / maxLen);
}

export function linkedinSlug(url: string | null | undefined) {
  if (!url) return "";
  const match = url.match(/linkedin\.com\/in\/([^/?#]+)/i);
  return match ? match[1].toLowerCase() : normalize(url);
}

export type DuplicateMatch = {
  contact: Contact;
  reason: string;
  confidence: number;
};

export function findDuplicateCandidates(
  existing: Contact[],
  incoming: {
    fullName?: string | null;
    email?: string | null;
    linkedinUrl?: string | null;
    company?: string | null;
    title?: string | null;
  }
): DuplicateMatch[] {
  const matches: DuplicateMatch[] = [];
  const name = normalize(incoming.fullName);
  const email = normalize(incoming.email);
  const linkedin = linkedinSlug(incoming.linkedinUrl);
  const company = normalize(incoming.company);
  const title = normalize(incoming.title);

  for (const contact of existing) {
    if (linkedin && linkedinSlug(contact.linkedinUrl) === linkedin) {
      matches.push({ contact, reason: "Same LinkedIn URL", confidence: 0.98 });
      continue;
    }
    if (email && normalize(contact.email) === email) {
      matches.push({ contact, reason: "Same email", confidence: 0.95 });
      continue;
    }
    if (
      name &&
      normalize(contact.fullName) === name &&
      company &&
      normalize(contact.company) === company
    ) {
      matches.push({ contact, reason: "Same name + company", confidence: 0.9 });
      continue;
    }
    if (
      name &&
      normalize(contact.fullName) === name &&
      title &&
      normalize(contact.title) === title
    ) {
      matches.push({ contact, reason: "Same name + title", confidence: 0.85 });
      continue;
    }
    if (name && normalize(contact.fullName) === name) {
      matches.push({ contact, reason: "Same full name", confidence: 0.6 });
      continue;
    }

    // Fuzzy name: only when company or title also aligns (avoids false merges).
    const fuzzy = nameSimilarity(incoming.fullName, contact.fullName);
    if (fuzzy >= 0.88) {
      const sameCompany =
        company && company === normalize(contact.company);
      const sameTitle = title && title === normalize(contact.title);
      if (sameCompany) {
        matches.push({
          contact,
          reason: "Similar name + company",
          confidence: 0.87,
        });
      } else if (sameTitle) {
        matches.push({
          contact,
          reason: "Similar name + title",
          confidence: 0.85,
        });
      }
    }
  }

  return matches.sort((a, b) => b.confidence - a.confidence);
}

export function daysAgo(date: Date | string | null | undefined) {
  if (!date) return Infinity;
  const d = typeof date === "string" ? new Date(date) : date;
  return Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
}
