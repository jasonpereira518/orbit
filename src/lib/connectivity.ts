/**
 * What the app believes about its connection to Orbit, and the rules for changing its mind.
 *
 * Pure so `scripts/smoke-connectivity.ts` can drive every transition without a browser; the
 * browser wiring (events, the probe, timers) lives in `connectivity-store.ts`.
 *
 * Three states, because "the device is offline" and "the device is online but Orbit is not
 * answering" need different words and different remedies:
 *
 * - `online`      — requests are getting answers.
 * - `offline`     — the browser says there is no network at all (`navigator.onLine`).
 * - `unreachable` — the browser says online, but a request to Orbit just died on the
 *                   network and a probe confirmed it: captive portal, a dead café Wi-Fi, a
 *                   VPN dropping packets, an outage between here and Vercel.
 *
 * `navigator.onLine === true` is weak evidence (it means "a network interface is up"), so
 * a single failed request never flips to `unreachable` on its own — it triggers a probe, and
 * only a failed probe does. `navigator.onLine === false` is strong evidence and wins at once.
 */
export type ConnectivityStatus = "online" | "offline" | "unreachable";

export type ConnectivityState = {
  status: ConnectivityStatus;
  /** Consecutive failed probes since the last success; drives the backoff. */
  failedProbes: number;
  /** Epoch ms the connection was last known to be lost, or null while online. */
  lostAt: number | null;
};

export type ConnectivityEvent =
  | { type: "browser_offline"; at: number }
  | { type: "browser_online" }
  | { type: "probe_ok" }
  | { type: "probe_failed"; at: number }
  | { type: "request_ok" };

export const INITIAL_CONNECTIVITY: ConnectivityState = {
  status: "online",
  failedProbes: 0,
  lostAt: null,
};

export function initialConnectivity(browserOnline: boolean, now: number): ConnectivityState {
  return browserOnline
    ? INITIAL_CONNECTIVITY
    : { status: "offline", failedProbes: 0, lostAt: now };
}

export function reduceConnectivity(
  state: ConnectivityState,
  event: ConnectivityEvent
): ConnectivityState {
  switch (event.type) {
    case "browser_offline":
      return {
        status: "offline",
        failedProbes: 0,
        lostAt: state.lostAt ?? event.at,
      };
    case "browser_online":
      // An interface came up — not proof Orbit answers. Stay where we are until the probe
      // the store fires on this event says so; from `offline` that means `unreachable`
      // (not `online`), so nothing announces "Back online" over a portal login page.
      return state.status === "offline"
        ? { ...state, status: "unreachable", failedProbes: 0 }
        : state;
    case "probe_ok":
    case "request_ok":
      // A real answer from Orbit is the one thing that proves the way is clear — except
      // while the browser insists it is offline, where a stale in-flight success must not
      // paper over the device having just lost its network.
      if (state.status === "offline") return state;
      return INITIAL_CONNECTIVITY;
    case "probe_failed":
      if (state.status === "offline") return state;
      return {
        status: "unreachable",
        failedProbes: state.failedProbes + 1,
        lostAt: state.lostAt ?? event.at,
      };
  }
}

/** Whether moving from `prev` to `next` is a reconnection worth acting on. */
export function isReconnection(prev: ConnectivityStatus, next: ConnectivityStatus): boolean {
  return prev !== "online" && next === "online";
}

export const PROBE_BASE_MS = 2_000;
export const PROBE_MAX_MS = 30_000;

/**
 * How long to wait before the next probe after `failedProbes` failures: 2 s, 4 s, 8 s,
 * 16 s, then every 30 s, each ±20% so a fleet of tabs that lost the same Wi-Fi does not
 * come back knocking in lockstep. `random` is injectable for the smoke test.
 */
export function nextProbeDelay(failedProbes: number, random: () => number = Math.random): number {
  const exp = Math.min(PROBE_MAX_MS, PROBE_BASE_MS * 2 ** Math.max(0, failedProbes - 1));
  const jitter = 1 + (random() * 0.4 - 0.2);
  return Math.round(Math.min(PROBE_MAX_MS, exp * jitter));
}
