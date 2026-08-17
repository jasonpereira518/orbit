/**
 * Service worker — deliberately almost empty.
 *
 * MV3 tears these down after ~30s idle, so it holds no state. Clerk runs in the
 * popup (it needs React and the DOM), which means network calls happen there
 * too; the popup is an extension page, so it shares the same trust boundary.
 * There is no alarm, no polling, and no background fetching of anything.
 */

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    chrome.tabs.create({
      url: `${import.meta.env.VITE_ORBIT_APP_URL ?? "http://localhost:3000"}/dashboard`,
    });
  }
});
