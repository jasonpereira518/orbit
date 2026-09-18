import { requireUserId } from "@/lib/auth";
import { reportError, reportedFailure, type ReportLevel } from "@/lib/report-error";

/**
 * The two calls a Server Action's catch block makes instead of swallowing its error.
 *
 * An action that returns `{ ok: false, error }` answers the browser with a 200: nothing in
 * the network tab, nothing in Sentry, and the only trace a `console.error` that Vercel keeps
 * for an hour. These report the real error (with the account id) and hand back copy that
 * carries a reference the person can quote.
 *
 * The account id is re-read here because most actions resolve it inside the `try` whose
 * `catch` this is. `requireUserId` is request-cached, so this costs nothing when the
 * failure came later; when auth itself was what failed it answers null.
 */

async function currentUserId(): Promise<string | null> {
  try {
    return await requireUserId();
  } catch {
    return null;
  }
}

/** Copy for a failure returned as data: `fallback` plus a reference, or the person's own fix. */
export async function actionFailure(
  err: unknown,
  fallback: string,
  where: string,
  extra?: Record<string, unknown>
): Promise<string> {
  const userId = await currentUserId();
  return reportedFailure(err, fallback, { where: `action.${where}`, userId, extra }).error;
}

/** Report only, for a catch whose returned copy is already deliberate. Returns the reference. */
export async function reportActionError(
  err: unknown,
  where: string,
  opts: { extra?: Record<string, unknown>; level?: ReportLevel } = {}
): Promise<string> {
  const userId = await currentUserId();
  return reportError(err, { where: `action.${where}`, userId, extra: opts.extra, level: opts.level });
}
