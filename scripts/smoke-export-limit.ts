/**
 * `/api/export` streams every table the account owns, so it is metered (5 an hour per user)
 * like Chat and capture, and the settings button shows the limit's own message instead of a
 * generic failure. Run: npx tsx scripts/smoke-export-limit.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { rateLimitBuckets } from "../src/db/schema";
import { RATE_LIMITS, RateLimitedError } from "../src/lib/rate-limit";

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

run(async () => {
  console.log("The policy");
  check("export is 5 an hour", RATE_LIMITS.export.limit === 5 && RATE_LIMITS.export.windowSec === 3600, JSON.stringify(RATE_LIMITS.export));
  check("its limit message names the export, not the raw scope", /export limit/.test(new RateLimitedError("export", 90).message), new RateLimitedError("export", 90).message);

  console.log("\nThe route");
  // Demo mode (`next dev`, no Clerk) resolves every request to `demo-user`, so the real
  // handler can run with no session plumbing.
  const prior = { NODE_ENV: process.env.NODE_ENV, clerk: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY };
  (process.env as Record<string, string | undefined>).NODE_ENV = "development";
  delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  const db = await getDb();
  const bucket = "export:demo-user";
  await db.delete(rateLimitBuckets).where(eq(rateLimitBuckets.bucket, bucket));
  try {
    const { GET } = await import("../src/app/api/export/route");
    for (let i = 1; i <= RATE_LIMITS.export.limit; i++) {
      const res = await GET();
      await res.text();
      check(`export ${i} of ${RATE_LIMITS.export.limit} goes through`, res.status === 200, String(res.status));
    }
    const blocked = await GET();
    const body = (await blocked.json()) as { error?: string };
    check("the next one is a 429", blocked.status === 429, String(blocked.status));
    check("…with the limit's own message in `error`", /export limit/.test(body.error ?? ""), JSON.stringify(body));
    check("…and a Retry-After in seconds", Number(blocked.headers.get("Retry-After")) > 0, String(blocked.headers.get("Retry-After")));
  } finally {
    await db.delete(rateLimitBuckets).where(eq(rateLimitBuckets.bucket, bucket));
    (process.env as Record<string, string | undefined>).NODE_ENV = prior.NODE_ENV;
    if (prior.clerk !== undefined) process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = prior.clerk;
  }

  console.log("\nThe settings button");
  const ui = readFileSync("src/components/settings/data-settings.tsx", "utf8");
  check("a 429 surfaces the server's message", /res\.status === 429/.test(ui) && /UserFacingError\(/.test(ui));
});
