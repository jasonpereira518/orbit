/**
 * Service worker — deliberately almost empty.
 *
 * MV3 tears these down after ~30s idle, so it holds no state. Clerk runs in the
 * panel (it needs React and the DOM), which means network calls happen there
 * too; the panel is an extension page, so it shares the same trust boundary.
 * There is no alarm, no polling, and no background fetching of anything.
 */

const APP_URL = import.meta.env.VITE_ORBIT_APP_URL ?? "http://localhost:3000";

/**
 * Clicking the toolbar icon toggles the side panel.
 *
 * This is also the gesture that grants `activeTab` for the current tab, which
 * is the extension's only route to reading the page — it holds no site host
 * permissions by default. Chrome documents "executing an action" as a granting
 * gesture but does not spell out this case, so the keyboard shortcut in the
 * manifest is kept as a second, unambiguously-granting gesture.
 */
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error("[orbit] side panel setup failed", error));

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    chrome.tabs.create({ url: `${APP_URL}/dashboard` });
  }
});
