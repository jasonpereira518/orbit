/**
 * Choosing a mailbox: explicit choice → saved default → the only sendable one → Gmail; blocked
 * results name the provider to fix; Outlook is invisible until its feature is live.
 * Run: npx tsx scripts/smoke-email-sender.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { eq, sql } from "drizzle-orm";
import { getDb } from "../src/db";
import * as schema from "../src/db/schema";
import { encrypt } from "../src/lib/crypto";
import { enqueueEmail } from "../src/lib/email/outbox";
import { getSendCapability, resolveSender, setOutlookSendOverride } from "../src/lib/email/sender";
import { saveDefaultSendProvider } from "../src/lib/email/settings";
import { GOOGLE_SCOPES } from "../src/lib/google-scopes";
import { MICROSOFT_SCOPES } from "../src/lib/microsoft-scopes";
import { purgeUserData } from "../src/lib/user-data";

const USER = "smoke-email-sender-user";
let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const token = { accessTokenEncrypted: encrypt("t"), refreshTokenEncrypted: encrypt("r"), tokenExpiresAt: new Date(Date.now() + 3_600_000) };
const summary = async (preferred?: "gmail" | "outlook") => {
  const r = await resolveSender(USER, preferred);
  return r.ok ? `ok:${r.provider}` : `${r.reason}:${r.provider}`;
};

async function main() {
  const db = await getDb();
  await purgeUserData(USER, { keepSettings: false }).catch(() => {});
  try {
    check("nothing connected", (await summary()) === "not_connected:null", await summary());

    await db.insert(schema.gmailConnections).values({ userId: USER, emailAddress: "me@gmail-mail.io", scopes: GOOGLE_SCOPES.contacts, status: "active", ...token });
    check("Gmail without send scope names Gmail", (await summary()) === "no_send_scope:gmail", await summary());

    await db.delete(schema.gmailConnections).where(eq(schema.gmailConnections.userId, USER));
    await db.insert(schema.outlookConnections).values({ userId: USER, emailAddress: "Me@Contoso.io", scopes: MICROSOFT_SCOPES.mailSend, status: "active", ...token });
    setOutlookSendOverride(null);
    check("Outlook is invisible while its feature is coming-soon", (await summary()) === "not_connected:null", await summary());

    setOutlookSendOverride(true);
    check("Outlook alone sends", (await summary()) === "ok:outlook", await summary());

    await db.insert(schema.gmailConnections).values({ userId: USER, emailAddress: "me@gmail-mail.io", scopes: GOOGLE_SCOPES.gmailSend, status: "active", ...token });
    check("both, no default → Gmail", (await summary()) === "ok:gmail");
    await saveDefaultSendProvider(USER, "outlook");
    check("saved default wins", (await summary()) === "ok:outlook");
    check("an explicit choice beats the default", (await summary("gmail")) === "ok:gmail");

    await db.update(schema.outlookConnections).set({ status: "needs_reauth" }).where(eq(schema.outlookConnections.userId, USER));
    check("default mailbox broken → falls back to the one that works", (await summary()) === "ok:gmail");
    await db.execute(sql`DELETE FROM rate_limit_buckets WHERE bucket = ${`emailSend:${USER}`}`);
    const pinned = await enqueueEmail(USER, { to: ["a@acme-corp.io"], subject: "s", bodyText: "b", origin: "compose", delayMs: 10_000, provider: "outlook" });
    check("an explicit mailbox that can't send is refused, never swapped for Gmail", !pinned.ok && pinned.reason === "not_connected", JSON.stringify(pinned));
    await db.delete(schema.gmailConnections).where(eq(schema.gmailConnections.userId, USER));
    check("nothing sendable, one needs reauth → reconnect that one", (await summary()) === "needs_reauth:outlook", await summary());

    check("saving null clears the default", (await saveDefaultSendProvider(USER, null)) === null);

    await db.update(schema.outlookConnections).set({ status: "active" }).where(eq(schema.outlookConnections.userId, USER));
    await db.insert(schema.gmailConnections).values({ userId: USER, emailAddress: "me@gmail-mail.io", scopes: GOOGLE_SCOPES.contacts, status: "active", ...token });
    const cap = await getSendCapability(USER);
    check(
      "capability lists both mailboxes with what each can do",
      cap.ok &&
        cap.mailboxes.find((m) => m.id === "gmail")?.canSend === false &&
        cap.mailboxes.find((m) => m.id === "outlook")?.canSend === true &&
        cap.outlookAvailable === true,
      JSON.stringify(cap)
    );
  } finally {
    setOutlookSendOverride(null);
    await purgeUserData(USER, { keepSettings: false }).catch(() => {});
  }
  if (failures) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll sender checks passed.");
}

run(main);
