/**
 * The outbound webhook signature scheme, against known vectors.
 *
 * Pure tier — `sign.ts` touches no database — and that is the point: a signature scheme is
 * uniquely bad at failing visibly. Every signature it produces verifies against itself, so a
 * scheme that omits the timestamp from the MAC, or compares non-constant-time, or accepts a
 * stale replay, looks perfectly healthy in manual testing and in production until someone
 * actually attacks it.
 */
import {
  SIGNATURE_TOLERANCE_SECONDS,
  buildEnvelope,
  generateWebhookSecret,
  parseSignatureHeader,
  signPayload,
  verifySignature,
} from "../src/lib/webhooks/sign";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const SECRET = "whsec_orbit_testsecret";
const BODY = '{"id":"evt_1","type":"contact.created"}';
const T = 1_757_001_600;

function main() {
  // --- A known vector, so an accidental change to the signed string is caught -------------
  const header = signPayload(SECRET, BODY, T);
  check("the header carries the timestamp and a v1 signature", /^t=\d+,v1=[0-9a-f]{64}$/.test(header), header);
  check(
    "signing is deterministic",
    signPayload(SECRET, BODY, T) === header
  );

  const parsed = parseSignatureHeader(header);
  check("the header parses", parsed?.timestamp === T && parsed.signatures.length === 1);

  // --- Verification accepts what it produced ------------------------------------------------
  check(
    "a fresh signature verifies",
    verifySignature({ secret: SECRET, body: BODY, header, nowSeconds: T })
  );

  // --- and rejects everything else -----------------------------------------------------------
  check(
    "a one-byte body change breaks it",
    !verifySignature({ secret: SECRET, body: BODY + " ", header, nowSeconds: T })
  );
  check(
    "the wrong secret fails",
    !verifySignature({ secret: "whsec_orbit_other", body: BODY, header, nowSeconds: T })
  );
  check(
    "a missing header fails",
    !verifySignature({ secret: SECRET, body: BODY, header: null, nowSeconds: T })
  );
  check(
    "a garbage header fails",
    !verifySignature({ secret: SECRET, body: BODY, header: "not-a-signature", nowSeconds: T })
  );

  // --- Replay ---------------------------------------------------------------------------------
  check(
    "a signature just inside the tolerance still verifies",
    verifySignature({
      secret: SECRET,
      body: BODY,
      header,
      nowSeconds: T + SIGNATURE_TOLERANCE_SECONDS - 1,
    })
  );
  check(
    "a stale signature is rejected",
    !verifySignature({
      secret: SECRET,
      body: BODY,
      header,
      nowSeconds: T + SIGNATURE_TOLERANCE_SECONDS + 1,
    })
  );

  // The reason the timestamp is INSIDE the signed string: an attacker replaying a captured
  // request will rewrite `t` to defeat the freshness check. That must invalidate the MAC.
  const forged = header.replace(`t=${T}`, `t=${T + 10_000}`);
  check(
    "rewriting the timestamp invalidates the signature",
    !verifySignature({ secret: SECRET, body: BODY, header: forged, nowSeconds: T + 10_000 })
  );

  // --- Forwards compatibility -------------------------------------------------------------------
  const withV2 = `${header},v2=deadbeef`;
  check(
    "an unknown scheme alongside v1 is tolerated",
    verifySignature({ secret: SECRET, body: BODY, header: withV2, nowSeconds: T })
  );
  check(
    "a v1 that is only nearly right fails",
    !verifySignature({
      secret: SECRET,
      body: BODY,
      header: header.slice(0, -1) + (header.endsWith("a") ? "b" : "a"),
      nowSeconds: T,
    })
  );

  // --- Secrets and envelopes ------------------------------------------------------------------
  const secret = generateWebhookSecret();
  check("a generated secret is namespaced", secret.startsWith("whsec_orbit_"), secret.slice(0, 16));
  check("two secrets differ", generateWebhookSecret() !== generateWebhookSecret());

  const envelope = buildEnvelope({
    id: "evt_abc",
    type: "contact.created",
    createdAt: new Date("2026-09-04T00:00:00Z"),
    object: { id: "c1" },
  });
  check("the envelope carries a stable top-level id", envelope.id === "evt_abc");
  check("the envelope is versioned", envelope.apiVersion === "2026-09-01");
  check("the payload is nested under data.object", (envelope.data.object as { id: string }).id === "c1");
  check("timestamps are ISO-8601", envelope.createdAt === "2026-09-04T00:00:00.000Z");

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll webhook signing checks passed.");
}

main();
