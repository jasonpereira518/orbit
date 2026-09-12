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
import type { PageContext } from "./adapters/types";

declare global {
  interface Window {
    __orbitPageContext?: PageContext | { error: string };
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

window.__orbitPageContext = run();
