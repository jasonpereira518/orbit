/**
 * A Resend rejection on ORBIT's key is recorded as `resend.rejected` (audit A11): every
 * waitlist welcome of Sep 7–9 2026 was refused (RESEND_FROM_EMAIL on an unverified
 * domain) and only a one-hour console line knew.
 *
 * Drives the real send paths — `sendOutreachMessage` and the interest-list follow-up —
 * against a local stand-in for Resend's API (`RESEND_BASE_URL`) that answers the way Resend
 * does for an unverified sender domain. Nothing leaves the machine.
 *
 * The line it holds: a user's OWN Resend key being refused is that user's configuration,
 * shown to them on the message; it must not page Orbit's ops channel as "Resend is refusing
 * Orbit's email".
 *
 * Run: npx tsx scripts/smoke-resend-rejection.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import http from "node:http";
import type { AddressInfo } from "node:net";

const RESEND_REFUSAL = {
  statusCode: 403,
  name: "validation_error",
  message: "The gmail.com domain is not verified. Please, add and verify your domain on https://resend.com/domains",
};

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const HOSTED = "smoke-resend-hosted";
const BYOK = "smoke-resend-byok";

run(async () => {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      // A BYOK sender's From is resolved from their own verified domains (see
      // `outreach-sender.ts`), so that lookup has to answer before the send is attempted.
      // It is not the subject of this test — the refused SEND is.
      if (req.url?.startsWith("/domains")) {
        res.statusCode = 200;
        res.end(JSON.stringify({ data: [{ name: "acme-robotics.io", status: "verified" }] }));
        return;
      }
      hits.push(`${req.headers.authorization} ${body.length}`);
      res.statusCode = 403;
      res.end(JSON.stringify(RESEND_REFUSAL));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;

  // Before any module that constructs a Resend client is loaded.
  const priorEnv = { ...process.env };
  process.env.RESEND_BASE_URL = `http://localhost:${port}`;
  process.env.RESEND_API_KEY = "re_orbit_env_key";
  process.env.RESEND_FROM_EMAIL = "someone@gmail.com";

  const { eq, inArray } = await import("drizzle-orm");
  const { getDb } = await import("../src/db");
  const { errorEvents, userSettings } = await import("../src/db/schema");
  const { encrypt } = await import("../src/lib/crypto");
  const { ERROR_SOURCES } = await import("../src/lib/error-events");
  const { ensureUserSettings } = await import("../src/lib/user-settings");
  const { sendOutreachMessage } = await import("../src/lib/outreach-send");
  const { sendFrontWaveEmail } = await import("../src/lib/interest-list-email");

  const db = await getDb();
  const rejections = async () =>
    db.select().from(errorEvents).where(eq(errorEvents.source, ERROR_SOURCES.resendRejected));
  const cleanup = async () => {
    await db.delete(errorEvents).where(eq(errorEvents.source, ERROR_SOURCES.resendRejected));
    await db.delete(userSettings).where(inArray(userSettings.userId, [HOSTED, BYOK]));
  };

  try {
    await cleanup();
    await ensureUserSettings(HOSTED);
    await ensureUserSettings(BYOK);
    // A paid plan, so the hosted (Orbit env) key is the one used.
    await db.update(userSettings).set({ compedPlan: "orbit" }).where(eq(userSettings.userId, HOSTED));
    await db
      .update(userSettings)
      .set({ resendApiKeyEncrypted: encrypt("re_user_own_key") })
      .where(eq(userSettings.userId, BYOK));

    // An address the placeholder guard accepts; it only ever reaches the local stand-in.
    const to = "jordan@acme-robotics.io";

    console.log("Outreach on Orbit's key");
    const hostedErr = await sendOutreachMessage({ userId: HOSTED, channel: "email", toEmail: to, subject: "Hi", body: "Hello" })
      .then(() => null, (e: unknown) => e as Error);
    check("the send still fails for the sender", hostedErr instanceof Error);
    check("…and used Orbit's key", hits.at(-1)?.startsWith("Bearer re_orbit_env_key") === true, hits.at(-1));
    const afterHosted = await rejections();
    const outreachRow = afterHosted.find((r) => r.kind === "outreach");
    check("a resend.rejected row is recorded", Boolean(outreachRow), JSON.stringify(afterHosted));
    check("…with Resend's own reason, which names the cause", outreachRow?.message?.includes("domain is not verified") === true, String(outreachRow?.message));
    check("…attributed to the sender", outreachRow?.userId === HOSTED);

    console.log("\nOutreach on the user's own key");
    const before = (await rejections()).length;
    const byokErr = await sendOutreachMessage({ userId: BYOK, channel: "email", toEmail: to, subject: "Hi", body: "Hello" })
      .then(() => null, (e: unknown) => e as Error);
    check("the send fails for the sender, with Resend's reason", byokErr?.message.includes("domain is not verified") === true, byokErr?.message);
    check("…and used their key", hits.at(-1)?.startsWith("Bearer re_user_own_key") === true, hits.at(-1));
    check("…and does NOT record resend.rejected (it is not Orbit's email)", (await rejections()).length === before);

    console.log("\nWaitlist front-wave notice (always Orbit's key)");
    const sent = await sendFrontWaveEmail("someone.waiting@acme-robotics.io", "https://waitlist.example/unsubscribe/x", "saturn", { ticketUrl: "https://waitlist.example/?me=x", shareUrl: "https://waitlist.example/?ref=x" });
    check("reports not sent", sent === false);
    const followUp = (await rejections()).find((r) => r.kind === "interest.front-wave");
    check("a resend.rejected row is recorded", Boolean(followUp));
    check("…as a rejection, not a thrown call", (followUp?.context as { phase?: string } | null)?.phase === "rejected", JSON.stringify(followUp?.context));

    console.log("\nResend unreachable");
    server.close();
    await new Promise((r) => setTimeout(r, 50));
    const sentDown = await sendFrontWaveEmail("someone.else@acme-robotics.io", "https://waitlist.example/unsubscribe/y", "saturn", { ticketUrl: "https://waitlist.example/?me=x", shareUrl: "https://waitlist.example/?ref=x" });
    const thrown = (await rejections()).filter((r) => r.kind === "interest.front-wave");
    check("still reports not sent, and never throws", sentDown === false);
    check("…and records it too", thrown.length === 2, String(thrown.length));
  } finally {
    await cleanup();
    server.close();
    for (const key of ["RESEND_BASE_URL", "RESEND_API_KEY", "RESEND_FROM_EMAIL"]) {
      if (priorEnv[key] === undefined) delete process.env[key];
      else process.env[key] = priorEnv[key];
    }
  }

  if (failures > 0) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll Resend rejection checks passed.");
});
