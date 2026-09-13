/**
 * The boarding-pass image behind every shared /interest link.
 *
 * WHY THIS EXISTS. A link preview that 500s is worse than none: X and LinkedIn cache the
 * failure. This calls the route handler for a real token and a bogus one and asserts both
 * come back as a cacheable PNG.
 *
 * Run: npx tsx scripts/smoke-interest-ticket-image.ts
 */
import "./smoke/_env";

import { like } from "drizzle-orm";
import { NextRequest } from "next/server";
import { getDb } from "../src/db";
import { interestListSignups } from "../src/db/schema";
import { generateUnsubscribeToken } from "../src/lib/interest-list-email";

const PREFIX = "smoke-img-";
const TOKEN = "smoke-img-token";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function cleanup() {
  const db = await getDb();
  await db.delete(interestListSignups).where(like(interestListSignups.email, `${PREFIX}%`));
}

async function main() {
  await cleanup();
  const db = await getDb();
  await db.insert(interestListSignups).values({
    email: `${PREFIX}a@example.test`,
    unsubscribeToken: generateUnsubscribeToken(),
    shareToken: TOKEN,
    welcomePlanet: "mars",
  });

  const { GET } = await import("../src/app/api/interest-list/ticket-image/route");
  const call = (qs: string) =>
    GET(new NextRequest(`http://localhost/api/interest-list/ticket-image${qs}`));

  const real = await call(`?token=${TOKEN}`);
  check("real token: 200", real.status === 200, String(real.status));
  check("real token: png", real.headers.get("content-type") === "image/png", real.headers.get("content-type") ?? "");
  check("real token: cacheable", (real.headers.get("cache-control") ?? "").includes("s-maxage=86400"));
  const bytes = new Uint8Array(await real.arrayBuffer());
  check("real token: is a PNG", bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47);
  check("real token: has a body", bytes.length > 10_000, String(bytes.length));

  const bogus = await call("?token=nope");
  check("bogus token: still 200", bogus.status === 200, String(bogus.status));
  check("bogus token: png", bogus.headers.get("content-type") === "image/png");
  check("bogus token: cacheable", (bogus.headers.get("cache-control") ?? "").includes("s-maxage=86400"));
  const bogusBytes = new Uint8Array(await bogus.arrayBuffer());
  check(
    "bogus token: is a PNG",
    bogusBytes[0] === 0x89 && bogusBytes[1] === 0x50 && bogusBytes[2] === 0x4e && bogusBytes[3] === 0x47
  );
  check("bogus token: has a body", bogusBytes.length > 10_000, String(bogusBytes.length));

  const missing = await call("");
  check("missing token: still 200", missing.status === 200);

  await cleanup();
  console.log("\nticket image: all checks passed");
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => null);
  process.exit(1);
});
