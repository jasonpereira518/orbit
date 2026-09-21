/**
 * Standing site access — the opt-in, not the way in.
 *
 * Reading a page never needs this: clicking the toolbar icon grants that tab
 * (`activeTab`, via the worker's onClicked — see background/index.ts). What a
 * standing host permission adds is *following*: on a site the user lives on,
 * the panel reads each page as they open it, with no click each time.
 *
 * These origins are declared under `optional_host_permissions`, so asking adds
 * no install-time warning; the user turns them on from Settings when the
 * convenience is worth it to them, and off from the same list.
 */
import { browser } from "./browser";

/**
 * The sites Orbit knows how to read deeply. Must stay in lockstep with
 * `optional_host_permissions` in manifest.config.ts — an origin that is
 * requestable but not shown here would be granted invisibly by "allow all".
 * (twitter.com is deliberately absent from both: it only 301s to x.com.)
 */
export const KNOWN_SITES = [
  { origin: "https://*.linkedin.com/*", label: "LinkedIn" },
  { origin: "https://x.com/*", label: "X" },
  { origin: "https://mail.google.com/*", label: "Gmail" },
  { origin: "https://github.com/*", label: "GitHub" },
] as const;

export const KNOWN_ORIGINS: string[] = KNOWN_SITES.map((site) => site.origin);

export function grantedOrigins(): Promise<string[]> {
  return browser().permissions.granted();
}

/**
 * MUST be called synchronously from a click handler — Chrome rejects a
 * permission request not tied to a user gesture, and any `await` beforehand
 * loses the gesture.
 */
export function requestSites(origins: string[]): Promise<boolean> {
  return browser().permissions.request(origins);
}

export function revokeSites(origins: string[]): Promise<boolean> {
  return browser().permissions.remove(origins);
}
