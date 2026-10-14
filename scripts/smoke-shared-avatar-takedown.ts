/**
 * Admin takedown of a shared LinkedIn photo: only an admin may do it; block removes the
 * image (and its Blob), resets every account's photo re-check clock for that person, and
 * stops the slug being re-fetched or re-contributed; unblock lets it all happen again.
 *
 * Network and Blob are stubbed. Run: npx tsx scripts/smoke-shared-avatar-takedown.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { and, eq, inArray, like } from "drizzle-orm";
import { getDb } from "../src/db";
import { adminAuditLog, contacts, linkedinAvatars, rateLimitBuckets } from "../src/db/schema";
import { AdminForbiddenError } from "../src/lib/admin";
import { blockSharedAvatarAction, unblockSharedAvatarAction } from "../src/actions/admin";
import { setAvatarBlobClientForTests } from "../src/lib/avatar-blob";
import { blockSharedAvatar, listSharedAvatars, unblockSharedAvatar } from "../src/lib/admin-avatars";
import { contributeSharedPhoto, resolveLinkedInPhotoCached, upsertSharedAvatar } from "../src/lib/shared-avatars";

process.env.BLOB_READ_WRITE_TOKEN = "smoke-shared-avatar-takedown";
delete process.env.MICROLINK_API_KEY;
delete process.env.VERCEL;

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const P = "smoke-sat-";
const ADMIN = `${P}admin`;
const USER_A = `${P}user-a`;
const USER_B = `${P}user-b`;
const SLUG = `${P}target`;
const li = (slug: string) => `https://www.linkedin.com/in/${slug}/`;
const PIXEL =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==";

const realFetch = globalThis.fetch;
const sourceCalls: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url.includes("unavatar.io") || url.includes("api.microlink.io")) sourceCalls.push(url);
  if (url.includes("unavatar.io") || url.includes("media.licdn.com")) {
    return new Response(Buffer.from(PIXEL, "base64"), { headers: { "content-type": "image/jpeg" } });
  }
  return Response.json({ status: "success", data: {} });
}) as typeof fetch;

const dels: string[] = [];
let puts = 0;
setAvatarBlobClientForTests({
  put: async (pathname) => ({ url: `https://abc.public.blob.vercel-storage.com/${pathname.replace(/\.jpg$/, "")}-T${++puts}.jpg` }),
  del: async (urls) => void dels.push(...urls),
});

run(async () => {
  const db = await getDb();
  const sharedCounters = await db.select().from(rateLimitBuckets).where(like(rateLimitBuckets.bucket, "avatarSource.shared:%"));
  await db.delete(rateLimitBuckets).where(like(rateLimitBuckets.bucket, "avatarSource.shared:%"));
  const cleanup = async () => {
    await db.delete(linkedinAvatars).where(like(linkedinAvatars.slug, `${P}%`));
    await db.delete(contacts).where(inArray(contacts.userId, [USER_A, USER_B]));
    await db.delete(adminAuditLog).where(eq(adminAuditLog.adminUserId, ADMIN));
    await db.delete(rateLimitBuckets).where(
      inArray(rateLimitBuckets.bucket, [`unavatar:${USER_A}`, `unavatar:${USER_B}`])
    );
  };
  await cleanup();
  const row = async (slug: string) =>
    (await db.select().from(linkedinAvatars).where(eq(linkedinAvatars.slug, slug)))[0] ?? null;

  try {
    const OLD = "https://abc.public.blob.vercel-storage.com/avatars-shared/old-photo.jpg";
    await upsertSharedAvatar({ slug: SLUG, imageUrl: OLD, source: "unavatar" });
    const checkedAt = new Date("2026-10-01T00:00:00Z");
    const OWN_COPY = "https://abc.public.blob.vercel-storage.com/avatars/own-public-copy.jpg";
    const ELSE_COPY = "https://abc.public.blob.vercel-storage.com/avatars/else-copy.jpg";
    const UNLABELLED = "https://unavatar.io/linkedin/smoke-sat-target?fallback=false";
    const GOOGLE_PHOTO = "https://abc.public.blob.vercel-storage.com/avatars/google-photo.jpg";
    const [a, b, other, own, unlabelled] = await db
      .insert(contacts)
      .values([
        { userId: USER_A, fullName: "Target A", linkedinUrl: li(SLUG), profileImageCheckedAt: checkedAt, profileImageUrl: GOOGLE_PHOTO, profileImageSource: "google" },
        { userId: USER_B, fullName: "Target B", linkedinUrl: li(SLUG), profileImageCheckedAt: checkedAt, profileImageUrl: OWN_COPY, profileImageSource: "public" },
        { userId: USER_B, fullName: "Someone Else", linkedinUrl: li(`${P}else`), profileImageCheckedAt: checkedAt, profileImageUrl: ELSE_COPY, profileImageSource: "public" },
        { userId: USER_A, fullName: "Ext copy", linkedinUrl: li(SLUG.toUpperCase()), profileImageUrl: "https://media.licdn.com/dms/image/v2/t/own.jpg", profileImageSource: "extension" },
        { userId: USER_A, fullName: "Unlabelled", linkedinUrl: li(SLUG), profileImageUrl: UNLABELLED },
      ])
      .returning();

    console.log("Admin only");
    const refused = async (fn: () => Promise<unknown>) => {
      try { await fn(); return false; } catch { return true; }
    };
    const forbidden = async (fn: () => Promise<unknown>) => {
      try { await fn(); return false; } catch (e) { return e instanceof AdminForbiddenError; }
    };
    check("a non-admin cannot block", await forbidden(() => blockSharedAvatarAction({ slug: SLUG, reason: "not allowed" })));
    check("a non-admin cannot unblock", await forbidden(() => unblockSharedAvatarAction({ slug: SLUG, reason: "not allowed" })));
    check("…and nothing changed", (await row(SLUG))?.imageUrl === OLD && (await row(SLUG))?.blockedAt === null);

    console.log("\nBlock");
    check("a reason is required", await refused(() => blockSharedAvatar(ADMIN, { slug: SLUG, reason: " " })));
    check("an empty slug is refused", await refused(() => blockSharedAvatar(ADMIN, { slug: " ", reason: "takedown request" })));
    await blockSharedAvatar(ADMIN, { slug: ` ${SLUG.toUpperCase()} `, reason: "takedown request" });
    const blocked = await row(SLUG);
    check("block clears the image and records who and when", blocked?.imageUrl === null && blocked.blockedBy === ADMIN && blocked.blockedAt !== null, JSON.stringify(blocked));
    check("…and deletes the stored object", dels.includes(OLD), dels.join(","));
    const rechecks = await db.select().from(contacts).where(inArray(contacts.id, [a.id, b.id, other.id, own.id, unlabelled.id]));
    const photoOf = (id: string) => rechecks.find((c) => c.id === id);
    const checkedOf = (id: string) => rechecks.find((c) => c.id === id)?.profileImageCheckedAt ?? null;
    check("…resets the photo re-check clock for every account with that person", checkedOf(a.id) === null && checkedOf(b.id) === null);
    check("…and no one else's", checkedOf(other.id)?.getTime() === checkedAt.getTime());
    check("a public-source copy on a contact is removed", photoOf(b.id)?.profileImageUrl === null && photoOf(b.id)?.profileImageSource === null);
    check("…so are extension-sourced and provably-public unlabelled copies", photoOf(own.id)?.profileImageUrl === null && photoOf(unlabelled.id)?.profileImageUrl === null);
    check("…and their Blob objects are deleted", dels.includes(OWN_COPY));
    check("a Google-sourced photo is kept", photoOf(a.id)?.profileImageUrl === GOOGLE_PHOTO && photoOf(a.id)?.profileImageSource === "google" && !dels.includes(GOOGLE_PHOTO));
    check("a public copy under another slug is kept", photoOf(other.id)?.profileImageUrl === ELSE_COPY);
    const [audit] = await db.select().from(adminAuditLog).where(and(eq(adminAuditLog.adminUserId, ADMIN), eq(adminAuditLog.action, "avatar.block")));
    check("…and is audited with its reason", audit?.resourceId === SLUG && audit.reason === "takedown request", JSON.stringify(audit));

    sourceCalls.length = 0;
    const lookup = await resolveLinkedInPhotoCached(a.id, li(SLUG), USER_A);
    check("a blocked slug is never fetched", lookup === null && sourceCalls.length === 0, `${JSON.stringify(lookup)} ${sourceCalls.length}`);
    const licdn = "https://media.licdn.com/dms/image/v2/t/profile.jpg";
    check("…and never contributed", (await contributeSharedPhoto(li(SLUG), licdn, li(SLUG))) === false);
    check("…nor written by a late writer", (await upsertSharedAvatar({ slug: SLUG, imageUrl: "https://x.test/p.jpg", source: "extension" })) === false);
    check("…the row is still blocked and empty", (await row(SLUG))?.imageUrl === null && (await row(SLUG))?.blockedAt !== null);

    console.log("\nSearch");
    const hits = await listSharedAvatars({ q: "TARGET" });
    check("search finds the slug, case-insensitively, as blocked", hits.some((h) => h.slug === SLUG && h.blockedAt !== null));
    check("the default list is blocked slugs only", (await listSharedAvatars({})).every((h) => h.blockedAt !== null));

    console.log("\nUnblock");
    await unblockSharedAvatar(ADMIN, { slug: SLUG, reason: "mistake" });
    check("unblock clears the block", (await row(SLUG))?.blockedAt == null);
    const [unblockAudit] = await db.select().from(adminAuditLog).where(and(eq(adminAuditLog.adminUserId, ADMIN), eq(adminAuditLog.action, "avatar.unblock")));
    check("…and is audited", unblockAudit?.resourceId === SLUG);
    check("a capture can contribute again", (await contributeSharedPhoto(li(SLUG), licdn, li(SLUG))) === true);
    const after = await row(SLUG);
    check("…and the pool holds it", after?.source === "extension" && after.imageUrl?.startsWith("https://") === true && after.blockedAt === null, JSON.stringify(after));
  } finally {
    globalThis.fetch = realFetch;
    setAvatarBlobClientForTests(null);
    await cleanup();
    await db.delete(rateLimitBuckets).where(like(rateLimitBuckets.bucket, "avatarSource.shared:%"));
    if (sharedCounters.length > 0) await db.insert(rateLimitBuckets).values(sharedCounters);
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll shared-avatar takedown checks passed.");
});
