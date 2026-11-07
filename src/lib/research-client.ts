import { UserFacingError } from "@/lib/errors";
import type { ResearchBrief } from "@/lib/web-research";

export type Brief = { key: string; dossier: ResearchBrief };

/** A LinkedIn profile page is the strongest anchor a brief can get. The server re-checks it. */
export export const LINKEDIN_PROFILE = /^https?:\/\/([a-z]{2,3}\.)?linkedin\.com\/in\/[^/?#\s]+\/?$/i;

/** POSTs to `/api/research` (a route, for its longer time limit than a server action's). */
export export async function requestBrief(body: Record<string, unknown>): Promise<Brief> {
  const res = await fetch("/api/research", {
    method: "POST",
    headers: { "content-type": "application/json", "x-orbit-research": "1" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as (Brief & { error?: string }) | null;
  // The route's messages are written for the person (no anchor, today's limit, no AI key);
  // a plain Error would be swapped for the generic fallback by `friendlyError`.
  if (!res.ok || !data?.dossier) {
    if (data?.error) throw new UserFacingError(data.error);
    throw new Error("The search didn’t finish — try again in a moment");
  }
  return { key: data.key, dossier: data.dossier };
}
