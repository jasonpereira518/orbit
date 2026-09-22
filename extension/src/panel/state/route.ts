/**
 * Which view the panel body shows — decided in one pure function.
 *
 * This used to be a ladder of `if`s inside App's render, where the ORDER of the
 * checks carried meaning nobody could see or test: that a signed-out user on a
 * readable page sees the sign-in prompt, that a stale offline record still
 * renders, that "add as new" outranks a known match. It is the same ladder here,
 * with each rung named and tested.
 *
 * Three states used to be dead ends — an unclicked tab (a hint), an unreadable
 * page (a notice), a page about nobody ("Nothing to add here"). They are all
 * Home now, with `reason` saying which: Home is useful beside any page.
 */
import type { MatchStatus } from "@contract";
import type { PageReadReason } from "@/lib/page";
import type { PanelPhase } from "./usePanel";

export type HomeReason =
  /** The tab hasn't been given to Orbit: click the icon to read it. */
  | "no-grant"
  /** A page Orbit can't read (browser pages, the Web Store, local files). */
  | "unreadable"
  /** A readable page that isn't about anyone Orbit can act on. */
  | "no-person";

export type Route =
  | { name: "signed-out" }
  | { name: "error" }
  | { name: "loading" }
  | { name: "home"; reason: HomeReason; detail: string | null; lostAccess: boolean }
  | { name: "people" }
  | { name: "company" }
  | { name: "known" }
  | { name: "ambiguous" }
  | { name: "new" };

export type RouteInput = {
  phase: PanelPhase;
  pageError: string | null;
  pageErrorReason: PageReadReason | null;
  resolving: boolean;
  hasPage: boolean;
  /** `isPersonPage(page)`: a profile, a thread, a post. */
  pageIsPerson: boolean;
  status: MatchStatus | null;
  hasContact: boolean;
  candidateCount: number;
  /** The user chose "no — add as new" on this page. */
  forceCreate: boolean;
  /** Offline, but holding this same page's last resolve: show it, dimmed. */
  staleOffline: boolean;
  /** People the page lists (search results, a team, a group thread). */
  listedPeople: number;
  /** The page is about an organization (`page.org`). */
  hasOrg: boolean;
};

export function deriveRoute(input: RouteInput): Route {
  if (input.phase === "signed-out") return { name: "signed-out" };

  if (input.phase === "needs-permission") {
    return { name: "home", reason: "no-grant", detail: null, lostAccess: false };
  }
  if (input.phase === "unsupported") {
    return {
      name: "home",
      reason: "unreadable",
      detail: input.pageError,
      lostAccess: input.pageErrorReason === "injection-failed",
    };
  }

  // A real failure with nothing to fall back on. Offline-with-the-same-page's
  // data falls through and renders that record instead.
  if (input.phase === "error" && !input.staleOffline) return { name: "error" };

  if (input.resolving || input.status === null || !input.hasPage) return { name: "loading" };

  // A page listing several people is a pick list — even a group thread, which
  // counts as a "person" page but has no single person to capture. Unless the
  // page itself resolved to someone, which outranks the list.
  if (input.listedPeople >= 2 && !input.hasContact) return { name: "people" };
  if (input.hasOrg && !input.hasContact) return { name: "company" };

  if (!input.pageIsPerson && input.status === "none") {
    return { name: "home", reason: "no-person", detail: null, lostAccess: false };
  }

  if (input.hasContact && !input.forceCreate) return { name: "known" };
  if (input.status === "ambiguous" && input.candidateCount > 0 && !input.forceCreate) {
    return { name: "ambiguous" };
  }
  return { name: "new" };
}
