/**
 * Every browser API the panel touches, behind one object.
 *
 * The panel used to call `chrome.*` from wherever it happened to need it, so
 * the only way to render a component outside a real extension was to assign a
 * hand-shaped stub to `globalThis.chrome` before importing anything — and a
 * stub that drifted from the real call sites failed silently, as `undefined is
 * not a function` deep inside a click handler. Routing the calls through here
 * gives the harness and the tests one typed thing to replace.
 *
 * Deliberately small: these are the panel's verbs, not a mirror of the Chrome
 * API. The background worker and the injected extractor do not use it — they
 * only ever run inside the real browser.
 */
import { INTENT_KEY } from "./intents";

export type ActiveTab = { id?: number; url?: string };

export type UpdateCheck =
  | "update_available"
  | "no_update"
  | "throttled"
  | "unsupported";

export type Browser = {
  /** Open an Orbit (or any) URL in a new tab. */
  openTab(url: string): void;
  /** The tab the panel is beside. `url` is empty when Orbit holds no grant for it. */
  activeTab(): Promise<ActiveTab | undefined>;
  /**
   * Inject the bundled extractor into a tab and return what it parked on
   * `window.__orbitPageContext`. Throws when the tab can't be scripted.
   */
  /** `full`: the whole page's text, for work history (see ExtractOptions). */
  runExtractor(tabId: number, options?: { full?: boolean }): Promise<unknown>;
  /** The tab's serialized DOM. Dev-only: feeds the fixture saver. */
  readDocumentHtml(tabId: number): Promise<string | null>;
  /**
   * Subscribe to "the tab the panel is beside may now show something else":
   * the active tab navigated or finished loading, or another tab was activated.
   * Returns the unsubscribe function.
   */
  onTabChange(listener: () => void): () => void;
  permissions: {
    granted(): Promise<string[]>;
    /**
     * MUST be called synchronously from a click handler — Chrome rejects a
     * permission request not tied to a user gesture, and any `await`
     * beforehand loses the gesture.
     */
    request(origins: string[]): Promise<boolean>;
    remove(origins: string[]): Promise<boolean>;
  };
  /** The window this panel belongs to. Each window has its own panel. */
  currentWindowId(): Promise<number | null>;
  /** The latest toolbar click the worker recorded, if any (see lib/intents). */
  readIntent(): Promise<unknown>;
  /** Consume a click so no panel acts on it again. */
  clearIntent(): Promise<void>;
  /** Hear toolbar clicks as the worker records them. Returns unsubscribe. */
  onIntent(listener: (value: unknown) => void): () => void;
  /**
   * The keyboard shortcut that does what clicking the icon does, as the user
   * actually has it set — they can change it in chrome://extensions/shortcuts.
   * Null when unset.
   */
  actionShortcut(): Promise<string | null>;
  /** This build's version, from the manifest. */
  extensionVersion(): string;
  /** Ask Chrome whether a newer build is waiting in the Web Store. */
  requestUpdateCheck(): Promise<UpdateCheck>;
  /** Restart the extension, which applies a downloaded update. */
  reloadExtension(): void;
};

export const chromeBrowser: Browser = {
  openTab(url) {
    void chrome.tabs.create({ url });
  },

  async activeTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab ? { id: tab.id, url: tab.url } : undefined;
  },

  async runExtractor(tabId, options = {}) {
    // Options ride a global the extractor reads once and deletes: a file
    // injection takes no arguments.
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (full: boolean) => {
        (window as unknown as { __orbitExtractOptions?: { full: boolean } }).__orbitExtractOptions = { full };
      },
      args: [Boolean(options.full)],
    });
    // Two injections rather than one: the extractor is a bundled IIFE, and a
    // bundled IIFE's completion value is not reliably what `executeScript`
    // reports. So the file parks its result on a global and a second trivial
    // call reads it.
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["inject/extract.js"],
    });
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () =>
        (window as unknown as { __orbitPageContext?: unknown })
          .__orbitPageContext,
    });
    return result?.result;
  },

  async readDocumentHtml(tabId) {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => document.documentElement.outerHTML,
    });
    return typeof result?.result === "string" ? result.result : null;
  },

  onTabChange(listener) {
    const onUpdated = (
      _tabId: number,
      change: chrome.tabs.OnUpdatedInfo,
      tab: chrome.tabs.Tab
    ) => {
      if (!tab.active) return;
      if (change.url || change.status === "complete") listener();
    };
    const onActivated = () => listener();
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onActivated.addListener(onActivated);
    return () => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onActivated.removeListener(onActivated);
    };
  },

  permissions: {
    async granted() {
      try {
        return (await chrome.permissions.getAll()).origins ?? [];
      } catch {
        return [];
      }
    },
    request(origins) {
      return chrome.permissions.request({ origins }).catch(() => false);
    },
    remove(origins) {
      return chrome.permissions.remove({ origins }).catch(() => false);
    },
  },

  async currentWindowId() {
    try {
      return (await chrome.windows.getCurrent()).id ?? null;
    } catch {
      return null;
    }
  },

  async readIntent() {
    return (await chrome.storage.session.get(INTENT_KEY))[INTENT_KEY];
  },

  async clearIntent() {
    await chrome.storage.session.remove(INTENT_KEY);
  },

  onIntent(listener) {
    const onChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string
    ) => {
      if (area !== "session" || !(INTENT_KEY in changes)) return;
      const next = changes[INTENT_KEY].newValue;
      if (next !== undefined) listener(next);
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  },

  async actionShortcut() {
    try {
      const commands = await chrome.commands.getAll();
      return commands.find((c) => c.name === "_execute_action")?.shortcut || null;
    } catch {
      return null;
    }
  },

  extensionVersion() {
    return chrome.runtime.getManifest().version;
  },

  async requestUpdateCheck() {
    try {
      const { status } = await chrome.runtime.requestUpdateCheck();
      return status as UpdateCheck;
    } catch {
      // Unpacked builds have no update URL, and Chrome rejects the check.
      return "unsupported";
    }
  },

  reloadExtension() {
    chrome.runtime.reload();
  },
};

let current: Browser = chromeBrowser;

/** The browser the panel talks to. Read at call time, never cached. */
export function browser(): Browser {
  return current;
}

/**
 * Swap the implementation — for the design harness and tests only. The real
 * panel never calls this, so production always talks to Chrome.
 */
export function installBrowser(next: Browser) {
  current = next;
}
