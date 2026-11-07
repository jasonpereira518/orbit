/**
 * The per-tab analytics session id (`pv_sid`), shared by the page-view beacon and the waitlist
 * join form. Client-safe: no database, no framework, nothing that touches a cookie.
 *
 * The id lives in `sessionStorage` ONLY. It is a random per-tab uuid that dies with the tab
 * and is never sent to another origin; the waitlist form hands it to the join action so the
 * row can say "this signup came out of that visit" (`interest_list_signups.join_session_id`).
 * It is the same value `page_views.session_id` already carries, which is the whole point:
 * a link between two rows that already exist, not a new identifier.
 *
 * Every access is guarded. Storage is blocked in private modes and sandboxed frames, and the
 * form must work exactly as before there: no storage, no session, `null`.
 */

/** Neutral on purpose: storage keys are visible to anyone who opens devtools on the waitlist. */
export const PV_SESSION_KEY = "pv_sid";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The current tab's session id, or null when storage is unavailable or holds nothing usable. */
export function readPageviewSessionId(): string | null {
  try {
    const raw = window.sessionStorage.getItem(PV_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { id?: unknown } | null;
    return typeof parsed?.id === "string" && UUID.test(parsed.id) ? parsed.id : null;
  } catch {
    // Blocked storage, a bare id from before the idle timeout, or malformed JSON.
    return null;
  }
}
