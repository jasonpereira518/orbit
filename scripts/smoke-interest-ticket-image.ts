/**
 * The boarding-pass image behind every shared /interest link.
 *
 * WHY THIS EXISTS. A link preview that 500s is worse than none: X and LinkedIn cache the
 * failure. This calls the route handler for a real token, a bogus one and no token, and
 * asserts a cacheable PNG for the two that render and a 308 to the tokenless URL for the
 * bogus one.
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
  check("real token: has a body", bytes.length > 50_000, String(bytes.length));

  // A bogus token is never rendered: it 308s to the tokenless URL so every one of them
  // shares the single cached generic card.
  const bogus = await call("?token=nope");
  check("bogus token: 308", bogus.status === 308, String(bogus.status));
  check(
    "bogus token: redirects to the tokenless card",
    (bogus.headers.get("location") ?? "").endsWith("/api/interest-list/ticket-image"),
    bogus.headers.get("location") ?? ""
  );
  check("bogus token: cacheable", (bogus.headers.get("cache-control") ?? "").includes("s-maxage=86400"));

  const missing = await call("");
  check("missing token: still 200", missing.status === 200);
  check("missing token: png", missing.headers.get("content-type") === "image/png");
  const missingBytes = new Uint8Array(await missing.arrayBuffer());
  check(
    "missing token: is a PNG",
    missingBytes[0] === 0x89 && missingBytes[1] === 0x50 && missingBytes[2] === 0x4e && missingBytes[3] === 0x47
  );
  check("missing token: has a body", missingBytes.length > 50_000, String(missingBytes.length));

  await cleanup();
  console.log("\nticket image: all checks passed");
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => null);
  process.exit(1);
});
