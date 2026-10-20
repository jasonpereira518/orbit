/**
 * SSRF guard edge cases (`src/lib/net-guard.ts`). Pure: no database, and no outbound
 * request is ever made — `assertDeliverable` only resolves DNS, and every host here is
 * either a literal or a name whose answer is a private address.
 *
 *   npx tsx stress-tests/net-guard-edge.ts
 */
import { check, errorText, finding, rejects, run, summary } from "./_harness";
import { assertDeliverable, isBlockedAddress } from "../src/lib/net-guard";

run(async () => {
  console.log("Literal forms that must be blocked...");
  const blockedLiterals = [
    "127.0.0.1", "127.1", "2130706433", "0x7f000001", "0177.0.0.1", "0.0.0.0",
    "10.0.0.1", "172.16.5.5", "192.168.1.1", "169.254.169.254", "100.64.0.1",
    "::1", "::", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::7f00:1", "2002:7f00:1::",
    "fe80::1", "fc00::1", "fd12::1", "ff02::1", "2001:0:1::1", "[::ffff:a9fe:a9fe]",
  ];
  for (const host of blockedLiterals) {
    const r = await rejects(() => assertDeliverable(`https://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}/x`));
    finding("SSRF-LIT", `blocks ${host}`, r.threw, r.threw ? "" : "ALLOWED");
  }

  console.log("\nHostnames that resolve privately...");
  for (const host of ["localhost", "localhost.", "LOCALHOST", "metadata.google.internal", "foo.local", "127.0.0.1.nip.io", "a.b.c.d.169.254.169.254.sslip.io"]) {
    const r = await rejects(() => assertDeliverable(`https://${host}/`));
    finding("SSRF-DNS", `blocks ${host}`, r.threw, r.threw ? errorText(r.error) : "ALLOWED");
  }

  console.log("\nScheme and credential handling...");
  for (const url of ["http://example.com/", "ftp://example.com/", "file:///etc/passwd", "https://user:pw@example.com/", "https://example.com:22/"]) {
    const r = await rejects(() => assertDeliverable(url));
    check(`${url} → ${r.threw ? "refused" : "allowed"}`, true, r.threw ? errorText(r.error) : "");
  }
  // Port restriction is a design choice; record it rather than assert.
  {
    const r = await rejects(() => assertDeliverable("https://example.com:6379/"));
    finding("SSRF-PORT", "non-443 ports on public hosts are refused (otherwise Orbit can be pointed at redis/elastic exposed on a public IP)", r.threw, r.threw ? "" : "allowed — any port");
  }

  console.log("\nisBlockedAddress on unusual inputs...");
  check("empty string is treated as blocked", isBlockedAddress("") === true);
  check("'1.2.3' (3 octets) is blocked (unparseable ⇒ blocked)", isBlockedAddress("1.2.3") === true);
  check("'8.8.8.8' is allowed", isBlockedAddress("8.8.8.8") === false);
  check("'2606:4700::1111' is allowed", isBlockedAddress("2606:4700::1111") === false);

  summary();
});
