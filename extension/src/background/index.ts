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

const VERSION = chrome.runtime.getManifest().version;

/**
 * Where the browser sends someone who removes the extension: an unauthenticated GET that
 * counts the uninstall by version and nothing else (`/api/extension/uninstalled`, always 204).
 * Registered on every worker start rather than only on install, so an update moves the version
 * in the URL and the registration survives anything that cleared it. Chrome ignores the call
 * for a non-http(s) URL, hence the guard for a malformed dev URL.
 */
function registerUninstallUrl() {
  try {
    const base = APP_URL.replace(/\/$/, "");
    chrome.runtime.setUninstallURL(`${base}/api/extension/uninstalled?v=${encodeURIComponent(VERSION)}`);
  } catch (error) {
    console.error("[orbit] uninstall url setup failed", error);
  }
}
registerUninstallUrl();

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    // The welcome tab is tagged so the install shows up as a channel: the app's first-touch
    // capture reads utm_* from this URL, and the campaign is the build that was installed.
    const params = new URLSearchParams({
      utm_source: "extension",
      utm_medium: "install",
      utm_campaign: VERSION,
    });
    chrome.tabs.create({ url: `${APP_URL.replace(/\/$/, "")}/dashboard?${params}` });
    // The panel's first /me after this carries the install header, then clears the marker.
    // The service worker holds no state, so the marker lives in extension storage.
    chrome.storage.local
      .set({ orbitInstallPending: true })
      .catch((error) => console.error("[orbit] install marker failed", error));
  }
});
