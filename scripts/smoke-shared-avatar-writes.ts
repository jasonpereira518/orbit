/**
 * Shared LinkedIn photo cache, write side: lookups are cache-first, a photo found for one
 * account is reused by every other account with the same slug (no source call, no quota),
 * misses are remembered, blocked slugs are never fetched, only a LinkedIn profile photo is
 * pooled from Microlink, and photos from the user's own sources (Google, extension captures)
 * never reach the shared pool.
 *
 * Network and Blob are stubbed. Run: npx tsx scripts/smoke-shared-avatar-writes.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { eq, inArray, like, or } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, linkedinAvatars, rateLimitBuckets } from "../src/db/schema";
import { setAvatarBlobClientForTests } from "../src/lib/avatar-blob";
import { runAvatarBackfillBatch } from "../src/lib/avatar-backfill";
import { createContactForUser } from "../src/lib/contact-writes";
import { saveContactFromExtension } from "../src/lib/extension/writes";
import type { PageContext } from "../src/lib/extension/contract";
import { googleContactsAdapter } from "../src/lib/import-adapters/google-contacts";
import { resolveLinkedInPhotoCached } from "../src/lib/shared-avatars";

process.env.BLOB_READ_WRITE_TOKEN = "smoke-shared-avatar-writes";
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

const P = "smoke-swa-";
const USER_A = `${P}user-a`;
const USER_B = `${P}user-b`;
const PIXEL =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==";
const li = (slug: string) => `https://www.linkedin.com/in/${slug}/`;

// ---- stubs ----------------------------------------------------------------------------
let unavatarHits = true;
/** What Microlink's og:image answers with; null = nothing found. */
let microlinkImage: string | null = null;
/** Runs inside a source call: lets a check play a concurrent writer mid-lookup. */
let duringLookup: (() => Promise<void>) | null = null;
const sourceCalls: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url.includes("unavatar.io") || url.includes("api.microlink.io")) sourceCalls.push(url);
  if (url.includes("unavatar.io")) {
    if (duringLookup) await duringLookup();
    return unavatarHits
      ? new Response(Buffer.from(PIXEL, "base64"), { headers: { "content-type": "image/jpeg" } })
      : new Response(null, { status: 404 });
  }
  // Real image bytes for any LinkedIn CDN path, so only the profile-photo gate can refuse one.
  if (url.includes("media.licdn.com")) {
    return new Response(Buffer.from(PIXEL, "base64"), { headers: { "content-type": "image/jpeg" } });
  }
  return Response.json({ status: "success", data: microlinkImage ? { image: { url: microlinkImage } } : {} });
}) as typeof fetch;

const puts: string[] = [];
const dels: string[] = [];
setAvatarBlobClientForTests({
  put: async (pathname) => {
    puts.push(pathname);
    return { url: `https://abc.public.blob.vercel-storage.com/${pathname.replace(/\.jpg$/, "")}-R${puts.length}.jpg` };
  },
  del: async (urls) => void dels.push(...urls),
});

function page(url: string): PageContext {
  return {
    schemaVersion: 1,
    site: "linkedin",
    adapterVersion: "smoke",
    kind: "person",
    url,
    sourceUrl: url,
    capturedAt: "2026-10-13T00:00:00.000Z",
    identity: {
      name: null, headline: null, title: null, company: null, location: null, school: null,
      email: null, handle: null, profileUrl: null, photoUrl: null,
    },
    text: { blob: "", truncated: false, charCount: 0, fromSelection: false },
    warnings: [],
  } as unknown as PageContext;
}

