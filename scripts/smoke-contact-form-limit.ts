/**
 * The public contact form spends Orbit's Resend key, so it is limited per IP in Postgres —
 * across every instance, unlike the old in-memory Map.
 * Run: npx tsx scripts/smoke-contact-form-limit.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { like } from "drizzle-orm";
import { getDb } from "../src/db";
import { rateLimitBuckets } from "../src/db/schema";
import { clientIpFrom } from "../src/lib/client-ip";
import { submitContactMessageCore, type ContactSender } from "../src/lib/contact-message-submit";
import { RATE_LIMITS } from "../src/lib/rate-limit";

process.env.RESEND_API_KEY = "re_smoke";
process.env.CONTACT_INBOX_EMAIL = "inbox@example.test";
process.env.RESEND_FROM_EMAIL = "orbit@example.test";
let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const input = {
  name: "Ada", email: "ada@example.test", topic: "idea" as const,
  message: "Orbit should remember birthdays for me, please.", website: "", elapsedMs: 5_000,
};

run(async () => {
  console.log("clientIpFrom");
  const h = (pairs: Record<string, string>) => ({ get: (k: string) => pairs[k.toLowerCase()] ?? null });
  check("first x-forwarded-for hop", clientIpFrom(h({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" })) === "203.0.113.7");
  check("then x-real-ip", clientIpFrom(h({ "x-real-ip": " 198.51.100.2 " })) === "198.51.100.2");
  check("then unknown", clientIpFrom(h({})) === "unknown");

  console.log("submitContactMessageCore");
  const db = await getDb();
  await db.delete(rateLimitBuckets).where(like(rateLimitBuckets.bucket, "contactForm:%"));
  let sent = 0;
  const send: ContactSender = async () => { sent++; return { error: null }; };
  const limit = RATE_LIMITS.contactForm.limit;
  for (let i = 0; i < limit; i++) {
    const r = await submitContactMessageCore(input, { ip: "203.0.113.7", send });
    check(`message ${i + 1} goes out`, r.ok === true);
  }
  const over = await submitContactMessageCore(input, { ip: "203.0.113.7", send });
  check("the next one from that IP is refused", over.ok === false && /few messages/.test(over.ok ? "" : over.message));
  check(`…and only ${limit} were sent`, sent === limit, String(sent));
  const elsewhere = await submitContactMessageCore(input, { ip: "203.0.113.8", send });
  check("another IP is unaffected", elsewhere.ok === true);
  const bot = await submitContactMessageCore({ ...input, website: "spam" }, { ip: "203.0.113.9", send });
  check("a honeypot hit is refused before the limiter", bot.ok === false);

  await db.delete(rateLimitBuckets).where(like(rateLimitBuckets.bucket, "contactForm:%"));
  if (failures > 0) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll contact-form checks passed.");
});
