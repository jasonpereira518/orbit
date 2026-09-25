/**
 * The line under the capture review's reminders that says what the date extractor threw
 * away. Pure and client-safe (a type import only), so the review component and
 * `scripts/smoke-capture-skipped-phrases.ts` share it.
 *
 * It quotes only `relativePhrases`, which `validateCommitments` records after proving each
 * phrase is in the note. It used to quote a fixed example, "in a fortnight", whatever the
 * note said — which read as Orbit inventing a phrase the user never wrote.
 */
import type { RejectedCounts } from "@/lib/date-commitment-extract";

const MAX_QUOTED = 3;

export function skippedNoteText(skipped: RejectedCounts | null | undefined): string | null {
  if (!skipped) return null;
  const parts: string[] = [];
  if (skipped.relative) {
    const quoted = (skipped.relativePhrases ?? [])
      .map((p) => p.trim())
      .filter(Boolean)
      .slice(0, MAX_QUOTED)
      .map((p) => `“${p}”`);
    const noun = skipped.relative === 1 ? "phrase" : "phrases";
    parts.push(`${skipped.relative} unrecognized ${noun}${quoted.length ? ` (${quoted.join(", ")})` : ""}`);
  }
  if (skipped.past) parts.push(`${skipped.past} past ${skipped.past === 1 ? "date" : "dates"}`);
  if (skipped.unverifiable) parts.push(`${skipped.unverifiable} unverified`);
  if (!parts.length) return null;
  return `Skipped ${parts.join(", ")}. Orbit only schedules dates it can verify or resolve with confidence.`;
}
