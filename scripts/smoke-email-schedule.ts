/**
 * Scheduled send: bounds, the drain waiting for the time, cancel, cap counting at creation,
 * and attachments carried from enqueue to the provider. Run: npx tsx scripts/smoke-email-schedule.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { eq, sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import * as schema from "../src/db/schema";
import { encrypt } from "../src/lib/crypto";
import { GOOGLE_SCOPES } from "../src/lib/google-scopes";
import { setAttachmentBlobClientForTests } from "../src/lib/email/attachments";
import { cancelEmailSend, dispatchEmailSend, drainEmailSends, enqueueEmail } from "../src/lib/email/outbox";
import { setProviderOverride } from "../src/lib/email/providers";
import type { MailProvider, OutboundMessage } from "../src/lib/email/providers/types";
import { purgeUserData } from "../src/lib/user-data";

const USER = "smoke-email-schedule-user";
let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const sent: OutboundMessage[] = [];
const fake: MailProvider = {
  id: "gmail",
  async identity() { return { email: "me@acme-corp.io" }; },
  async send(_u, msg) { sent.push(msg); return { providerMessageId: `pm-${sent.length}`, providerThreadId: null }; },
  async findSent() { return null; },
};
const base = { to: ["maya@work.io"], subject: "Later", bodyText: "Hi", origin: "compose" as const, delayMs: 10_000 };
const at = (ms: number) => new Date(Date.now() + ms);

async function main() {
  const db = await getDb();
  await purgeUserData(USER, { keepSettings: false }).catch(() => {});
  setProviderOverride("gmail", fake);
  setAttachmentBlobClientForTests({
    async head(p) { return { pathname: p, url: p, size: 3, contentType: "text/plain" }; },
    async get() { return { bytes: new TextEncoder().encode("abc") }; },
    async del() {},
    async list() { return { blobs: [], hasMore: false }; },
  });
  try {
    await db.insert(schema.gmailConnections).values({
      userId: USER, emailAddress: "me@acme-corp.io", accessTokenEncrypted: encrypt("t"), refreshTokenEncrypted: encrypt("r"),
      tokenExpiresAt: new Date(Date.now() + 3_600_000), scopes: GOOGLE_SCOPES.gmailSend, status: "active",
    });
    const reset = () => db.execute(sql`DELETE FROM rate_limit_buckets WHERE bucket = ${`emailSend:${USER}`}`);

    console.log("bounds");
    await reset();
    const soon = await enqueueEmail(USER, { ...base, sendAt: at(10_000) });
    check("less than a minute out is refused", !soon.ok && soon.reason === "bad_schedule");
    const far = await enqueueEmail(USER, { ...base, sendAt: at(31 * 24 * 3600_000) });
    check("more than 30 days out is refused", !far.ok && far.reason === "bad_schedule");

    console.log("the drain waits for the time");
    const later = await enqueueEmail(USER, { ...base, sendAt: at(2 * 3600_000) });
    check("two hours out is queued", later.ok);
    await drainEmailSends({ budgetMs: 120_000, max: 50 });
    check("the drain leaves it alone", sent.length === 0);
    if (later.ok) {
      const r = await db.query.emailSends.findFirst({ where: eq(schema.emailSends.id, later.id) });
      check("send_at is the chosen time", Math.abs(r!.sendAt.getTime() - later.sendAt.getTime()) < 1000);
      await db.execute(sql`UPDATE email_sends SET send_at = now() - interval '1 second' WHERE id = ${later.id}::uuid`);
      await drainEmailSends({ budgetMs: 120_000, max: 50 });
      check("once due, the drain sends it", sent.length === 1);
    }

    console.log("cancel and cap");
    await reset();
    const toCancel = await enqueueEmail(USER, { ...base, sendAt: at(3600_000) });
    check("a scheduled send can be canceled", toCancel.ok && (await cancelEmailSend(USER, toCancel.id)) === "canceled");
    const [{ n }] = rowsOf<{ n: number }>(
      await db.execute(sql`SELECT count(*)::int AS n FROM email_sends WHERE user_id = ${USER} AND status IN ('queued','sending','sent')`)
    );
    check("scheduled sends count toward today's cap when created", Number(n) >= 1);

    console.log("attachments ride along");
    await reset();
    const withFile = await enqueueEmail(USER, {
      ...base,
      delayMs: 0,
      attachments: [{ blobKey: `email-attachments/${USER}/a/notes.txt`, filename: "notes.txt", contentType: "text/plain", size: 3 }],
    });
    if (withFile.ok) await dispatchEmailSend(withFile.id);
    const last = sent[sent.length - 1];
    check("the provider gets the file", last?.attachments?.[0]?.filename === "notes.txt" && last.attachments[0]!.bytes.length === 3, JSON.stringify(last?.attachments?.map((a) => a.filename)));
  } finally {
    setProviderOverride("gmail", null);
    setAttachmentBlobClientForTests(null);
    await purgeUserData(USER, { keepSettings: false }).catch(() => {});
  }
  if (failures) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll schedule checks passed.");
}

run(main);
