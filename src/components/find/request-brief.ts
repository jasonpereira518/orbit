import { UserFacingError } from "@/lib/errors";
import type { ResearchBrief } from "@/lib/web-research";

export type Brief<D extends ResearchBrief = ResearchBrief> = { key: string; dossier: D };

/**
 * A research request the server refused or could not finish.
 *
 * `status` is the HTTP code and `reason` the route's own word for it (`no_ai` on 402,
 * `rate_limited` on 429, `invalid` on 400), so a caller can tell a missing key from a spent
 * daily limit without reading the message. The message is written for the person either way.
 */
export class BriefError extends UserFacingError {
  readonly status: number;
  readonly reason: string | undefined;

  constructor(message: string, status: number, reason?: string) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

/**
 * POSTs to `/api/research` (a route, for its longer time limit than a server action's).
 *
 * `D` is the dossier the caller's `kind` returns; the route answers with exactly that shape.
 */
export async function requestBrief<D extends ResearchBrief = ResearchBrief>(
  body: Record<string, unknown>
): Promise<Brief<D>> {
  const res = await fetch("/api/research", {
    method: "POST",
    headers: { "content-type": "application/json", "x-orbit-research": "1" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as
    | (Brief<D> & { error?: string; reason?: string })
    | null;
  // The route's messages are written for the person (no anchor, today's limit, no AI key);
  // a plain Error would be swapped for the generic fallback by `friendlyError`.
  if (!res.ok || !data?.dossier) {
    throw new BriefError(
      data?.error || "The search didn’t finish — try again in a moment",
      res.status,
      data?.reason
    );
  }
  return { key: data.key, dossier: data.dossier };
}

/**
 * What the route keeps of `exclude`. This mirrors `MAX_EXCLUDED_NAMES` in `web-research.ts`,
 * which a client cannot import (that module reaches the database); sending more only risks the
 * route's body limit.
 */
const MAX_EXCLUDED_NAMES = 60;

/**
 * The names "Find more" asks the search to leave out. The route keeps the FIRST 60, so the
 * people on screen go first (they are what would otherwise come straight back), then the ones
 * the campaign already holds, newest first. Case-insensitive, blanks dropped, 60 at most.
 */
export function discoverExclusions(shown: string[], known: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of [...shown, ...known]) {
    const key = name.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(name.trim());
    if (out.length === MAX_EXCLUDED_NAMES) break;
  }
  return out;
}
