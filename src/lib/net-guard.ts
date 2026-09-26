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
import { isIPv6 } from "node:net";

/**
 * Whether an IP literal is somewhere Orbit must never be made to talk to.
 *
 * The cloud metadata endpoint (169.254.169.254) is the one that matters most — it hands out
 * credentials to anything that can reach it — but loopback and private ranges are equally
 * off-limits, because reaching them means the caller has borrowed Orbit's network position.
 */
export function isBlockedAddress(address: string): boolean {
  const ip = address.trim().toLowerCase();

  // IPv6, including every form that embeds an IPv4 address. Parsed into hextets rather than
  // pattern-matched: the WHATWG URL parser rewrites `[::ffff:169.254.169.254]` to
  // `[::ffff:a9fe:a9fe]`, so a dotted-quad regex never sees the mapped address a URL carries.
  if (ip.includes(":")) {
    const h = parseIPv6(ip.replace(/%.*$/, ""));
    if (!h) return true; // Unparseable is not provably safe.
    const embeddedV4 = (hi: number, lo: number) =>
      `${h[hi] >> 8}.${h[hi] & 0xff}.${h[lo] >> 8}.${h[lo] & 0xff}`;
    const zeroUpTo = (n: number) => h.slice(0, n).every((x) => x === 0);

    if (zeroUpTo(8)) return true; // ::
    if (zeroUpTo(7) && h[7] === 1) return true; // ::1
    if ((h[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((h[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
    if ((h[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 site local (deprecated)
    if ((h[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
    // ::ffff:a.b.c.d (mapped), ::a.b.c.d (compatible), ::ffff:0:a.b.c.d (SIIT).
    if (zeroUpTo(5) && (h[5] === 0xffff || h[5] === 0)) return isBlockedAddress(embeddedV4(6, 7));
    if (zeroUpTo(4) && h[4] === 0xffff && h[5] === 0) return isBlockedAddress(embeddedV4(6, 7));
    // 64:ff9b::/96 and 64:ff9b:1::/48 — NAT64 translates these to the embedded IPv4.
    if (h[0] === 0x64 && h[1] === 0xff9b) {
      if (h.slice(2, 6).every((x) => x === 0)) return isBlockedAddress(embeddedV4(6, 7));
      if (h[2] === 1) return true;
    }
    if (h[0] === 0x2002) return isBlockedAddress(embeddedV4(1, 2)); // 6to4 embeds its IPv4
    if (h[0] === 0x2001 && h[1] === 0) return true; // Teredo: tunnels to an arbitrary IPv4
    if (h[0] === 0x100 && zeroUpTo(4)) return true; // 100::/64 discard-only
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
  if (a === 192 && b === 0 && parts[2] === 0) return true; // IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast and reserved
  return false;
}

/** Eight 16-bit groups, or null when `ip` is not a valid IPv6 literal. */
function parseIPv6(ip: string): number[] | null {
  if (!isIPv6(ip)) return null;
  let text = ip;
  // A trailing dotted quad (`::ffff:1.2.3.4`) becomes two hextets.
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const fill = text.includes("::") ? 8 - left.length - right.length : 0;
  const groups = [...left, ...Array(fill).fill("0"), ...right].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : null;
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

/**
 * `fetch` a URL a user influenced, following at most `maxHops` redirects by hand so
 * `assertDeliverable` runs before EVERY hop. `redirect: "follow"` would check only the
 * first URL, and a public host answering 302 to `http://169.254.169.254/` walks straight
 * past it. Throws on a refused address; resolves to null when the chain runs too long or a
 * redirect has no `Location`.
 *
 * For whole documents with retries and content-type rules, `guardedFetchText` in
 * `src/lib/events/guarded-fetch.ts` builds on the same guard. Never pass credentials in
 * `init.headers`: they would be replayed to every hop.
 */
export async function guardedFetch(
  startUrl: string,
  init: Omit<RequestInit, "redirect"> = {},
  maxHops = 3
): Promise<Response | null> {
  let url = startUrl;
  for (let hop = 0; hop <= maxHops; hop++) {
    await assertDeliverable(url);
    const res = await fetch(url, { ...init, redirect: "manual" });
    if (res.status < 300 || res.status >= 400 || res.status === 304) return res;
    await res.body?.cancel().catch(() => {});
    const location = res.headers.get("location");
    if (!location) return null;
    url = new URL(location, url).href;
  }
  return null;
}

/**
 * Read a response body, giving up (null) once it passes `maxBytes`. `arrayBuffer()` buffers
 * everything a server chooses to send before any size check can run.
 */
export async function readBodyCapped(res: Response, maxBytes: number): Promise<Buffer | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
