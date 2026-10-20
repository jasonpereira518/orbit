import { canonicalizeEventUrl } from "@/lib/events/canonical-url";
import { UserFacingError } from "@/lib/errors";

/**
 * A link a person typed into an event ("Add event", or editing one): its canonical form,
 * `null` for none, or a `UserFacingError` carrying the canonicaliser's own sentence
 * ("Event links must be http or https.").
 *
 * Refusing is the point (audit L-02). Both actions used to fall back to the text as typed
 * when canonicalisation failed, which is how a `javascript:` or private-network URL was
 * stored and rendered back as the event page's link.
 */
export function canonicalEventUrlOrRefuse(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const outcome = canonicalizeEventUrl(raw);
  if (outcome.kind !== "ok") throw new UserFacingError(outcome.message);
  return outcome.candidates[0]!;
}
