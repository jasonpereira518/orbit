/**
 * `/api/avatars/{id}` redirects the browser may cache, and the versioned URL that makes
 * caching them safe (LATENCY_PLAN NET-1).
 *
 * Every stored photo on a contacts page used to be one authenticated function call plus an
 * uncacheable redirect, on every render. `avatarRouteUrl` versions the route URL by a hash of
 * the photo URL the page already holds, and the route marks a versioned redirect cacheable.
 * What has to hold:
 *   - a versioned redirect is cacheable, privately; an unversioned one is not (no change);
 *   - a new photo is a new URL (the invalidation path), and that URL redirects to the new photo;
 *   - another user's contact is never served, versioned or not.
 *
 * Runs against a throwaway PGlite. Run: npx tsx scripts/smoke-avatar-route-cache.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { eq } from "drizzle-orm";
import { GET } from "../src/app/api/avatars/[contactId]/route";
import { getDb } from "../src/db";
import { contacts } from "../src/db/schema";
import { avatarRouteUrl, noPhotoMarker } from "../src/lib/contact-avatar-url";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const PHOTO_A = "https://smoke.public.blob.vercel-storage.com/avatars/a.jpg";
const PHOTO_B = "https://smoke.public.blob.vercel-storage.com/avatars/b.jpg";

const get = (path: string) => {
  const id = path.split("/")[3]!.split("?")[0]!;
  return GET(new Request(`https://orbit.test${path}`), { params: Promise.resolve({ contactId: id }) });
};

run(async () => {
  const env = process.env as Record<string, string | undefined>;
  // Demo mode: requireUserId() resolves to demo-user.
  env.NODE_ENV = "development";
  env.ORBIT_DEMO_DATA = "off";
  const db = await getDb();

  console.log("The URL helper...");
  {
    const id = "00000000-0000-4000-8000-000000000001";
    const a = avatarRouteUrl(id, PHOTO_A);
    const b = avatarRouteUrl(id, PHOTO_B);
    check("a stored photo gets a versioned URL", a.startsWith(`/api/avatars/${id}?v=`), a);
    check("a different photo gets a different URL", a !== b, `${a} vs ${b}`);
    check("the same photo always gets the same URL", a === avatarRouteUrl(id, ` ${PHOTO_A} `));
    check("no photo: unversioned (on-demand resolution)", avatarRouteUrl(id, null) === `/api/avatars/${id}`);
    check("a no-photo marker: unversioned", avatarRouteUrl(id, noPhotoMarker()) === `/api/avatars/${id}`);
    check(
      "an inline photo already routed: unversioned",
      avatarRouteUrl(id, `/api/avatars/${id}`) === `/api/avatars/${id}`
    );
    check(
      "a caller's cache-busting query is kept",
      avatarRouteUrl(id, `/api/avatars/${id}?t=123`) === `/api/avatars/${id}?t=123`
    );
  }

  console.log("\nThe route...");
  const [mine] = await db
    .insert(contacts)
    .values({ userId: "demo-user", fullName: "Avatar Cache Mine", profileImageUrl: PHOTO_A })
    .returning();
  const [theirs] = await db
    .insert(contacts)
    .values({ userId: "avatar-cache-other-user", fullName: "Avatar Cache Theirs", profileImageUrl: PHOTO_A })
    .returning();
  try {
    const versionedUrl = avatarRouteUrl(mine!.id, PHOTO_A);
    const versioned = await get(versionedUrl);
    check("a versioned request redirects to the photo", versioned.headers.get("location") === PHOTO_A, String(versioned.headers.get("location")));
    check(
      "and is cacheable, privately, for a day",
      versioned.headers.get("cache-control") === "private, max-age=86400",
      String(versioned.headers.get("cache-control"))
    );

    const plain = await get(`/api/avatars/${mine!.id}`);
    check("an unversioned request still redirects", plain.headers.get("location") === PHOTO_A);
    check("but is not marked cacheable", plain.headers.get("cache-control") === null, String(plain.headers.get("cache-control")));

    // The invalidation path: the photo changes, the page's next read carries the new URL,
    // so the browser asks a URL it has never cached, and is sent to the new photo.
    await db.update(contacts).set({ profileImageUrl: PHOTO_B }).where(eq(contacts.id, mine!.id));
    const [reread] = await db.select({ url: contacts.profileImageUrl }).from(contacts).where(eq(contacts.id, mine!.id));
    const nextUrl = avatarRouteUrl(mine!.id, reread!.url);
    check("after a photo change the next read yields a new URL", nextUrl !== versionedUrl, `${nextUrl}`);
    const after = await get(nextUrl);
    check("and that URL redirects to the new photo", after.headers.get("location") === PHOTO_B, String(after.headers.get("location")));

    const foreign = await get(avatarRouteUrl(theirs!.id, PHOTO_A));
    check("another user's contact is a 404, versioned or not", foreign.status === 404, String(foreign.status));
    check("with no redirect", foreign.headers.get("location") === null);
  } finally {
    await db.delete(contacts).where(eq(contacts.id, mine!.id));
    await db.delete(contacts).where(eq(contacts.id, theirs!.id));
  }

  console.log(failures === 0 ? "\nAll avatar route cache checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures) process.exit(1);
});
