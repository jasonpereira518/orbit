import type { ClientEventName, EventProps } from "@/lib/product-event-schemas";
import { readPageviewSessionId } from "@/lib/pageview-session";

/**
 * Report a client-only product event (`CLIENT_EVENTS`) through the `event` kind of `/api/p/v`.
 *
 * Browser-only and fire-and-forget: never throws, never awaits, sends nothing outside a
 * browser. The server allow-lists the name, validates the properties against the schema and
 * takes the user from the session, so nothing here is trusted. Imports nothing that reaches
 * `@/db` (the schema import is type-only), because error boundaries and the notification
 * helper ship to every page.
 */
export function sendClientEvent<N extends ClientEventName>(name: N, props: EventProps<N>): void {
  try {
    if (typeof window === "undefined") return;
    const body = JSON.stringify({
      kind: "event",
      id: crypto.randomUUID(),
      sessionId: readPageviewSessionId(),
      name,
      props,
      automated: navigator.webdriver === true,
    });
    // sendBeacon first: an error screen or a notification click can be followed at once by
    // a navigation, and a fetch started just before it may be cancelled.
    if (typeof navigator.sendBeacon === "function" && navigator.sendBeacon("/api/p/v", new Blob([body], { type: "application/json" }))) {
      return;
    }
    void fetch("/api/p/v", { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true }).catch(() => {});
  } catch {
    // Blocked, offline, storage disabled. Telemetry never surfaces.
  }
}

/**
 * The coarse kind of an error a boundary caught. Reads the error's name and message ONLY to
 * classify; neither is ever sent.
 *   chunk_load — a code chunk failed to load (usually a deploy while the tab was open)
 *   network    — the connection failed, not Orbit
 *   server     — a Server Component render failed (Next attaches a digest)
 *   render     — anything else thrown while rendering
 */
export function errorKindOf(error: unknown, offline = false): "chunk_load" | "network" | "server" | "render" | "unknown" {
  if (!(error instanceof Error)) return "unknown";
  if (error.name === "ChunkLoadError" || /loading (css )?chunk|dynamically imported module|importing a module script failed/i.test(error.message)) {
    return "chunk_load";
  }
  if (offline) return "network";
  if ((error as Error & { digest?: string }).digest) return "server";
  return "render";
}

/** Errors already reported, so a re-render or StrictMode's double effect never reports one twice. */
const reported = new WeakSet<object>();

/** Fire `error_shown` once per error instance, from an error boundary. */
export function reportErrorShown(where: string, error: unknown, offline = false): void {
  if (error && typeof error === "object") {
    if (reported.has(error)) return;
    reported.add(error);
  }
  sendClientEvent("error_shown", { where, error_kind: errorKindOf(error, offline) });
}
