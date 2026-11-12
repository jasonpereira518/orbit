/**
 * Entry point for the injected extractor.
 *
 * Built as a standalone IIFE with no runtime dependencies — this is code
 * running inside someone else's page, and `chrome.scripting.executeScript`
 * cannot load ES modules from a file anyway.
 *
 * The result is parked on a well-known global rather than returned, because a
 * bundled IIFE's completion value is not reliably what executeScript reports.
 * The caller injects this file, then makes a second trivial call to read it.
 */

import { adapterFor } from "./adapters/registry";
import { scanLinkedinPosts, type ScannedPost } from "./adapters/linkedin-scan";
import type { PageContext } from "./adapters/types";

declare global {
  interface Window {
    __orbitPageContext?: PageContext | { error: string };
    /**
     * Set by the panel for one click on "Scan this page" (`scanActivePage`), and cleared right
     * after. Without it this script never reads a feed.
     */
    /** When the panel asked for a scan (ms). Honoured for a few seconds only, so a scan whose
     *  injection failed can never turn the next ordinary read into a scan. */
    __orbitScanAt?: number;
    __orbitScan?: { posts: ScannedPost[] } | { error: string };
  }
}

function run(): PageContext | { error: string } {
  try {
    const url = new URL(window.location.href);
    return adapterFor(url).extract(url);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function scan(): { posts: ScannedPost[] } | { error: string } {
  try {
    const url = new URL(window.location.href);
    if (!/(^|\.)linkedin\.com$/i.test(url.hostname)) return { posts: [] };
    return { posts: scanLinkedinPosts(document, url) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

const scanAsked = window.__orbitScanAt;
window.__orbitScanAt = undefined;
if (typeof scanAsked === "number" && Date.now() - scanAsked < 5_000) {
  window.__orbitScan = scan();
} else {
  window.__orbitPageContext = run();
}
