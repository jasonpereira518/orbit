import type { Contact } from "@/db/schema";

function normalize(s: string | null | undefined) {
  return (s || "").trim().toLowerCase();
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
    }
  }

  return matches.sort((a, b) => b.confidence - a.confidence);
}

export function daysAgo(date: Date | string | null | undefined) {
  if (!date) return Infinity;
  const d = typeof date === "string" ? new Date(date) : date;
  return Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
}
