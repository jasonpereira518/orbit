/**
 * Shared LinkedIn photo pool upkeep: seeding pools only slugs whose contact shows an Unavatar
 * photo, by a fresh lookup (never a stored media.licdn.com URL: it may be an extension
 * capture); the hourly fill takes the most-shared slugs first and stops when the source quota
 * defers, and the orphan sweep removes a row only once no contact in ANY account has the slug
 * (blocked rows survive). Network and Blob are stubbed.
 * Run: npx tsx scripts/smoke-shared-avatar-upkeep.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { eq, inArray, like, or } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, linkedinAvatars, rateLimitBuckets } from "../src/db/schema";
import { setAvatarBlobClientForTests } from "../src/lib/avatar-blob";
import { RATE_LIMITS } from "../src/lib/rate-limit";
import {
  SHARED_AVATAR_SWEEP_BATCH,
  SHARED_FILL_RESERVE,
  fillSharedAvatars,
  provablePublicPhotoSource,
  seedSharedAvatar,
  sweepOrphanedSharedAvatars,
} from "../src/lib/shared-avatar-upkeep";

process.env.BLOB_READ_WRITE_TOKEN = "smoke-shared-avatar-upkeep";
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

const P = "smoke-sau-";
const USERS = [`${P}user-a`, `${P}user-b`];
const PIXEL =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==";
const li = (slug: string) => `https://www.linkedin.com/in/${slug}/`;
const BLOB = "https://abc.public.blob.vercel-storage.com";

// ---- stubs ----------------------------------------------------------------------------
let unavatarSvg = false;
const unavatarAsked: string[] = [];
const photoFetches: string[] = [];
const microlinkAsked: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url.includes("unavatar.io")) {
    unavatarAsked.push(url);
    return unavatarSvg
      ? new Response("<svg xmlns='http://www.w3.org/2000/svg'/>", { headers: { "content-type": "image/svg+xml" } })
      : new Response(Buffer.from(PIXEL, "base64"), { headers: { "content-type": "image/jpeg" } });
  }
  if (url.includes("media.licdn.com")) {
    photoFetches.push(url);
    return new Response(Buffer.from(PIXEL, "base64"), { headers: { "content-type": "image/jpeg" } });
  }
  if (url.includes("microlink")) microlinkAsked.push(url);
  return Response.json({ status: "success", data: {} }); // Microlink: nothing found
}) as typeof fetch;

const puts: string[] = [];
const dels: string[] = [];
setAvatarBlobClientForTests({
  put: async (pathname) => {
    puts.push(pathname);
    return { url: `${BLOB}/${pathname.replace(/\.jpg$/, "")}-R${puts.length}.jpg` };
  },
  del: async (urls) => void dels.push(...urls),
});

run(async () => {
  const db = await getDb();
  const savedCounters = await db.select().from(rateLimitBuckets).where(or(like(rateLimitBuckets.bucket, "avatarSource.%"), like(rateLimitBuckets.bucket, "avatarFill:%")));
  const resetCounters = () =>
    db.delete(rateLimitBuckets).where(or(like(rateLimitBuckets.bucket, "avatarSource.shared:%"), like(rateLimitBuckets.bucket, "avatarFill:%"), like(rateLimitBuckets.bucket, "avatarSource.user:%system:avatar-fill:%")));
  const cleanup = async () => {
    await db.delete(linkedinAvatars).where(like(linkedinAvatars.slug, `${P}%`));
    await db.delete(contacts).where(inArray(contacts.userId, USERS));
    await resetCounters();
  };
  await resetCounters();
  await cleanup();
  const row = async (slug: string) =>
    (await db.select().from(linkedinAvatars).where(eq(linkedinAvatars.slug, slug)))[0] ?? null;
  const addContacts = async (slug: string, n: number, url = li(slug)) => {
    await db.insert(contacts).values(
      Array.from({ length: n }, (_, i) => ({ userId: USERS[i % 2], fullName: `${slug} ${i}`, linkedinUrl: url }))
    );
  };

  try {
    console.log("Which photos are provable");
    const prov = provablePublicPhotoSource;
    check("an Unavatar LinkedIn lookup is", prov("https://unavatar.io/linkedin/ada?fallback=false") === "unavatar");
    check(
      "LinkedIn CDN, Blob, data:, Google, Outlook, look-alike hosts and other Unavatar providers are not",
      [
        "https://media.licdn.com/dms/image/v2/x/profile-displayphoto-shrink_800_800/0/1",
        `${BLOB}/avatars/c1.jpg`,
        "data:image/jpeg;base64,AAAA",
        "https://lh3.googleusercontent.com/a/x",
        "https://graph.microsoft.com/v1.0/me/photo/$value",
        "https://media.licdn.com.evil.example/x.jpg",
        "http://media.licdn.com/x.jpg",
        "https://unavatar.io/google/ada",
        "https://evil.example/?u=https://media.licdn.com/x.jpg",
        "",
        null,
      ].every((u) => prov(u) === null)
    );

    console.log("\nSeeding");
    const licdn = "https://media.licdn.com/dms/image/v2/seed/profile-displayphoto-shrink_800_800/0/1";
    const unav = "https://unavatar.io/linkedin/whoever?fallback=false";
    const dry = `${P}dry`;
    check("a dry run reports without downloading or writing", (await seedSharedAvatar(dry, unav, true)) === "promoted" && (await row(dry)) === null && puts.length === 0 && unavatarAsked.length === 0);

    const fromCdn = `${P}cdn`;
    check("a stored LinkedIn CDN photo is never promoted", (await seedSharedAvatar(fromCdn, licdn)) === "not-provable" && (await row(fromCdn)) === null && photoFetches.length === 0 && puts.length === 0);

    const fromUnavatar = `${P}unav`;
    unavatarAsked.length = 0;
    check("an Unavatar photo with real bytes is promoted", (await seedSharedAvatar(fromUnavatar, `https://unavatar.io/linkedin/someone-else?fallback=false`)) === "promoted" && (await row(fromUnavatar))?.source === "unavatar");
    const seededRow = await row(fromUnavatar);
    check("…downloaded into avatars-shared/, not referenced remotely", seededRow?.imageUrl?.startsWith(`${BLOB}/avatars-shared/`) === true, JSON.stringify(seededRow));
    check("…asked for by the slug, not the stored URL", unavatarAsked.length === 1 && unavatarAsked[0].includes(`/linkedin/${fromUnavatar}?`), JSON.stringify(unavatarAsked));

    const placeholder = `${P}svg`;
    unavatarSvg = true;
    check("an Unavatar SVG placeholder is not", (await seedSharedAvatar(placeholder, `https://unavatar.io/linkedin/${placeholder}`)) === "no-image" && (await row(placeholder)) === null);
    unavatarSvg = false;

    const putsBefore = puts.length;
    for (const [i, bad] of [`${BLOB}/avatars/c1.jpg`, "data:image/jpeg;base64,AAAA", "https://lh3.googleusercontent.com/a/x"].entries()) {
      const slug = `${P}bad-${i}`;
      check(`${bad.slice(0, 28)}… is never promoted`, (await seedSharedAvatar(slug, bad)) === "not-provable" && (await row(slug)) === null);
    }
    check("…and nothing was stored for them", puts.length === putsBefore);

    const blocked = `${P}blocked`;
    await db.insert(linkedinAvatars).values({ slug: blocked, imageUrl: null, source: "unavatar", blockedAt: new Date(), blockedBy: "admin" });
    check("a blocked slug is skipped", (await seedSharedAvatar(blocked, unav)) === "blocked" && (await row(blocked))?.imageUrl === null);
    const putsAtAlready = puts.length;
    check("an already-positive slug is skipped", (await seedSharedAvatar(fromUnavatar, unav)) === "already" && puts.length === putsAtAlready);
    const negative = `${P}negative`;
    await db.insert(linkedinAvatars).values({ slug: negative, imageUrl: null, source: "unavatar" });
    check("a negative row is upgraded", (await seedSharedAvatar(negative, unav)) === "promoted" && (await row(negative))?.imageUrl?.startsWith("https://") === true);

    console.log("\nHourly fill");
    const [A, B, C] = [`${P}fill-a`, `${P}fill-b`, `${P}fill-c`];
    const hasRow = `${P}fill-has-row`;
    const offHost = `${P}fill-offhost`;
    await addContacts(C, 10);
    await addContacts(A, 12);
    await addContacts(B, 11);
    await addContacts(hasRow, 14);
    await addContacts(offHost, 13, `https://example.com/in/${offHost}`);
    await db.insert(linkedinAvatars).values({ slug: hasRow, imageUrl: `${BLOB}/avatars-shared/keep.jpg`, source: "unavatar" });

    // Room for one lookup above the reserve: the fill must stop there, not run the allowance dry.
    const sharedLimit = RATE_LIMITS.avatarSourceShared.limit;
    await db.insert(rateLimitBuckets).values({ bucket: "avatarSource.shared:unavatar", windowStartedAt: new Date(), count: sharedLimit - SHARED_FILL_RESERVE - 1 });
    unavatarAsked.length = 0;
    microlinkAsked.length = 0;
    const first = await fillSharedAvatars();
    const mine = () => unavatarAsked.filter((u) => u.includes(P)).map((u) => u.match(/fill-[a-z-]+/)?.[0]);
    const [shared1] = await db.select().from(rateLimitBuckets).where(eq(rateLimitBuckets.bucket, "avatarSource.shared:unavatar"));
    check("the most-shared slug is resolved first, then the reserve stops the run", (await row(A))?.imageUrl?.startsWith("https://") === true && (await row(B)) === null && (await row(C)) === null && first.deferred, JSON.stringify({ first, asked: mine() }));
    check("…leaving at least the reserve of the app-wide allowance", sharedLimit - shared1.count >= SHARED_FILL_RESERVE, String(shared1.count));
    check("…and no later slug is tried", mine().length === 1 && microlinkAsked.filter((u) => u.includes(P)).length === 0, JSON.stringify({ mine: mine(), microlinkAsked }));
    check("…a slug with a row or a non-LinkedIn host is never asked for", !mine().includes("fill-has-row") && !mine().includes("fill-offhost"), JSON.stringify(mine()));
    const keys = (await db.select().from(rateLimitBuckets).where(like(rateLimitBuckets.bucket, "avatarSource.user:%system:avatar-fill:%"))).map((b) => b.bucket);
    check("the system id in a bucket key is a hash, not the slug", keys.length > 0 && keys.every((k) => !k.includes(P)), JSON.stringify(keys));

    await db.delete(rateLimitBuckets).where(eq(rateLimitBuckets.bucket, "avatarSource.shared:unavatar"));
    await db.delete(rateLimitBuckets).where(eq(rateLimitBuckets.bucket, "avatarFill:daily"));
    await db.insert(rateLimitBuckets).values({ bucket: "avatarFill:daily", windowStartedAt: new Date(), count: RATE_LIMITS.avatarFill.limit });
    unavatarAsked.length = 0;
    const capped = await fillSharedAvatars();
    check("the fill's own daily cap stops it before any lookup", capped.deferred && capped.found === 0 && unavatarAsked.length === 0, JSON.stringify(capped));
    await db.delete(rateLimitBuckets).where(eq(rateLimitBuckets.bucket, "avatarFill:daily"));

    await db.delete(rateLimitBuckets).where(eq(rateLimitBuckets.bucket, "avatarSource.shared:unavatar"));
    unavatarAsked.length = 0;
    // Two slugs: B and C are the most-shared left, and any LinkedIn contact an earlier script
    // in this shard's database left behind would otherwise spend the allowance down to the reserve.
    const second = await fillSharedAvatars(2);
    const order = mine().filter((s) => s === "fill-b" || s === "fill-c");
    check("the next run takes the next-most-shared", JSON.stringify(order) === JSON.stringify(["fill-b", "fill-c"]) && !second.deferred && second.found >= 2, JSON.stringify({ second, order }));
    check("…and A, already filled, is not looked up again", !mine().includes("fill-a"));

    console.log("\nOrphan sweep");
    const shared = `${P}shared`;
    const lastOne = `${P}last-one`;
    const neverHad = `${P}no-contacts-negative`;
    const keepBlocked = `${P}blocked`; // no contact has it
    const urlOf = (s: string) => `${BLOB}/avatars-shared/${s}-X.jpg`;
    await db.insert(linkedinAvatars).values([
      { slug: shared, imageUrl: urlOf(shared), source: "unavatar" },
      { slug: lastOne, imageUrl: urlOf(lastOne), source: "unavatar" },
      { slug: neverHad, imageUrl: null, source: "unavatar" },
    ]);
    const [a1] = await db.insert(contacts).values({ userId: USERS[0], fullName: "S1", linkedinUrl: li(shared) }).returning();
    const [b1] = await db.insert(contacts).values({ userId: USERS[1], fullName: "S2", linkedinUrl: li(shared) }).returning();
    await db.insert(contacts).values({ userId: USERS[0], fullName: "L1", linkedinUrl: li(lastOne) });
    dels.length = 0;
    await sweepOrphanedSharedAvatars();
    check("rows with a contact are kept", (await row(shared)) !== null && (await row(lastOne)) !== null);
    check("a slug no contact has is removed, with its object", (await row(neverHad)) === null && (await row(seededRow!.slug)) === null && dels.includes(seededRow!.imageUrl!), JSON.stringify(dels));
    check("a blocked row survives", (await row(keepBlocked)) !== null);

    await db.delete(contacts).where(eq(contacts.id, a1.id));
    await sweepOrphanedSharedAvatars();
    check("while another user still has the slug it stays", (await row(shared)) !== null && !dels.includes(urlOf(shared)));
    await db.delete(contacts).where(eq(contacts.id, b1.id));
    await sweepOrphanedSharedAvatars();
    check("once the last contact (any user) is gone, it goes", (await row(shared)) === null && dels.includes(urlOf(shared)));
    check("an unrelated slug with contacts is untouched", (await row(lastOne)) !== null);

    console.log("\nBatching");
    const total = SHARED_AVATAR_SWEEP_BATCH + 5;
    await db.insert(linkedinAvatars).values(Array.from({ length: total }, (_, i) => ({ slug: `${P}bulk-${i}`, imageUrl: null, source: "unavatar" as const })));
    const removed = await sweepOrphanedSharedAvatars();
    const left = (await db.select({ s: linkedinAvatars.slug }).from(linkedinAvatars).where(like(linkedinAvatars.slug, `${P}bulk-%`))).length;
    check("a backlog larger than one batch is drained", left === 0 && removed >= total, `left=${left} removed=${removed}`);
  } finally {
    await cleanup();
    if (savedCounters.length) await db.insert(rateLimitBuckets).values(savedCounters).onConflictDoNothing();
  }
  if (failures) throw new Error(`${failures} check(s) failed`);
});
