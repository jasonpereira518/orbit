/**
 * Asserts that deleting an account in Clerk deletes it here too — including the settings
 * row — while the Settings "Delete data" path keeps that row on purpose.
 *
 * The two paths look alike and must not behave alike. "Delete data" runs for someone who is
 * still signed in, so their email, name and encrypted provider keys survive it
 * (`purgeUserData`'s default `keepSettings: true`). A `user.deleted` webhook means the
 * account no longer exists; keeping the row there left the person's identity, live
 * third-party API keys and Stripe customer id in the admin roster forever (audit A2).
 *
 * Drives the real webhook route with a real Standard Webhooks signature computed here —
 * no Clerk account, no network.
 *
 * Run: npx tsx scripts/smoke-account-deletion.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { createHmac } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, userSettings, webhookDeliveries } from "../src/db/schema";
import { purgeUserData } from "../src/lib/user-data";
import { ensureUserSettings } from "../src/lib/user-settings";
import { POST as clerkPost } from "../src/app/api/webhooks/clerk/route";

// A real base64 secret: `verifyWebhook` strips `whsec_` and base64-decodes the rest, so the
// HMAC below is a signature it genuinely accepts. It reads the variable at call time, so
// setting it after the imports is fine.
const SECRET_BYTES = Buffer.from("orbit-smoke-clerk-signing-secret");
process.env.CLERK_WEBHOOK_SIGNING_SECRET = `whsec_${SECRET_BYTES.toString("base64")}`;

const GONE = "smoke-deletion-webhook-user";
const KEPT = "smoke-deletion-settings-user";
const DELIVERY_IDS = ["msg_smoke_deletion_1", "msg_smoke_deletion_2"];
const CIPHERTEXT = "smoke-ciphertext-not-a-real-key";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

function signedClerkRequest(payload: unknown, deliveryId: string) {
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac("sha256", SECRET_BYTES)
    .update(`${deliveryId}.${timestamp}.${body}`)
    .digest("base64");
  return new Request("http://localhost/api/webhooks/clerk", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "svix-id": deliveryId,
      "svix-timestamp": timestamp,
      "svix-signature": `v1,${signature}`,
    },
    body,
  });
}

// The route is typed for NextRequest but only reads headers and text, which Request has.
const post = (req: Request) =>
  clerkPost(req as unknown as Parameters<typeof clerkPost>[0]);

async function cleanup() {
  const db = await getDb();
  await db.delete(contacts).where(inArray(contacts.userId, [GONE, KEPT]));
  await db.delete(userSettings).where(inArray(userSettings.userId, [GONE, KEPT]));
  await db.delete(webhookDeliveries).where(inArray(webhookDeliveries.eventId, DELIVERY_IDS));
}

async function seed(userId: string) {
  const db = await getDb();
  await ensureUserSettings(userId);
  await db
    .update(userSettings)
    .set({
      email: `${userId}@example.test`,
      firstName: "Fixture",
      geminiApiKeyEncrypted: CIPHERTEXT,
      stripeCustomerId: `cus_${userId}`,
    })
    .where(eq(userSettings.userId, userId));
  await db.insert(contacts).values({ userId, fullName: "Deletion Fixture" });
}

async function settingsRows(userId: string) {
  const db = await getDb();
  return db.select().from(userSettings).where(eq(userSettings.userId, userId));
}

async function contactRows(userId: string) {
  const db = await getDb();
  return db.select().from(contacts).where(eq(contacts.userId, userId));
}

run(async () => {
  await cleanup();
  await seed(GONE);
  await seed(KEPT);

  console.log("Clerk user.deleted — the account is gone, so nothing of it stays");
  const event = {
    type: "user.deleted",
    object: "event",
    data: { id: GONE, object: "user", deleted: true },
  };
  const res = await post(signedClerkRequest(event, DELIVERY_IDS[0]));
  check("the signed webhook is accepted", res.status === 200, String(res.status));
  const gone = await settingsRows(GONE);
  check(
    "a user.deleted webhook leaves no user_settings row",
    gone.length === 0,
    JSON.stringify(gone.map((r) => ({ email: r.email, key: r.geminiApiKeyEncrypted })))
  );
  check("…and no contacts", (await contactRows(GONE)).length === 0);

  const again = await post(signedClerkRequest(event, DELIVERY_IDS[1]));
  check(
    "a redelivery is harmless",
    again.status === 200 && (await settingsRows(GONE)).length === 0,
    String(again.status)
  );

  console.log("\nSettings → Delete data — still signed in, so the row stays");
  await purgeUserData(KEPT);
  const kept = await settingsRows(KEPT);
  check("the settings row survives", kept.length === 1, String(kept.length));
  check(
    "…with the saved provider key intact",
    kept[0]?.geminiApiKeyEncrypted === CIPHERTEXT,
    String(kept[0]?.geminiApiKeyEncrypted)
  );
  check("…and the identity mirror intact", kept[0]?.email === `${KEPT}@example.test`);
  check("…while the data itself is gone", (await contactRows(KEPT)).length === 0);

  await cleanup();
  if (failures > 0) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll account-deletion checks passed.");
});
