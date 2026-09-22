/**
 * A `Browser` that needs no extension: for the design harness and tests.
 *
 * It is typed as the real interface, so when the panel grows a new browser
 * verb this stops compiling instead of throwing `undefined is not a function`
 * from inside a click handler — which is what the old hand-shaped
 * `globalThis.chrome` stub did.
 */
import type { Browser } from "@/lib/browser";

export type FakeBrowserLog = Array<{ verb: string; args: unknown[] }>;

export function createFakeBrowser(
  over: Partial<Browser> & { granted?: string[]; version?: string } = {}
): Browser & { log: FakeBrowserLog } {
  const log: FakeBrowserLog = [];
  const note = (verb: string, ...args: unknown[]) => log.push({ verb, args });
  let granted = over.granted ?? ["https://*.linkedin.com/*"];

  return {
    log,
    openTab: (url) => note("openTab", url),
    activeTab: async () => ({ id: 1, url: "https://www.linkedin.com/in/amara-osei" }),
    runExtractor: async () => undefined,
    readDocumentHtml: async () => "<html><body></body></html>",
    onTabChange: () => () => {},
    permissions: {
      granted: async () => granted,
      request: async (origins) => {
        note("permissions.request", origins);
        granted = [...new Set([...granted, ...origins])];
        return true;
      },
      remove: async (origins) => {
        note("permissions.remove", origins);
        granted = granted.filter((o) => !origins.includes(o));
        return true;
      },
    },
    currentWindowId: async () => 1,
    readIntent: async () => undefined,
    clearIntent: async () => {},
    onIntent: () => () => {},
    onSessionPoke: () => () => {},
    actionShortcut: async () => "⇧⌘O",
    extensionVersion: () => over.version ?? "1.0.0",
    requestUpdateCheck: async () => "no_update",
    reloadExtension: () => note("reloadExtension"),
    ...over,
  };
}
