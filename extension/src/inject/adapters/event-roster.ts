/**
 * Luma and Partiful event pages: the guest list the user has open.
 *
 * Neither platform gives an attendee their guest list through an API, so the page the user
 * is signed in to is the only place it exists for them. This reads it from the DOM and
 * nothing else — no internal endpoints, no scrolling or paging on their behalf — and only
 * because they clicked the icon. Saving is a second, explicit click in the panel.
 *
 * Open the full list first (Luma's "Going" guest dialog, Partiful's guest list): with a dialog
 * open only the dialog is read, so the avatar strip behind it cannot add half-names.
 */

import { metaContent } from "@/inject/dom/meta";
import { stripTracking } from "@/inject/dom/url";
import { attempt, emptyIdentity, type SiteAdapter } from "./types";
import type { PageCandidate, PageSite } from "@contract";

const ADAPTER_VERSION = "event-roster-1";
/** Mirrors MAX_ROSTER_GUESTS in contract.schema.ts — sized to the request body cap. */
const MAX_GUESTS = 400;

const LUMA_HOSTS = new Set(["lu.ma", "luma.com", "www.luma.com"]);
/** Luma's own pages that sit at one path segment like an event slug does. */
const LUMA_NON_EVENTS = new Set(["", "home", "discover", "calendar", "settings", "signin", "create", "explore", "pricing"]);

function siteOf(url: URL): PageSite | null {
  const host = url.hostname.toLowerCase();
  const path = url.pathname.replace(/\/+$/, "");
  if (LUMA_HOSTS.has(host)) {
    const segments = path.split("/").filter(Boolean);
    if (segments.length === 1 && !LUMA_NON_EVENTS.has(segments[0].toLowerCase())) return "luma";
    if (segments[0] === "e" && segments.length === 2) return "luma";
    return null;
  }
  if (host === "partiful.com" && /^\/e\/[^/]+$/.test(path)) return "partiful";
  return null;
}

/** First names are normal on Partiful, so one word is enough — but no digits, handles or UI. */
function looksLikeGuestName(value: string | null | undefined): string | null {
  const name = (value ?? "").replace(/\s+/g, " ").trim();
  if (name.length < 2 || name.length > 80) return null;
  if (/[\d@#/\\|:]/.test(name)) return null;
  const words = name.split(" ");
  if (words.length > 5) return null;
  if (!words.every((w) => /^[\p{L}'’.-]+$/u.test(w))) return null;
  if (/^(going|maybe|invited|hosts?|guests?|see all|view all|show more|and|you)$/i.test(name)) return null;
  return name;
}

function rootOf(): ParentNode {
  const dialogs = Array.from(document.querySelectorAll<HTMLElement>("[role='dialog'], dialog[open]"));
  return dialogs.at(-1) ?? document;
}

/** Luma: every guest is a link to their `/user/…` profile, with the name as text or avatar alt. */
function lumaGuests(root: ParentNode): PageCandidate[] {
  const out: PageCandidate[] = [];
  for (const anchor of Array.from(root.querySelectorAll<HTMLAnchorElement>("a[href*='/user/']"))) {
    let href: URL;
    try {
      href = new URL(anchor.href);
    } catch {
      continue;
    }
    if (!LUMA_HOSTS.has(href.hostname.toLowerCase()) || !/^\/user\/[^/]+$/.test(href.pathname)) continue;
    const firstLine = (anchor.innerText || anchor.textContent || "").split("\n")[0];
    const name = looksLikeGuestName(firstLine) ?? looksLikeGuestName(anchor.querySelector("img")?.alt);
    if (name) out.push({ name, profileUrl: `https://luma.com${href.pathname}` });
  }
  return out;
}

/** Partiful: no profile pages, so the names on the list — avatar alts first, then list rows. */
function partifulGuests(root: ParentNode): PageCandidate[] {
  const out: PageCandidate[] = [];
  for (const img of Array.from(root.querySelectorAll<HTMLImageElement>("img[alt]"))) {
    const name = looksLikeGuestName(img.alt);
    if (name) out.push({ name });
  }
  if (out.length === 0 && root !== document) {
    for (const row of Array.from(root.querySelectorAll<HTMLElement>("li, [role='listitem']"))) {
      const name = looksLikeGuestName(row.innerText.split("\n")[0]);
      if (name) out.push({ name });
    }
  }
  return out;
}

function eventTitle(): string {
  const raw = metaContent("og:title") ?? document.title;
  return raw.replace(/\s*[·|–-]\s*(Luma|Partiful)\s*$/i, "").trim().slice(0, 300);
}

export const eventRosterAdapter: SiteAdapter = {
  id: "event-roster",
  adapterVersion: ADAPTER_VERSION,
  matches: (url) => siteOf(url) !== null,

  extract(url) {
    const warnings: string[] = [];
    const site = siteOf(url) ?? "generic";
    const root = rootOf();
    if (root === document) warnings.push("no-guest-dialog");
    const found =
      attempt(warnings, "guests", () => (site === "luma" ? lumaGuests(root) : partifulGuests(root))) ?? [];
    const seen = new Set<string>();
    const guests = found.filter((g) => {
      const key = (g.profileUrl ?? g.name).toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (guests.length === 0) warnings.push("no-guests");
    if (guests.length > MAX_GUESTS) warnings.push("roster-truncated");

    return {
      schemaVersion: 1,
      site,
      adapterVersion: ADAPTER_VERSION,
      kind: "list",
      url: stripTracking(url.href),
      sourceUrl: url.href,
      capturedAt: new Date().toISOString(),
      identity: emptyIdentity(),
      roster: { title: eventTitle(), guests: guests.slice(0, MAX_GUESTS) },
      // Nothing to parse or write starters from: the names are the whole payload.
      text: { blob: "", truncated: false, charCount: 0, fromSelection: false },
      warnings,
    };
  },
};
