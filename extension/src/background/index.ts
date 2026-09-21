/**
 * Service worker — deliberately small.
 *
 * MV3 tears these down after ~30s idle, so it holds no state. Clerk runs in the
 * panel (it needs React and the DOM), which means network calls happen there
 * too; the panel is an extension page, so it shares the same trust boundary.
 * There is no alarm, no polling, and no background fetching of anything.
 */
import { INTENT_KEY, type Intent } from "@/lib/intents";

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

chrome.action.onClicked.addListener((tab) => {
  if (tab.windowId === undefined || tab.id === undefined) return;

  // FIRST, and with no await before it: an await ends the user gesture, and
  // Chrome refuses `sidePanel.open()` outside one.
  chrome.sidePanel
    .open({ windowId: tab.windowId })
    .catch((error) => console.error("[orbit] could not open the panel", error));

  // Then tell the panel. If it is already open, this click granted it a tab it
  // has no other way to notice — same tab, often the same URL, no event.
  const intent: Intent = {
    id: crypto.randomUUID(),
    at: Date.now(),
    kind: "action",
    tabId: tab.id,
    windowId: tab.windowId,
  };
  chrome.storage.session
    .set({ [INTENT_KEY]: intent })
    .catch((error) => console.error("[orbit] could not hand off the click", error));
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    chrome.tabs.create({ url: `${APP_URL}/dashboard` });
  }
});
