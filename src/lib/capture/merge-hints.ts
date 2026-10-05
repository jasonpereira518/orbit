import type { CaptureParseHints } from "@/lib/ai";

/**
 * Combine the parse hints from two pieces of one capture: the first date and interaction
 * type win, and seed people are pooled and de-duplicated by email and name.
 *
 * Shared by the server, which merges across the files in one request, and the browser,
 * which merges across the requests of a capture sent in parts. The two have to agree, or
 * a note's hints would depend on how its files happened to be batched.
 */
export function mergeHints(base: CaptureParseHints, extra: CaptureParseHints): CaptureParseHints {
  const seedPeople = [...(base.seedPeople || []), ...(extra.seedPeople || [])];
  const seen = new Set<string>();
  const deduped = seedPeople.filter((p) => {
    const key = `${(p.email || "").toLowerCase()}|${(p.name || "").toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return Boolean(p.name || p.email);
  });

  return {
    eventDate: base.eventDate || extra.eventDate || null,
    seedPeople: deduped.length ? deduped : undefined,
    interactionType: base.interactionType || extra.interactionType || null,
  };
}
