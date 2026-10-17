/**
 * Hermetic DNS for smoke runs, preloaded by scripts/run-smoke.ts via NODE_OPTIONS (--import).
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
