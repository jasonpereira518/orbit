/**
 * Hermetic smoke runs: no real DNS, no real HTTP. Preloaded by scripts/run-smoke.ts via
 * NODE_OPTIONS (--import), so it is in place before any script or module loads.
 *
 * DNS
 *
 * The SSRF guard (`assertDeliverable` in src/lib/net-guard.ts) resolves every host with
 * `dns/promises.lookup` before a request — even in scripts that replace `globalThis.fetch`,
 * because the guard runs outside the stubbed fetch. So a "no network" smoke still needed a
 * working public resolver: it passed on GitHub's runners and failed offline, behind split
 * DNS, or in a sandbox (smoke-shared-avatar-writes, -upkeep, smoke-event-url-guard,
 * smoke-web-read-page), and a resolver hiccup on a runner could fail it there too.
 *
 * This answers `dns/promises.lookup` locally instead:
 *   - `localhost` and `*.localhost` → 127.0.0.1 (the guard refuses these by name first anyway)
 *   - `localtest.me` and its subdomains → 127.0.0.1, as public DNS answers: the SSRF smokes
 *     use it as "a public name that resolves to loopback" (smoke-webhook-delivery,
 *     smoke-api-routes), so it must keep resolving there
 *   - `*.invalid` (RFC 6761) → ENOTFOUND, for scripts that want an unresolvable host
 *   - anything else → one fixed PUBLIC address, so the guard lets it through to the
 *     script's stubbed fetch.
 *
 * Only the promise API is replaced. The callback `dns.lookup` that `net.connect` uses is
 * left alone, so real sockets (and `SMOKE_ALLOW_REMOTE=1` runs against Neon) are unaffected.
 * Scripts that need a host to resolve to a PRIVATE address still stub that themselves.
 */
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import { syncBuiltinESMExports } from "node:module";

const PUBLIC_ADDRESS = "93.184.215.14";

function answer(address, family, all) {
  return all ? [{ address, family }] : { address, family };
}

async function hermeticLookup(hostname, options) {
  const all = typeof options === "object" && options !== null && Boolean(options.all);
  const host = String(hostname).toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return answer("127.0.0.1", 4, all);
  if (host === "localtest.me" || host.endsWith(".localtest.me")) return answer("127.0.0.1", 4, all);
  if (host.endsWith(".invalid")) {
    throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND", hostname });
  }
  return answer(PUBLIC_ADDRESS, 4, all);
}

if (process.env.SMOKE_REAL_DNS !== "1") {
  dns.promises.lookup = hermeticLookup;
  dnsPromises.lookup = hermeticLookup;
  syncBuiltinESMExports();
}

/*
 * HTTP
 *
 * The real `fetch` refuses any host but loopback. A smoke that meant to stub a provider and
 * missed one call used to make a live request: on a GitHub runner it passed (or failed) on
 * whatever that service answered, and offline it hung for the runner's full timeout —
 * smoke-avatar-storage did exactly that against Vercel's Blob API. Now it fails at once,
 * naming the URL. Scripts that stub `globalThis.fetch` replace this and restore it, so they
 * are unaffected; loopback stays open for fixture servers.
 *
 * SMOKE_ALLOW_NETWORK=1 turns it off, for the few runs that are meant to be live
 * (`SMOKE_ALLOW_REMOTE=1` against Neon, the manual tier).
 */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

if (process.env.SMOKE_ALLOW_NETWORK !== "1" && process.env.SMOKE_ALLOW_REMOTE !== "1") {
  const realFetch = globalThis.fetch;
  globalThis.fetch = function hermeticFetch(input, init) {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!LOOPBACK.has(url.hostname) && url.protocol !== "data:" && url.protocol !== "blob:") {
      return Promise.reject(
        new TypeError(`smoke runs are offline: a real request to ${url.origin} was refused — stub it (scripts/smoke/http-mock.ts)`)
      );
    }
    return realFetch(input, init);
  };
}
