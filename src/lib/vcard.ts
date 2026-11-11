/**
 * Minimal vCard 3.0 writer for the public card download. Shares the escaping and 75-octet
 * folding with the iCalendar writer in `ics.ts`: both formats use the same RFC 5545-style
 * text escapes and the same CRLF line folding.
 */
import { escapeIcsText, foldLine } from "./ics";

export type VCardPerson = {
  fullName: string;
  firstName?: string | null;
  lastName?: string | null;
  org?: string | null;
  title?: string | null;
  email?: string | null;
  phone?: string | null;
  urls?: string[];
  note?: string | null;
};

const clean = (value?: string | null) => value?.trim() || null;

/** Splits on the last space, so "Mary Ann Lee" reads as first "Mary Ann", last "Lee". */
function splitName(fullName: string) {
  const name = fullName.trim();
  const at = name.lastIndexOf(" ");
  if (at < 0) return { first: name, last: "" };
  return { first: name.slice(0, at).trim(), last: name.slice(at + 1) };
}

export function buildVCard(p: VCardPerson): string {
  const hasParts = clean(p.firstName) || clean(p.lastName);
  const name = hasParts
    ? { first: clean(p.firstName) ?? "", last: clean(p.lastName) ?? "" }
    : splitName(p.fullName);

  const lines: string[] = ["BEGIN:VCARD", "VERSION:3.0"];
  lines.push(`N:${escapeIcsText(name.last)};${escapeIcsText(name.first)};;;`);
  lines.push(`FN:${escapeIcsText(p.fullName.trim())}`);

  const org = clean(p.org);
  if (org) lines.push(`ORG:${escapeIcsText(org)}`);
  const title = clean(p.title);
  if (title) lines.push(`TITLE:${escapeIcsText(title)}`);
  const email = clean(p.email);
  if (email) lines.push(`EMAIL;TYPE=INTERNET:${escapeIcsText(email)}`);
  const phone = clean(p.phone);
  if (phone) lines.push(`TEL;TYPE=CELL:${escapeIcsText(phone)}`);
  // URL is a URI value, not text, so commas and semicolons stay raw; only line breaks go.
  for (const url of p.urls ?? []) {
    const value = url.replace(/[\r\n]+/g, "").trim();
    if (value) lines.push(`URL:${value}`);
  }
  const note = clean(p.note);
  if (note) lines.push(`NOTE:${escapeIcsText(note)}`);

  lines.push("END:VCARD");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

/** Download name: keeps letters, digits, spaces, dots, underscores and hyphens. */
export function vcardFileName(fullName: string) {
  const base = fullName.replace(/[^\p{L}\p{N} ._-]/gu, "").trim();
  return `${base || "contact"}.vcf`;
}
