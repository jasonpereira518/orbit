/**
 * "Autofill with AI": which of a contact's EMPTY fields a confident web-research brief can
 * fill. Shared by the form button and the bulk fill so both follow one rule: a field the
 * person already has is never overwritten, and an unsure or empty brief fills nothing.
 *
 * Never the email, its domain, or a phone number: the privacy page promises research a name,
 * a company and what the notes say, nothing more (same rule as `capture/web-lookup.ts`).
 */
import { linkedinSlug } from "@/lib/duplicates";
import type { PersonDossier } from "@/lib/web-research";

export type AiFillField = "title" | "company" | "location" | "school" | "linkedinUrl";
export type AiFillFields = Partial<Record<AiFillField, string>>;
export type AiFillCurrent = Partial<Record<AiFillField, string | null | undefined>>;

export function aiFillFields(current: AiFillCurrent, dossier: PersonDossier): AiFillFields {
  if (dossier.match !== "confident") return {};
  const out: AiFillFields = {};
  const set = (field: AiFillField, value: string | null | undefined) => {
    const v = value?.trim();
    if (v && !current[field]?.trim()) out[field] = v;
  };
  set("company", dossier.current?.organization);
  set("title", dossier.current?.title);
  set("location", dossier.location);
  set("school", dossier.experiences.find((e) => e.kind === "education")?.organization);
  set("linkedinUrl", dossier.subject.linkedinUrl ?? dossier.sources.find((s) => linkedinSlug(s.url))?.url);
  return out;
}

export const AI_FILL_LABELS: Record<AiFillField, string> = {
  title: "role",
  company: "company",
  location: "location",
  school: "school",
  linkedinUrl: "LinkedIn",
};

/** Contacts researched per request: web search is slow and each one is paid for. */
export const AI_FILL_BATCH_SIZE = 3;
