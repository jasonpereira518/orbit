/**
 * A Resend rejection on ORBIT's key is recorded as `resend.rejected` (audit A11): every
 * waitlist welcome of Sep 7–9 2026 was refused (RESEND_FROM_EMAIL on an unverified
 * domain) and only a one-hour console line knew.
 *
 * Drives the real send path — the interest-list tier notice — against a local stand-in for
 * Resend's API (`RESEND_BASE_URL`) that answers the way Resend does for an unverified sender
 * domain. Nothing leaves the machine. (Campaign email no longer goes through Resend: it sends
 * from the user's own mailbox.)
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

run(async () => {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
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

  const { eq } = await import("drizzle-orm");
  const { getDb } = await import("../src/db");
  const { errorEvents } = await import("../src/db/schema");
  const { ERROR_SOURCES } = await import("../src/lib/error-events");
  const { sendTierEmail } = await import("../src/lib/interest-list-email");
  const { REFERRAL_TIERS } = await import("../src/lib/interest-list");
  const tier = REFERRAL_TIERS[1]!;

  const db = await getDb();
  const rejections = async () =>
    db.select().from(errorEvents).where(eq(errorEvents.source, ERROR_SOURCES.resendRejected));
  const cleanup = async () => {
    await db.delete(errorEvents).where(eq(errorEvents.source, ERROR_SOURCES.resendRejected));
  };

  try {
    await cleanup();
    console.log("Waitlist tier notice (always Orbit's key)");
    const sent = await sendTierEmail("someone.waiting@acme-robotics.io", "https://waitlist.example/unsubscribe/x", "saturn", { ticketUrl: "https://waitlist.example/?me=x", shareUrl: "https://waitlist.example/?ref=x" }, tier);
    check("reports not sent", sent === false);
    check("…and used Orbit's key", hits.at(-1)?.startsWith("Bearer re_orbit_env_key") === true, hits.at(-1));
    const followUp = (await rejections()).find((r) => r.kind === "interest.tier");
    check("a resend.rejected row is recorded", Boolean(followUp));
    check("…as a rejection, not a thrown call", (followUp?.context as { phase?: string } | null)?.phase === "rejected", JSON.stringify(followUp?.context));

    console.log("\nResend unreachable");
    server.close();
    await new Promise((r) => setTimeout(r, 50));
    const sentDown = await sendTierEmail("someone.else@acme-robotics.io", "https://waitlist.example/unsubscribe/y", "saturn", { ticketUrl: "https://waitlist.example/?me=x", shareUrl: "https://waitlist.example/?ref=x" }, tier);
    const thrown = (await rejections()).filter((r) => r.kind === "interest.tier");
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
