/**
 * The email outbox end to end with a fake provider: enqueue refusals, undo, claim races,
 * leases, backoff, exhaustion, the ambiguous-send rule, auth failure, caps and logging.
 * Run: npx tsx scripts/smoke-email-sends.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { and, eq, sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import * as schema from "../src/db/schema";
import { encrypt } from "../src/lib/crypto";
import { GOOGLE_SCOPES } from "../src/lib/google-scopes";
import { cancelEmailSend, dispatchEmailSend, drainEmailSends, enqueueEmail } from "../src/lib/email/outbox";
import { readFileSync } from "node:fs";
import { setProviderOverride } from "../src/lib/email/providers";
import { MailProviderError, type MailProvider, type OutboundMessage } from "../src/lib/email/providers/types";
import { purgeUserData } from "../src/lib/user-data";

const USER = "smoke-email-sends-user";
let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

type Next = "ok" | "transient" | "permanent" | "auth" | "ambiguous";
let next: Next[] = [];
let found: "hit" | "miss" | "unknown" = "unknown";
const sent: OutboundMessage[] = [];
const fake: MailProvider = {
  id: "gmail",
  async identity() {
    return { email: "me@x.org" };
  },
  async send(_u, msg) {
    const n = next.shift() ?? "ok";
    if (n !== "ok") throw new MailProviderError(n, `fake ${n}`);
    sent.push(msg);
    return { providerMessageId: `pm-${sent.length}`, providerThreadId: "pt" };
  },
  async findSent() {
    return found === "hit" ? { providerMessageId: "pm-found", providerThreadId: "pt" } : found === "miss" ? null : "unknown";
  },
};

async function row(id: string) {
  const db = await getDb();
  return (await db.select().from(schema.emailSends).where(eq(schema.emailSends.id, id)))[0]!;
}
async function makeDue(id: string) {
  const db = await getDb();
  await db.execute(sql`UPDATE email_sends SET send_at = now() - interval '1 second' WHERE id = ${id}::uuid`);
}
async function resetBucket() {
  const db = await getDb();
  await db.execute(sql`DELETE FROM rate_limit_buckets WHERE bucket = ${`emailSend:${USER}`}`);
}
async function must(p: ReturnType<typeof enqueueEmail>) {
  const r = await p;
  if (!r.ok) throw new Error(`enqueue refused: ${r.reason}`);
  return r;
}
const base = { to: ["maya@work.org"], subject: "Hi", bodyText: "Hello Maya", origin: "compose" as const, delayMs: 0 };

async function main() {
  const db = await getDb();
  await purgeUserData(USER, { keepSettings: false }).catch(() => {});
  await resetBucket();
  setProviderOverride("gmail", fake);
  try {
    // --- refusals before connecting
    const nc = await enqueueEmail(USER, base);
    check("not connected is refused", !nc.ok && nc.reason === "not_connected");

    await db.insert(schema.gmailConnections).values({
      userId: USER,
      emailAddress: "me@x.org",
      accessTokenEncrypted: encrypt("t"),
      refreshTokenEncrypted: encrypt("r"),
      tokenExpiresAt: new Date(Date.now() + 3_600_000),
      scopes: GOOGLE_SCOPES.gmailSend,
      status: "active",
    });
    const [maya] = await db.insert(schema.contacts).values({ userId: USER, fullName: "Maya", email: "maya@work.org" }).returning();

    const empty = await enqueueEmail(USER, { ...base, bodyText: "   " });
    check("empty body is refused", !empty.ok && empty.reason === "empty_body");
    const bad = await enqueueEmail(USER, { ...base, to: ["a@x.org\r\nBcc: e@x.org"] });
    check("injection is refused", !bad.ok && bad.reason === "invalid_recipient");

    // --- happy path
    const q = await must(enqueueEmail(USER, base));
    const r0 = await row(q.id);
    check("queued with contact resolved", r0.status === "queued" && r0.contactIds.includes(maya!.id));
    check("rfc id fixed at enqueue", /^<.+@orbit\.mail>$/.test(r0.rfcMessageId));
    check("dispatch sends", (await dispatchEmailSend(q.id)) === "sent");
    const r1 = await row(q.id);
    check("row marked sent with ids", r1.status === "sent" && r1.providerMessageId === "pm-1" && r1.sentAt !== null);
    check("message used the stored Message-ID", sent[0]!.messageId === r1.rfcMessageId);
    const logged = await db
      .select()
      .from(schema.interactions)
      .where(and(eq(schema.interactions.userId, USER), eq(schema.interactions.contactId, maya!.id)));
    check(
      "one outbound email interaction logged",
      logged.length === 1 && logged[0]!.interactionType === "email" && logged[0]!.direction === "out" && logged[0]!.source === "email_send",
      JSON.stringify(logged.map((l) => [l.interactionType, l.direction, l.source]))
    );
    const touched = await db.query.contacts.findFirst({ where: eq(schema.contacts.id, maya!.id) });
    check("contact's last interaction moved", touched?.lastInteractionAt !== null && touched?.lastInteractionAt !== undefined);
    check("second dispatch is a no-op", (await dispatchEmailSend(q.id)) === "not_claimable" && sent.length === 1);

    // --- undo
    const u = await must(enqueueEmail(USER, { ...base, delayMs: 10_000 }));
    check("not due before the window", (await dispatchEmailSend(u.id)) === "not_due");
    check("undo cancels", (await cancelEmailSend(USER, u.id)) === "canceled");
    await makeDue(u.id);
    check("canceled row never sends", (await dispatchEmailSend(u.id)) === "not_claimable" && sent.length === 1);
    check("undo of a sent row says already_sent", (await cancelEmailSend(USER, q.id)) === "already_sent");
    check("undo of someone else's row is not_found", (await cancelEmailSend("someone-else", u.id)) === "not_found");
    const noLog = await db.select().from(schema.interactions).where(eq(schema.interactions.userId, USER));
    check("an undone send logs nothing", noLog.length === 1);

    // --- concurrent claim: exactly one send
    const c = await must(enqueueEmail(USER, base));
    const outcomes = await Promise.all([dispatchEmailSend(c.id), dispatchEmailSend(c.id)]);
    check("two dispatchers, one send", outcomes.filter((o) => o === "sent").length === 1, outcomes.join());

    // --- burst bucket: 10 per 10 minutes
    await resetBucket();
    const burst: boolean[] = [];
    for (let i = 0; i < 11; i++) {
      const r = await enqueueEmail(USER, { ...base, delayMs: 3_600_000 });
      burst.push(r.ok || r.reason !== "rate_limited");
    }
    check("11th send in the window is rate limited", burst.slice(0, 10).every(Boolean) && burst[10] === false);
    await db.execute(sql`UPDATE email_sends SET status = 'canceled' WHERE user_id = ${USER} AND status = 'queued'`);

    // --- transient → retry with backoff, then success after a Sent miss
    await resetBucket();
    next = ["transient"];
    const t = await must(enqueueEmail(USER, base));
    check("transient → retry", (await dispatchEmailSend(t.id)) === "retry");
    const rt = await row(t.id);
    check("back in queue, due ~1 minute out", rt.status === "queued" && rt.sendAt.getTime() > Date.now() + 30_000 && rt.claimedBy === null);
    await makeDue(t.id);
    found = "miss";
    check("retry sends after Sent-folder miss", (await dispatchEmailSend(t.id)) === "sent");

    // --- exhaustion
    const x = await must(enqueueEmail(USER, base));
    for (let i = 0; i < 5; i++) {
      next = ["transient"];
      await makeDue(x.id);
      await dispatchEmailSend(x.id);
    }
    const rx = await row(x.id);
    check("5 attempts → failed/exhausted", rx.status === "failed" && rx.failureKind === "exhausted" && rx.attempts === 5, `${rx.status}/${rx.failureKind}/${rx.attempts}`);

    // --- permanent and auth
    next = ["permanent"];
    const p = await must(enqueueEmail(USER, base));
    check("permanent → failed", (await dispatchEmailSend(p.id)) === "failed" && (await row(p.id)).failureKind === "permanent");
    next = ["auth"];
    const a = await must(enqueueEmail(USER, base));
    check("auth → failed", (await dispatchEmailSend(a.id)) === "failed" && (await row(a.id)).failureKind === "auth");
    const flagged = await db.query.gmailConnections.findFirst({ where: eq(schema.gmailConnections.userId, USER) });
    check("auth failure flags the connection", flagged?.status === "needs_reauth");
    await db.update(schema.gmailConnections).set({ status: "active" }).where(eq(schema.gmailConnections.userId, USER));

    // --- ambiguous: never sent twice
    await resetBucket();
    const before = sent.length;
    next = ["ambiguous"];
    found = "unknown";
    const m = await must(enqueueEmail(USER, base));
    check("ambiguous → retry", (await dispatchEmailSend(m.id)) === "retry");
    await makeDue(m.id);
    check("ambiguous + unknown Sent → failed", (await dispatchEmailSend(m.id)) === "failed");
    const rm = await row(m.id);
    check("marked ambiguous, provider never re-called", rm.failureKind === "ambiguous" && sent.length === before);

    next = ["ambiguous"];
    const h = await must(enqueueEmail(USER, base));
    await dispatchEmailSend(h.id);
    await makeDue(h.id);
    found = "hit";
    check(
      "ambiguous + found in Sent → sent without resending",
      (await dispatchEmailSend(h.id)) === "sent" && (await row(h.id)).providerMessageId === "pm-found" && sent.length === before
    );

    // --- lease lapse
    const l = await must(enqueueEmail(USER, base));
    await db.execute(
      sql`UPDATE email_sends SET status = 'sending', claimed_by = gen_random_uuid(), lease_until = now() - interval '1 second', attempts = 1 WHERE id = ${l.id}::uuid`
    );
    found = "miss";
    check("lapsed lease is re-claimable", (await dispatchEmailSend(l.id)) === "sent");
    const held = await must(enqueueEmail(USER, base));
    await db.execute(
      sql`UPDATE email_sends SET status = 'sending', claimed_by = gen_random_uuid(), lease_until = now() + interval '1 minute', attempts = 1 WHERE id = ${held.id}::uuid`
    );
    check("a live lease is not stolen", (await dispatchEmailSend(held.id)) === "not_claimable");

    // --- idempotency
    await resetBucket();
    const k1 = await enqueueEmail(USER, { ...base, idempotencyKey: "k-1", delayMs: 10_000 });
    const k2 = await enqueueEmail(USER, { ...base, idempotencyKey: "k-1" });
    check("duplicate key refused while active", k1.ok && !k2.ok && k2.reason === "duplicate");
    if (k1.ok) await cancelEmailSend(USER, k1.id);
    check("key reusable after cancel", (await enqueueEmail(USER, { ...base, idempotencyKey: "k-1", delayMs: 10_000 })).ok);

    // --- daily cap (free plan: 20). Canceled/failed rows don't count.
    await resetBucket();
    const [{ n }] = rowsOf<{ n: number }>(
      await db.execute(sql`SELECT count(*)::int AS n FROM email_sends WHERE user_id = ${USER} AND status IN ('queued','sending','sent')`)
    );
    const fill = Math.max(0, 20 - Number(n));
    await db.execute(sql`INSERT INTO email_sends (user_id, provider, from_email, to_emails, subject, body_text, origin, status, send_at, rfc_message_id)
      SELECT ${USER}, 'gmail', 'me@x.org', '["z@x.org"]'::jsonb, 's', 'b', 'chat', 'sent', now(), '<cap-' || g || '@orbit.mail>' FROM generate_series(1, ${fill}::int) g`);
    const capped = await enqueueEmail(USER, base);
    check("21st send in 24h refused on Free", !capped.ok && capped.reason === "cap_reached", JSON.stringify(capped));

    // --- drain picks up due rows and lapsed leases, skips future ones
    await db.execute(sql`DELETE FROM email_sends WHERE user_id = ${USER} AND origin = 'chat'`);
    await resetBucket();
    const d1 = await must(enqueueEmail(USER, { ...base, delayMs: 0 }));
    const d2 = await must(enqueueEmail(USER, { ...base, delayMs: 3_600_000 }));
    const stats = await drainEmailSends({ budgetMs: 30_000, max: 50 });
    check("drain sent the due row", (await row(d1.id)).status === "sent", JSON.stringify(stats));
    check("drain left the future row queued", (await row(d2.id)).status === "queued");

    // --- source guard: the claim keeps the lease predicate and the DB-clock lease
    const src = readFileSync("src/lib/email/outbox.ts", "utf8");
    check("claim leases on the DB clock", src.includes("lease_until = now() +"));
    check("claim takes lapsed leases only", src.includes("status = 'sending' AND lease_until < now()"));
    check("outbox never imports next/server directly", !/from "next\/server"/.test(src));
  } finally {
    setProviderOverride("gmail", null);
    await resetBucket();
    await purgeUserData(USER, { keepSettings: false }).catch(() => {});
  }
  if (failures) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll email-outbox checks passed.");
}

run(main);
