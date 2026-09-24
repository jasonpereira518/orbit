import type { BeaconEventKind, ShareChannel } from "@/lib/interest-list";

/**
 * Fire-and-forget to `/api/interest-list/event`. `sendBeacon` first: a share that opens
 * another app (WhatsApp, Messages, the mail client) can unload the page before a fetch
 * lands, and the beacon is the one transport the browser flushes on the way out. Never
 * throws and never awaits — nothing a visitor does waits on the funnel.
 */
export function sendInterestBeacon(kind: BeaconEventKind, token: string, channel?: ShareChannel) {
  try {
    const body = JSON.stringify({ kind, token, channel });
    const url = "/api/interest-list/event";
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      if (navigator.sendBeacon(url, new Blob([body], { type: "text/plain" }))) return;
    }
    void fetch(url, { method: "POST", body, keepalive: true }).catch(() => undefined);
  } catch {
    // The funnel is best-effort.
  }
}
