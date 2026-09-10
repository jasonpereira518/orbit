/**
 * The SSRF guard: deciding whether Orbit is allowed to make a request to a URL a user gave it.
 *
 * Extracted from `src/lib/webhooks/dispatch.ts`, which still re-exports both functions so its
 * existing callers are untouched. The move is not cosmetic — `dispatch.ts` imports `@/db` and
 * the webhook tables, and `scripts/run-smoke.ts` fails any `pure`-tier smoke script that
 * reaches `../src/db`. A second consumer arrived (fetching a user-supplied event page in
 * `src/lib/events/fetch-page.ts`) whose test has no business booting a database, so the guard
 * lives here, importing nothing but `node:dns`.
 *
 * There must stay exactly ONE copy of this logic. Two copies is how one of them quietly stops
 * blocking something the other still does.
 */
import { lookup } from "node:dns/promises";

/**
 * Whether an IP literal is somewhere Orbit must never be made to talk to.
 *
 * The cloud metadata endpoint (169.254.169.254) is the one that matters most — it hands out
 * credentials to anything that can reach it — but loopback and private ranges are equally
 * off-limits, because reaching them means the caller has borrowed Orbit's network position.
 */
export function isBlockedAddress(address: string): boolean {
  const ip = address.trim().toLowerCase();

  // IPv6, including the mapped-IPv4 form that would otherwise slip past the v4 checks.
  if (ip.includes(":")) {
    if (ip === "::1" || ip === "::") return true;
    // fc00::/7 (unique local) and fe80::/10 (link local).
    if (/^f[cd]/.test(ip)) return true;
    if (/^fe[89ab]/.test(ip)) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
    if (mapped) return isBlockedAddress(mapped[1]);
    return false;
  }

  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    // Unparseable is not provably safe.
    return true;
  }
  const [a, b] = parts;
  if (a === 0) return true; // "this network"
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast and reserved
  return false;
}

/**
 * Resolve the URL's host and refuse anything internal.
 *
 * Called immediately before the fetch, deliberately. Checking only at registration is
 * defeated by DNS rebinding: the attacker registers a hostname that resolves publicly, then
 * repoints it. This narrows that window to the gap between this lookup and the request —
 * genuinely narrowed, not closed; fully closing it needs a fetch pinned to the resolved IP.
 */
export async function assertDeliverable(url: string): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error("Only https:// endpoints are allowed");
  if (parsed.username || parsed.password) throw new Error("Credentials in URL are not allowed");

  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (/\.(local|internal|localdomain)$/i.test(host) || host === "localhost") {
    throw new Error("Internal hostnames are not allowed");
  }

  // A bare IP literal never needs DNS; check it directly.
  if (/^[\d.]+$/.test(host) || host.includes(":")) {
    if (isBlockedAddress(host)) throw new Error("That address is not allowed");
    return;
  }

  const resolved = await lookup(host, { all: true });
  if (resolved.length === 0) throw new Error("Host did not resolve");
  for (const entry of resolved) {
    if (isBlockedAddress(entry.address)) {
      throw new Error("That host resolves to an internal address");
    }
  }
}
