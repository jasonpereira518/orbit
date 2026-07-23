/**
 * Fingerprint of contact fields that should trigger AI summary regeneration
 * when they change significantly.
 */

export function personSummaryFingerprint(input: {
  fullName?: string | null;
  preferredName?: string | null;
  title?: string | null;
  company?: string | null;
  industry?: string | null;
  howMet?: string | null;
  metContext?: string | null;
  notes?: string | null;
  keyFacts?: string[] | null;
  sharedInterests?: string[] | null;
  interactionCount?: number;
  latestInteractionId?: string | null;
}): string {
  return [
    input.fullName?.trim() || "",
    input.preferredName?.trim() || "",
    input.title?.trim() || "",
    input.company?.trim() || "",
    input.industry?.trim() || "",
    input.howMet?.trim() || "",
    input.metContext?.trim() || "",
    (input.notes || "").trim().slice(0, 400),
    (input.keyFacts || []).join("|"),
    (input.sharedInterests || []).join("|"),
    String(input.interactionCount ?? 0),
    input.latestInteractionId || "",
  ].join("\n");
}

/** True when core identity/relationship signal changed enough to warrant a refresh. */
export function isPersonSummaryStale(
  previous: string | null | undefined,
  next: string
): boolean {
  if (!previous) return true;
  return previous !== next;
}
