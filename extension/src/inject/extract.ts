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
 *
 * `captureProfile` below is the one exception: it is exported (Vite's IIFE build exposes
 * it as `window.__orbitExtract.captureProfile`) rather than run automatically on
 * injection, because only an explicit "Capture experience" press may call it.
 */

import { adapterFor } from "./adapters/registry";
import type { PageContext } from "./adapters/types";

declare global {
  interface Window {
    __orbitPageContext?: PageContext | { error: string };
  }
}

function run(): PageContext | { error: string } {
  try {
    const url = new URL(window.location.href);
    const result = adapterFor(url).extract(url);
    // Every adapter is synchronous unless called with `options.withProfile`, which this
    // ordinary read never passes — so this can never actually be a Promise. `captureProfile`
    // below is the one call that does pass it.
    if (result instanceof Promise) {
      throw new Error("adapter returned a Promise from a call with no options");
    }
    return result;
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The panel's other entry point into this bundle, for an explicit "Capture experience"
 * press only — see `inject/dom/expand.ts`'s header for why this exists and its bounds.
 *
 * Vite's IIFE build (`vite.inject.config.ts`) names this module's exports
 * `window.__orbitExtract`, so once `extract.js` is (re-)injected the panel calls
 * `window.__orbitExtract.captureProfile()` directly. `chrome.scripting.executeScript`'s
 * `func` injection waits for a returned Promise to settle and resolves to its value, so no
 * polling glue is needed on the panel side (see `lib/page.ts`'s `captureActiveProfile`).
 */
export async function captureProfile(): Promise<PageContext | { error: string }> {
  try {
    const url = new URL(window.location.href);
    return await adapterFor(url).extract(url, { withProfile: true });
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

window.__orbitPageContext = run();
