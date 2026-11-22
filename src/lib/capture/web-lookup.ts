/**
 * The review cards' web lookup: people a capture would add as NEW contacts are searched
 * for (`researchPerson`, the same cached, budgeted, confident-only research Find people
 * runs) and their EMPTY fields filled. The note's own words always win.
 *
 * Never the email address or its domain — the privacy page promises a name, a company and
 * what the notes say about them, nothing more.
 */
import type { BulkNotePersonPreview } from "@/lib/capture/types";
import { nameKey } from "@/lib/names/key";
import { linkedinSlug } from "@/lib/duplicates";
import { citedLinkedInUrl } from "@/lib/profile-match";
import { researchPerson, type PersonDossier, type PersonResearcher } from "@/lib/web-research";

const CONCURRENCY = 3;
const BUDGET_MS = 40_000;
/** One capture of a conference roster must not spend a month's searches. */
const MAX_LOOKUPS = 8;

/** A card that would create a contact: no target, and no candidate it would default to. */
export function wouldCreate(item: BulkNotePersonPreview): boolean {
  return !item.suggestedMergeId && (item.suggestedNew === true || item.duplicates.length === 0);
}

function subjectFor(item: BulkNotePersonPreview) {
  const p = item.parsed;
  const context = [p.role, p.met_at ? `met at ${p.met_at}` : null, p.location].filter(Boolean).join("; ");
  return {
    fullName: p.name,
    company: p.company,
    linkedinUrl: linkedinSlug(p.linkedin_url) ? p.linkedin_url : null,
    context: context || null,
  };
}

/** Fill the card's empty fields from a confident brief. Returns which fields it filled. */
export function fillFromDossier(item: BulkNotePersonPreview, dossier: PersonDossier): string[] {
  if (dossier.match !== "confident") return [];
  const p = item.parsed;
  const filled: string[] = [];
  const set = <K extends keyof typeof p>(field: K, value: (typeof p)[K] | null | undefined, label: string) => {
    if (value && !p[field]) {
      p[field] = value;
      filled.push(label);
    }
  };
  set("company", dossier.current?.organization, "company");
  set("role", dossier.current?.title, "role");
  set("location", dossier.location, "location");
  // A profile the search cited, and only when it cited exactly one: "the first LinkedIn page
  // cited" was often a namesake's when a common name brought up several (profile-match.ts).
  // The card is reviewed before anything is saved.
  const cited = [...new Set(dossier.sources.map((s) => linkedinSlug(s.url)).filter(Boolean))];
  const onlyProfile = cited.length === 1 ? `https://www.linkedin.com/in/${cited[0]}` : null;
  set("linkedin_url", citedLinkedInUrl(dossier.subject.linkedinUrl, dossier.sources) ?? onlyProfile, "LinkedIn");
  // "Priya" → "Priya Raman", never a different person's name: same first name, longer.
  const full = dossier.name?.trim();
  if (full && p.name) {
    const mine = nameKey(p.name).split(" ");
    const theirs = nameKey(full).split(" ");
    if (theirs.length > mine.length && theirs[0] === mine[0]) {
      p.name = full;
      filled.push("name");
    }
  }
  return filled;
}

export async function lookUpNewPeople(
  userId: string,
  items: BulkNotePersonPreview[],
  options: { researcher?: PersonResearcher; onProgress?: () => unknown } = {},
): Promise<void> {
  const queue = items.filter((i) => i.parsed.name && wouldCreate(i)).slice(0, MAX_LOOKUPS);
  if (!queue.length) return;
  const signal = AbortSignal.timeout(BUDGET_MS);
  let stop = false;

  const worker = async () => {
    for (let item = queue.shift(); item && !stop && !signal.aborted; item = queue.shift()) {
      const result = await researchPerson(userId, subjectFor(item), { researcher: options.researcher, signal }).catch(
        () => null,
      );
      await options.onProgress?.();
      if (!result) continue;
      if (!result.ok) {
        // Out of budget or no AI: every later lookup would be refused the same way.
        if (result.reason === "rate_limited" || result.reason === "no_ai") stop = true;
        continue;
      }
      const filled = fillFromDossier(item, result.dossier);
      if (filled.length || result.dossier.experiences.length) {
        item.web = { filled, sourceUrl: result.dossier.sources[0]?.url ?? null, key: result.key };
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}
