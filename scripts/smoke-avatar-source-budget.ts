/**
 * Unavatar and Microlink are app-wide daily allowances. One user may take only a slice;
 * everyone together may take only the allowance; running out defers, never "no photo".
 * Run: npx tsx scripts/smoke-avatar-source-budget.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { like } from "drizzle-orm";
import { getDb } from "../src/db";
import { rateLimitBuckets } from "../src/db/schema";
import { AvatarSourceRateLimitError, fetchLinkedInPhotoUrl } from "../src/lib/contact-avatar";
import { RATE_LIMITS } from "../src/lib/rate-limit";

delete process.env.MICROLINK_API_KEY;
delete process.env.BLOB_READ_WRITE_TOKEN;
const PIXEL = "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==";
const URL_ = "https://www.linkedin.com/in/budget-person/";
let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const realFetch = globalThis.fetch;
let unavatarCalls = 0;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url.includes("unavatar.io")) {
    unavatarCalls++;
    return new Response(Buffer.from(PIXEL, "base64"), { headers: { "content-type": "image/jpeg" } });
  }
  return Response.json({ status: "success", data: {} }); // Microlink: nothing found
}) as typeof fetch;

async function attempt(userId: string) {
  try {
    return { photo: await fetchLinkedInPhotoUrl(`c-${userId}`, URL_, userId), deferred: false };
  } catch (err) {
    if (err instanceof AvatarSourceRateLimitError) return { photo: null, deferred: true };
    throw err;
  }
}

run(async () => {
  const db = await getDb();
  await db.delete(rateLimitBuckets).where(like(rateLimitBuckets.bucket, "avatarSource%"));
  const share = RATE_LIMITS.avatarSourceUser.limit;
  const pool = RATE_LIMITS.avatarSourceShared.limit;

  for (let i = 0; i < share; i++) await attempt("budget-a");
  const before = unavatarCalls;
  const over = await attempt("budget-a");
  check(`user A gets ${share} Unavatar lookups a day`, before === share, String(before));
  check("the next one is a deferral, not 'no photo'", over.deferred, JSON.stringify(over));
  check("…and makes no Unavatar request", unavatarCalls === before);

  const other = await attempt("budget-b");
  check("user B still has a share", other.photo !== null && !other.deferred, JSON.stringify(other));

  await db.delete(rateLimitBuckets).where(like(rateLimitBuckets.bucket, "avatarSource%"));
  unavatarCalls = 0;
  for (let u = 0; unavatarCalls < pool; u++) await attempt(`budget-pool-${u}`);
  const late = await attempt("budget-latecomer");
  check(`the whole app stops at ${pool} a day`, unavatarCalls === pool && late.deferred, `${unavatarCalls} calls`);
  // Known spent: the next user is refused from memory, without touching the one shared
  // bucket row or spending their own daily slice.
  const another = await attempt("budget-after-spent");
  const ownBucket = await db.select().from(rateLimitBuckets).where(like(rateLimitBuckets.bucket, "avatarSource.user:unavatar:budget-after-spent"));
  check("once the app-wide Unavatar allowance is spent, a new user is refused without spending their own", another.deferred && ownBucket.length === 0, `${ownBucket.length} bucket rows`);

  const unbudgeted = await fetchLinkedInPhotoUrl("c-null", URL_, null);
  check("a null user (tests, scripts) is not budgeted", unbudgeted !== null);

  await db.delete(rateLimitBuckets).where(like(rateLimitBuckets.bucket, "avatarSource%"));
  globalThis.fetch = realFetch;
  if (failures > 0) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll avatar budget checks passed.");
});
