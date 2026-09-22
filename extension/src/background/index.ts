/**
 * Service worker — deliberately small.
 *
 * MV3 tears these down after ~30s idle, so it holds no state. Clerk runs in the
 * panel (it needs React and the DOM), which means network calls happen there
 * too; the panel is an extension page, so it shares the same trust boundary.
 * There is no alarm, no polling, and no background fetching of anything.
 */
import { INTENT_KEY, SELECTION_MAX_CHARS, type Intent } from "@/lib/intents";

const APP_URL = import.meta.env.VITE_ORBIT_APP_URL ?? "http://localhost:3000";

/**
 * The toolbar click (and its keyboard shortcut, `_execute_action`) is handled
 * HERE rather than by Chrome's built-in "open the panel on click".
 *
 * That built-in is what made every site start behind a grant wall. Measured on
 * Chrome 153 (extension/docs/permission-spike.md): with
 * `openPanelOnActionClick: true` Chrome opens the panel and grants the tab
 * nothing. With it off, the same click fires `onClicked`, Chrome grants
 * `activeTab` for that tab, and `sidePanel.open()` called inside the handler
 * still counts as the user's gesture. So one click opens the panel AND lets it
 * read the page — on any site, with no permission prompt.
 */
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: false })
  .catch((error) => console.error("[orbit] side panel setup failed", error));

type IntentDetail =
  | { kind: "action" }
  | { kind: "link"; linkUrl: string }
  | { kind: "selection"; text: string };

/**
 * Open the panel and tell it what the user asked for. Called synchronously
 * from a click handler: `sidePanel.open()` runs FIRST, with no await before
 * it, because an await ends the user gesture and Chrome refuses the open
 * outside one. The same holds for a toolbar click and a context-menu click.
 */
function openPanelFor(tab: chrome.tabs.Tab | undefined, detail: IntentDetail) {
  if (!tab || tab.windowId === undefined || tab.id === undefined) return;

  chrome.sidePanel
    .open({ windowId: tab.windowId })
    .catch((error) => console.error("[orbit] could not open the panel", error));

  // Then tell the panel. If it is already open, a toolbar click granted it a
  // tab it has no other way to notice — same tab, often the same URL, no event.
  const intent = {
    id: crypto.randomUUID(),
    at: Date.now(),
    tabId: tab.id,
    windowId: tab.windowId,
    ...detail,
  } as Intent;
  chrome.storage.session
    .set({ [INTENT_KEY]: intent })
    .catch((error) => console.error("[orbit] could not hand off the click", error));
}

chrome.action.onClicked.addListener((tab) => openPanelFor(tab, { kind: "action" }));

/**
 * Right-click. Two items, each shown only where it means something:
 *
 * - On a LinkedIn, X or GitHub profile link: look that person up by the link
 *   alone. Their page is never visited or fetched — the link is the identity.
 * - On selected text: save it to Orbit as a note, choosing who it's about in
 *   the panel. The text rides in session storage (memory only, readable only
 *   by the extension's own pages) and is deleted as soon as the panel takes it.
 */
const MENU_LINK = "orbit-look-up-link";
const MENU_SELECTION = "orbit-save-selection";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_LINK,
      title: "Look up in Orbit",
      contexts: ["link"],
      targetUrlPatterns: [
        "https://*.linkedin.com/in/*",
        "https://x.com/*",
        "https://twitter.com/*",
        "https://github.com/*",
      ],
    });
    chrome.contextMenus.create({
      id: MENU_SELECTION,
      title: "Save to Orbit as a note",
      contexts: ["selection"],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_LINK && info.linkUrl) {
    openPanelFor(tab, { kind: "link", linkUrl: info.linkUrl });
  } else if (info.menuItemId === MENU_SELECTION && info.selectionText?.trim()) {
    openPanelFor(tab, {
      kind: "selection",
      text: info.selectionText.trim().slice(0, SELECTION_MAX_CHARS),
    });
  }
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    chrome.tabs.create({ url: `${APP_URL}/dashboard` });
  }
});
