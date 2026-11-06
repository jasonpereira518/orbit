/**
 * Resend's webhook signature (Standard Webhooks / Svix scheme), and the route that trusts it.
 *
 * `/api/webhooks/(.*)` is a PUBLIC route (src/lib/public-routes.ts), so the HMAC in
 * `verifyResendSignature` (src/lib/resend-webhook.ts) is the only credential on
 * `/api/webhooks/resend` — and that route WRITES: a verified bounce or complaint stamps
 * `unsubscribed_at` on the interest list. A verifier that accepted a tampered body, a stale
 * replay, or an unsigned request would let anyone unsubscribe any waitlist address.
 *
 * The verifier is implemented in-house (no `svix` dependency), so its edge cases are pinned
 * here rather than trusted to a library: the HMAC covers `id.timestamp.body` byte-for-byte,
 * the ±300 s window holds in both directions (via the injectable `nowSeconds`), a rotation
 * header carrying several space-separated signatures is accepted if any one matches, and
 * versions other than `v1` are ignored rather than guessed at.
 *
 * Then the route itself, called directly as smoke-webhook-guard does: with the secret unset
 * it must answer 500 (fail closed — never 2xx, which would make Resend drop feedback, and
 * never process the body), a bad signature is 400 with no write, and a correctly signed
 * bounce is the one thing that suppresses an address.
 *
 * Run: npx tsx scripts/smoke-resend-signature.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { createHmac, randomUUID } from "node:crypto";
import { and, eq, gte } from "drizzle-orm";
import { getDb } from "../src/db";
import { interestListSignups, webhookDeliveries } from "../src/db/schema";
import { TIMESTAMP_TOLERANCE_S, verifyResendSignature } from "../src/lib/resend-webhook";
import { POST as resendPost } from "../src/app/api/webhooks/resend/route";
import { checker } from "./smoke/check";

const KEY_BYTES = Buffer.from("smoke-resend-signing-key-not-real");
const SECRET = `whsec_${KEY_BYTES.toString("base64")}`;
const OTHER_SECRET = `whsec_${Buffer.from("a-different-key-not-real").toString("base64")}`;
const NOW = 1_800_000_000;

function sign(secret: string, id: string, timestamp: string, payload: string): string {
  const raw = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  return createHmac("sha256", Buffer.from(raw, "base64")).update(`${id}.${timestamp}.${payload}`).digest("base64");
}

const BODY = JSON.stringify({ type: "email.bounced", data: { to: ["someone@example.com"] } });
const ID = "msg_smoke_1";
const TS = String(NOW);
const SIG = `v1,${sign(SECRET, ID, TS, BODY)}`;

type Input = Parameters<typeof verifyResendSignature>[0];
const base: Input = { secret: SECRET, payload: BODY, id: ID, timestamp: TS, signature: SIG, nowSeconds: NOW };
const verdict = (over: Partial<Input>) => {
  const r = verifyResendSignature({ ...base, ...over });
  return r.ok ? "ok" : r.reason;
};

function routeRequest(body: string, headers: Record<string, string>): Request {
  return new Request("http://localhost/api/webhooks/resend", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}
const post = (r: Request) => resendPost(r as never);

run(async () => {
  const t = checker();

  // --- The verifier, pure -------------------------------------------------------------------
  console.log("verifyResendSignature…");
  t.check("a correctly signed delivery verifies", verdict({}) === "ok");
  t.check("the whsec_ prefix is optional on the secret", verdict({ secret: SECRET.slice(6) }) === "ok");
  t.check("a signature made with another secret is refused", verdict({ signature: `v1,${sign(OTHER_SECRET, ID, TS, BODY)}` }) === "bad_signature");

  t.check("a tampered body is refused", verdict({ payload: BODY.replace("someone", "victim") }) === "bad_signature");
  t.check("a body re-serialised with different whitespace is refused", verdict({ payload: JSON.stringify(JSON.parse(BODY), null, 1) }) === "bad_signature");
  t.check("a tampered id is refused", verdict({ id: "msg_smoke_2" }) === "bad_signature");
  // Inside the window, so it is the HMAC — not the clock — that refuses it.
  t.check("a tampered timestamp is refused", verdict({ timestamp: String(NOW + 1) }) === "bad_signature");

  // Replay window: re-sign at each edge so only the clock can refuse.
  const signedAt = (sent: number) => ({ timestamp: String(sent), signature: `v1,${sign(SECRET, ID, String(sent), BODY)}` });
  t.check("the tolerance is five minutes", TIMESTAMP_TOLERANCE_S === 300);
  t.check("exactly 300 s old is accepted", verdict(signedAt(NOW - 300)) === "ok");
  t.check("301 s old is refused as a replay", verdict(signedAt(NOW - 301)) === "bad_timestamp");
  t.check("exactly 300 s in the future is accepted", verdict(signedAt(NOW + 300)) === "ok");
  t.check("301 s in the future is refused", verdict(signedAt(NOW + 301)) === "bad_timestamp");
  t.check("an old timestamp is refused even when its signature is valid", verdict({ ...signedAt(NOW - 86_400) }) === "bad_timestamp");
  t.check("a non-numeric timestamp is refused", verdict({ timestamp: "yesterday" }) === "bad_timestamp");
  t.check(
    "without nowSeconds the real clock decides (a fixed 2027 timestamp is judged against now)",
    verifyResendSignature({ ...base, nowSeconds: undefined }).ok === (Math.abs(Math.floor(Date.now() / 1000) - NOW) <= 300)
  );

  // Rotation.
  const good = sign(SECRET, ID, TS, BODY);
  const stale = sign(OTHER_SECRET, ID, TS, BODY);
  t.check("rotation: old-key signature first, current second → accepted", verdict({ signature: `v1,${stale} v1,${good}` }) === "ok");
  t.check("rotation: current first, old second → accepted", verdict({ signature: `v1,${good} v1,${stale}` }) === "ok");
  t.check("rotation: extra spaces between entries are tolerated", verdict({ signature: `  v1,${stale}   v1,${good} ` }) === "ok");
  t.check("rotation: two wrong signatures → refused", verdict({ signature: `v1,${stale} v1,${stale}` }) === "bad_signature");

  // Versions.
  t.check("a v2 entry carrying the right MAC is ignored, not accepted", verdict({ signature: `v2,${good}` }) === "bad_signature");
  t.check("a v1a entry is ignored", verdict({ signature: `v1a,${good}` }) === "bad_signature");
  t.check("a non-v1 entry alongside a valid v1 does not spoil it", verdict({ signature: `v2,garbage v1,${good}` }) === "ok");
  // Pinned, not endorsed: an entry with no comma is read as v1 (the parser's documented default).
  t.check("a bare signature with no version prefix is read as v1", verdict({ signature: good }) === "ok");
  t.check("a truncated signature is refused (no length-mismatch throw)", verdict({ signature: `v1,${good.slice(0, -2)}` }) === "bad_signature");
  t.check("an empty v1 value is refused", verdict({ signature: "v1," }) === "bad_signature");

  // Missing headers.
  t.check("no id → missing_headers", verdict({ id: null }) === "missing_headers");
  t.check("no timestamp → missing_headers", verdict({ timestamp: null }) === "missing_headers");
  t.check("no signature → missing_headers", verdict({ signature: null }) === "missing_headers");
  t.check("empty-string signature → missing_headers", verdict({ signature: "" }) === "missing_headers");

  // --- The route ----------------------------------------------------------------------------
  console.log("\n/api/webhooks/resend…");
  const db = await getDb();
  const victim = `resend-victim-${randomUUID().slice(0, 8)}@example.com`;
  const started = new Date();
  await db.insert(interestListSignups).values({ email: victim, unsubscribeToken: `smoke-${randomUUID()}` });
  const unsubscribed = async () =>
    (await db.query.interestListSignups.findFirst({ where: eq(interestListSignups.email, victim) }))?.unsubscribedAt ?? null;

  const event = JSON.stringify({ type: "email.bounced", data: { email_id: "em_smoke", to: [victim], bounce: { type: "hard" } } });
  const nowS = () => String(Math.floor(Date.now() / 1000));
  const signedHeaders = (secret: string, body: string, id: string, ts = nowS()) => ({
    "svix-id": id,
    "svix-timestamp": ts,
    "svix-signature": `v1,${sign(secret, id, ts, body)}`,
  });

  try {
    const env = process.env as Record<string, string | undefined>;
    delete env.RESEND_WEBHOOK_SECRET;
    const unsetId = `smoke-unset-${randomUUID()}`;
    let res = await post(routeRequest(event, signedHeaders(SECRET, event, unsetId)));
    t.check("secret unset → 500 (fail closed, not 2xx)", res.status === 500, String(res.status));
    t.check("…and the signed bounce was NOT acted on", (await unsubscribed()) === null);
    const notConfigured = await db
      .select()
      .from(webhookDeliveries)
      .where(and(eq(webhookDeliveries.source, "resend"), eq(webhookDeliveries.eventId, unsetId), gte(webhookDeliveries.createdAt, started)));
    t.check(
      "…and the misconfiguration is recorded as an error",
      notConfigured.length === 1 && notConfigured[0].reason === "not_configured" && notConfigured[0].outcome === "error",
      JSON.stringify(notConfigured.map((r) => [r.outcome, r.reason]))
    );

    env.RESEND_WEBHOOK_SECRET = "   ";
    res = await post(routeRequest(event, signedHeaders(SECRET, event, `smoke-blank-${randomUUID()}`)));
    t.check("a whitespace-only secret counts as unset → 500", res.status === 500, String(res.status));

    env.RESEND_WEBHOOK_SECRET = SECRET;
    res = await post(routeRequest(event, {}));
    t.check("no signature headers → 400", res.status === 400, String(res.status));
    res = await post(routeRequest(event, signedHeaders(OTHER_SECRET, event, `smoke-wrong-${randomUUID()}`)));
    t.check("signed with the wrong secret → 400", res.status === 400, String(res.status));
    const tamperedId = `smoke-tamper-${randomUUID()}`;
    const headers = signedHeaders(SECRET, event, tamperedId);
    res = await post(routeRequest(event.replace("hard", "soft"), headers));
    t.check("a body altered after signing → 400", res.status === 400, String(res.status));
    const oldTs = String(Math.floor(Date.now() / 1000) - 3600);
    res = await post(routeRequest(event, signedHeaders(SECRET, event, `smoke-replay-${randomUUID()}`, oldTs)));
    t.check("a correctly signed delivery from an hour ago → 400 (replay)", res.status === 400, String(res.status));
    t.check("no refused request suppressed the address", (await unsubscribed()) === null);

    // `webhook-*` header aliases are honoured too — the same verifier, the other spelling.
    const id = `smoke-ok-${randomUUID()}`;
    const ts = nowS();
    res = await post(
      routeRequest(event, { "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": `v1,${sign(SECRET, id, ts, event)}` })
    );
    t.check("a correctly signed bounce (webhook-* headers) → 200", res.status === 200, String(res.status));
    t.check("…and that one suppressed the address (positive control)", (await unsubscribed()) instanceof Date);
  } finally {
    await db.delete(interestListSignups).where(eq(interestListSignups.email, victim));
    delete (process.env as Record<string, string | undefined>).RESEND_WEBHOOK_SECRET;
  }

  t.done("resend signature");
});