run(async () => {
  const db = await getDb();
  // The app-wide source counters are shared with every other smoke: put them back as found.
  const sharedCounters = await db.select().from(rateLimitBuckets).where(like(rateLimitBuckets.bucket, "avatarSource.shared:%"));
  // …and start this run from zero, so another smoke's spend cannot run the pool dry here.
  await db.delete(rateLimitBuckets).where(like(rateLimitBuckets.bucket, "avatarSource.shared:%"));
  const cleanup = async () => {
    await db.delete(linkedinAvatars).where(like(linkedinAvatars.slug, `${P}%`));
    await db.delete(contacts).where(inArray(contacts.userId, [USER_A, USER_B]));
    await db.delete(rateLimitBuckets).where(
      or(like(rateLimitBuckets.bucket, `%:${USER_A}`), like(rateLimitBuckets.bucket, `%:${USER_B}`))
    );
  };
  await cleanup();
  const row = async (slug: string) =>
    (await db.select().from(linkedinAvatars).where(eq(linkedinAvatars.slug, slug)))[0] ?? null;
  const buckets = async (userId: string) =>
    (await db.select().from(rateLimitBuckets).where(like(rateLimitBuckets.bucket, `%${userId}`)))
      .map((b) => `${b.bucket}=${b.count}`)
      .join(",");
  const contactRow = async (id: string) =>
    (await db.select().from(contacts).where(eq(contacts.id, id)))[0];

  try {
    console.log("Cache-first LinkedIn lookups");
    const hit = `${P}ada`;
    const first = await resolveLinkedInPhotoCached("c-a", li(hit), USER_A);
    const stored = await row(hit);
    check(
      "a hit goes to the shared pool, not the contact",
      typeof first === "object" && first !== null && first.sharedUrl === stored?.imageUrl,
      JSON.stringify(first)
    );
    check("…stored under avatars-shared/ with its source", stored?.source === "unavatar" && puts.at(-1)?.startsWith("avatars-shared/") === true, `${stored?.source} ${puts.at(-1)}`);
    check("…and the Blob key does not spell the slug", !puts.at(-1)?.includes(hit));
    check("user A paid for the lookup", (await buckets(USER_A)).includes("unavatar"), await buckets(USER_A));

    sourceCalls.length = 0;
    const second = await resolveLinkedInPhotoCached("c-b", li(hit), USER_B);
    check("user B with the same slug reuses it", typeof second === "object" && second?.sharedUrl === stored?.imageUrl);
    check("…with no source call", sourceCalls.length === 0, sourceCalls.join(","));
    check("…and no quota charge", (await buckets(USER_B)) === "", await buckets(USER_B));

    console.log("\nNegative rows");
    const miss = `${P}nobody`;
    unavatarHits = false;
    sourceCalls.length = 0;
    check("a real miss is null", (await resolveLinkedInPhotoCached("c-n", li(miss), USER_A)) === null);
    const neg = await row(miss);
    check("…and records a negative row", neg !== null && neg.imageUrl === null);
    const callsAfterMiss = sourceCalls.length;
    check("a fresh negative suppresses the next lookup", (await resolveLinkedInPhotoCached("c-n2", li(miss), USER_B)) === null && sourceCalls.length === callsAfterMiss);
    await db.update(linkedinAvatars).set({ resolvedAt: new Date(Date.now() - 31 * 86_400_000) }).where(eq(linkedinAvatars.slug, miss));
    unavatarHits = true;
    const retried = await resolveLinkedInPhotoCached("c-n3", li(miss), USER_B);
    check("after 30 days it is looked up again", sourceCalls.length > callsAfterMiss && typeof retried === "object" && retried !== null);

    console.log("\nStale photos refresh");
    await db.update(linkedinAvatars).set({ resolvedAt: new Date(Date.now() - 181 * 86_400_000) }).where(eq(linkedinAvatars.slug, hit));
    const old = (await row(hit))!.imageUrl!;
    const refreshed = await resolveLinkedInPhotoCached("c-a", li(hit), USER_B);
    const now = await row(hit);
    check("a stale photo is replaced", typeof refreshed === "object" && now?.imageUrl !== old && now!.resolvedAt.getTime() > Date.now() - 60_000);
    check("…and the old shared object is deleted", dels.includes(old), JSON.stringify(dels));

    console.log("\nA stale photo that misses");
    const raced = `${P}raced`;
    await db.insert(linkedinAvatars).values({ slug: raced, imageUrl: "https://abc.public.blob.vercel-storage.com/avatars-shared/x-OLD.jpg", source: "unavatar", resolvedAt: new Date(Date.now() - 181 * 86_400_000) });
    const NEWER = "https://abc.public.blob.vercel-storage.com/avatars-shared/x-NEW.jpg";
    unavatarHits = false;
    duringLookup = async () => {
      // A concurrent refresh lands its photo while this lookup is out.
      await db.update(linkedinAvatars).set({ imageUrl: NEWER, resolvedAt: new Date() }).where(eq(linkedinAvatars.slug, raced));
    };
    const afterRace = await resolveLinkedInPhotoCached("c-r", li(raced), USER_A);
    duringLookup = null;
    unavatarHits = true;
    check("a miss never writes an older photo back over a newer one", (await row(raced))?.imageUrl === NEWER && typeof afterRace === "object" && afterRace?.sharedUrl === NEWER, JSON.stringify(await row(raced)));
    await db.update(linkedinAvatars).set({ resolvedAt: new Date(Date.now() - 181 * 86_400_000) }).where(eq(linkedinAvatars.slug, raced));
    unavatarHits = false;
    await resolveLinkedInPhotoCached("c-r", li(raced), USER_A);
    unavatarHits = true;
    const restamped = await row(raced);
    check("…and a plain miss keeps the photo, restarting its clock", restamped?.imageUrl === NEWER && restamped.resolvedAt.getTime() > Date.now() - 60_000);

    console.log("\nThe lookup is keyed exactly like the row");
    const tricky = `https://www.linkedin.com/IN/${P}alice/in/${P}bob`;
    sourceCalls.length = 0;
    await resolveLinkedInPhotoCached("c-t", tricky, USER_A);
    const unavatarAsked = sourceCalls.filter((u) => u.includes("unavatar.io"));
    check(
      "a URL naming two profiles looks up the one it is stored under",
      unavatarAsked.length > 0 && unavatarAsked.every((u) => u.includes(`/linkedin/${P}bob`)),
      JSON.stringify(sourceCalls)
    );
    check("…and nothing lands under the other", (await row(`${P}alice`)) === null && (await row(`${P}bob`)) !== null);

    console.log("\nBlocked slugs");
    const blocked = `${P}takedown`;
    await db.insert(linkedinAvatars).values({ slug: blocked, imageUrl: null, source: "unavatar", resolvedAt: new Date(0), blockedAt: new Date(), blockedBy: "admin" });
    sourceCalls.length = 0;
    check("a blocked slug is never fetched", (await resolveLinkedInPhotoCached("c-x", li(blocked), USER_A)) === null && sourceCalls.length === 0);

    console.log("\nThe batch");
    const [sharedContact] = await db.insert(contacts).values({ userId: USER_B, fullName: "Ada B", linkedinUrl: li(hit) }).returning();
    const saved: string[] = [];
    const marked: string[] = [];
    const r = await runAvatarBackfillBatch(
      [{ id: sharedContact.id, linkedinUrl: li(hit), email: null, remoteUrl: null }],
      {
        deadline: Date.now() + 10_000,
        persistRemote: async () => null,
        resolveLinkedIn: (id, url) => resolveLinkedInPhotoCached(id, url, USER_B),
        resolveGravatar: async () => null,
        save: async (id) => void saved.push(id),
        markChecked: async (id) => void marked.push(id),
      }
    );
    check("a shared photo counts as resolved", r.saved === 1 && r.savedIds[0] === sharedContact.id, JSON.stringify(r));
    check("…writes nothing onto the contact", saved.length === 0);
    check("…and leaves the backlog", marked.includes(sharedContact.id));

    const googleSlug = `${P}google-person`;
    const [g] = await db.insert(contacts).values({ userId: USER_A, fullName: "Gee", linkedinUrl: li(googleSlug), email: "gee@example.com" }).returning();
    const sources: Record<string, string | undefined> = {};
    await runAvatarBackfillBatch(
      [{ id: g.id, linkedinUrl: li(googleSlug), email: "gee@example.com", remoteUrl: null }],
      {
        deadline: Date.now() + 10_000,
        persistRemote: async () => null,
        resolveConnectedAccount: async () => ({ url: "https://abc.public.blob.vercel-storage.com/avatars/g.jpg", source: "google" }),
        resolveLinkedIn: (id, url) => resolveLinkedInPhotoCached(id, url, USER_A),
        resolveGravatar: async () => null,
        save: async (id, _url, source) => void (sources[id] = source),
        markChecked: async () => {},
      }
    );
    check("a Google photo is saved as google", sources[g.id] === "google", JSON.stringify(sources));
    check("…and never creates a shared row", (await row(googleSlug)) === null);

    console.log("\nProvenance from imports");
    const imported = await createContactForUser(USER_A, googleContactsAdapter.toCreate({
      kind: "google_contact", resourceName: "people/1", fullName: "Imported Person", firstName: "", lastName: "",
      company: "", title: "", email: "imp@example.com", phone: "", photoUrl: "https://lh3.googleusercontent.com/a/photo",
    }), { skipRevalidate: true, skipEmbedding: true, skipSummary: true });
    check("a Google Contacts import marks its photo google", (await contactRow(imported.id)).profileImageSource === "google");

    console.log("\nMicrolink only pools a LinkedIn profile photo");
    // No user (no quota): this section is about which photo is taken, not who pays.
    unavatarHits = false;
    const PHOTO = "https://media.licdn.com/dms/image/v2/D4E03AQ/profile-displayphoto-shrink_800_800/profile-displayphoto-shrink_800_800/0/1?e=1";
    const notPhotos = [
      "https://media.licdn.com/dms/image/v2/D4E16AQ/profile-displaybackgroundimage-shrink_350_1400/0/1?e=1",
      "https://media.licdn.com/dms/image/v2/D4E22AQ/feedshare-shrink_800/0/1?e=1",
      "https://media.licdn.com/dms/image/v2/C4E0BAQ/company-logo_200_200/0/1?e=1",
      "http://media.licdn.com/dms/image/v2/x/profile-displayphoto-shrink_800_800/0/1",
    ];
    for (const [i, image] of notPhotos.entries()) {
      microlinkImage = image;
      const slug = `${P}ml-not-photo-${i}`;
      check(`a non-profile-photo og:image is never pooled (${i})`, (await resolveLinkedInPhotoCached(`c-ml${i}`, li(slug), null)) === null && (await row(slug))?.imageUrl === null);
    }
    microlinkImage = PHOTO;
    const mlSlug = `${P}ml-photo`;
    const ml = await resolveLinkedInPhotoCached("c-ml", li(mlSlug), null);
    const mlRow = await row(mlSlug);
    check("a profile-displayphoto og:image is pooled", typeof ml === "object" && ml !== null && mlRow?.source === "microlink" && mlRow.imageUrl === ml.sharedUrl, JSON.stringify(mlRow));
    microlinkImage = null;
    unavatarHits = true;

    console.log("\nExtension captures stay with the account");
    const PROFILE_PHOTO = PHOTO;
    const captures = [
      { label: "a LinkedIn profile photo", slug: `${P}ext-person`, photo: PROFILE_PHOTO },
      { label: "a capture on a blocked slug", slug: blocked, photo: PROFILE_PHOTO },
      { label: "a non-LinkedIn photo", slug: `${P}ext-google`, photo: "https://lh3.googleusercontent.com/a/someone" },
    ];
    for (const c of captures) {
      const before = await row(c.slug);
      const saved = await saveContactFromExtension(
        USER_A,
        { mode: "create", force: true, page: page(li(c.slug)), fields: { fullName: c.label, linkedinUrl: li(c.slug), photoUrl: c.photo } },
        () => {}
      );
      const after = await row(c.slug);
      check(`${c.label} never touches the shared pool`, JSON.stringify(after) === JSON.stringify(before), JSON.stringify(after));
      const own = await contactRow(saved.contact.id);
      check("…and stays the contact's own photo", own.profileImageUrl === c.photo && own.profileImageSource === "extension", `${own.profileImageUrl} ${own.profileImageSource}`);
    }
    const [toMerge] = await db.insert(contacts).values({ userId: USER_A, fullName: "Merge Target", linkedinUrl: li(`${P}ext-merge`) }).returning();
    await saveContactFromExtension(
      USER_A,
      { mode: "merge", contactId: toMerge.id, page: page(li(`${P}ext-merge`)), fields: { fullName: "Merge Target", photoUrl: PROFILE_PHOTO } },
      () => {}
    );
    const merged = await contactRow(toMerge.id);
    check("a merge capture lands on the contact as extension", merged.profileImageUrl === PROFILE_PHOTO && merged.profileImageSource === "extension");
    check("…with no shared row", (await row(`${P}ext-merge`)) === null);

    const [kept] = await db.insert(contacts).values({
      userId: USER_A, fullName: "Kept Photo", profileImageUrl: "https://abc.public.blob.vercel-storage.com/avatars/kept.jpg", profileImageSource: "google",
    }).returning();
    await saveContactFromExtension(
      USER_A,
      { mode: "merge", contactId: kept.id, page: page("https://example.com/kept"), fields: { fullName: "Kept Photo", title: "CTO" } },
      () => {}
    );
    const keptRow = await contactRow(kept.id);
    check("an extension merge without a photo keeps the stored one", keptRow.profileImageUrl === "https://abc.public.blob.vercel-storage.com/avatars/kept.jpg" && keptRow.profileImageSource === "google", `${keptRow.profileImageUrl} ${keptRow.profileImageSource}`);
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
  console.log("\nAll shared-avatar write checks passed.");
});
