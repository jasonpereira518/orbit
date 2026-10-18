import { ReauthRequiredError, UserFacingError, classifyAiError } from "@/lib/errors";

/**
 * A stable machine code for a failure, safe to put in a `product_events` property
 * (`/^[a-z_]{1,32}$/`).
 *
 * NEVER derived from, or containing, the message: a provider body, a contact's name or a
 * note's text can all end up in an Error. The code comes from the error's TYPE or from the
 * closed `AiErrorKind` classification, and anything unrecognised is "unexpected". Add a
 * branch here, never a pass-through of text.
 */
export function eventErrorKind(err: unknown): string {
  if (err instanceof ReauthRequiredError) return "reauth_required";
  if (err instanceof UserFacingError) return "refused";
  const ai = classifyAiError(err);
  if (ai !== "other") return ai;
  const text = err instanceof Error ? `${err.name} ${err.message}` : "";
  if (/fetch failed|econnreset|econnrefused|enotfound|network|socket hang up|und_err/i.test(text)) return "network";
  return "unexpected";
}
