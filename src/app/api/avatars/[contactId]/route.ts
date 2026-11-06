import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { contacts } from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import { isTourExampleSource } from "@/lib/onboarding-examples/marker";
import { RATE_LIMITS, consumeBucket, isRateLimitedError } from "@/lib/rate-limit";
import { sharedAvatarUrlSql } from "@/lib/contact-avatar-sql";
import { resolveLinkedInPhotoCached, type ProfileImageSource } from "@/lib/shared-avatars";
import {
  downloadAndPersistAvatar,
  fetchGravatarPhotoUrl,
  isDurableAvatarUrl,
  isUnusableAvatarUrl,
  AvatarSourceRateLimitError,
  parseImageDataUrl,
} from "@/lib/contact-avatar";

type Params = { params: Promise<{ contactId: string }> };

function dataUrlResponse(dataUrl: string) {
  const parsed = parseImageDataUrl(dataUrl);
  if (!parsed) return null;
  return new NextResponse(new Uint8Array(parsed.buf), {
    headers: {
      "Content-Type": parsed.contentType,
      "Cache-Control": "private, max-age=86400",
    },
  });
}

/**
 * A miss the browser is allowed to remember.
 *
 * List rows resolve on demand, so an uncacheable 404 is re-requested on every render and
 * every scroll pass — which costs more than the on-demand resolution saves. An hour is
 * short enough to pick up a later backfill, and `orbit:avatars-updated` appends a
 * cache-busting `?t=` the moment one actually resolves.
 */
function miss(status: 404) {
  return new NextResponse(null, {
    status,
    headers: { "Cache-Control": "private, max-age=3600" },
  });
}

/**
 * Quota exhausted.
 *
 * `Retry-After` is the honest answer for the tier that ran out — Microlink resets can be
 * hours away. The browser cache entry is capped far shorter on purpose: it blocks EVERY
 * tier for that contact, and the free ones (Unavatar, Gravatar) are not the exhausted
 * ones and may well succeed on the next pass. Caching the full Retry-After would mute a
 * contact for a whole afternoon over a quota that never applied to it.
 */
const MAX_RETRY_CACHE_SEC = 600;

function retryLater(retryAfterSec: number) {
  return new NextResponse(null, {
    status: 429,
    headers: {
      "Retry-After": String(retryAfterSec),
      "Cache-Control": `private, max-age=${Math.min(retryAfterSec, MAX_RETRY_CACHE_SEC)}`,
    },
  });
}

/**
 * A redirect to the photo. Cacheable for a day only when the caller versioned the URL
 * (`avatarRouteUrl` adds `?v=`, a hash of the photo URL it can see): a changed photo is then
 * a new URL, so a cached redirect can never point at an old one. `private` keeps it out of
 * any shared cache: the route is per user. An unversioned request stays uncached as before.
 */
function photoRedirect(url: string, versioned: boolean) {
  const res = NextResponse.redirect(url);
  if (versioned) res.headers.set("Cache-Control", "private, max-age=86400");
  return res;
}

/** `source` undefined = the stored photo was only made durable: keep its source. */
async function persistProfileImage(
  contactId: string,
  userId: string,
  dataUrl: string,
  source?: ProfileImageSource
) {
  const db = await getDb();
  await db
    .update(contacts)
    .set({
      profileImageUrl: dataUrl,
      ...(source ? { profileImageSource: source } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(contacts.id, contactId), eq(contacts.userId, userId)));
}

/**
 * Serve a contact's profile photo: redirect to a durably stored photo
 * (legacy data URL or Blob), proxy/persist a usable remote image into
 * Blob storage, or resolve their LinkedIn OG image on demand.
 */
export async function GET(req: Request, { params }: Params) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch {
    return new NextResponse(null, { status: 401 });
  }
  const { contactId } = await params;
  const versioned = new URL(req.url).searchParams.has("v");
  const db = await getDb();

  const contact = await db.query.contacts.findFirst({
    where: and(eq(contacts.id, contactId), eq(contacts.userId, userId)),
    columns: {
      id: true,
      profileImageUrl: true,
      linkedinUrl: true,
      email: true,
      source: true,
    },
    extras: { sharedUrl: sharedAvatarUrlSql.as("shared_url") },
  });

  if (!contact) {
    return miss(404);
  }
  // The guided tour's example people are fictional: their example.com addresses and
  // orbit-example-* slugs must never spend third-party photo quota (six at once tripped the
  // resolve bucket on the first Contacts stop). The list falls back to its illustration.
  if (isTourExampleSource(contact.source)) {
    return miss(404);
  }

  // A shared LinkedIn photo (never an upload-sourced contact's) outranks the contact's own.
  if (contact.sharedUrl) return photoRedirect(contact.sharedUrl, versioned);

  const stored = contact.profileImageUrl?.trim() || "";

  if (stored.startsWith("data:image/")) {
    const res = dataUrlResponse(stored);
    if (res) return res;
  }

  // Already durably stored in Blob — send the browser straight there.
  if (isDurableAvatarUrl(stored)) {
    return photoRedirect(stored, versioned);
  }

  // Proxy / persist a usable remote URL (Apollo / LinkedIn CDN, etc.) into Blob.
  if (stored && !isUnusableAvatarUrl(stored)) {
    try {
      const photoUrl = await downloadAndPersistAvatar(contactId, stored);
      if (photoUrl) {
        await persistProfileImage(contactId, userId, photoUrl);
        return NextResponse.redirect(photoUrl);
      }
    } catch {
      // Fall through to LinkedIn resolution.
    }
  }

  // No durable photo yet — resolve from LinkedIn (Microlink + Unavatar fallback). Each
  // resolution spends third-party quota, so this branch alone is rate limited; the
  // redirect and data-URL paths above are one read and stay unmetered.
  const linkedinUrl = contact.linkedinUrl?.trim();
  const email = contact.email?.trim();

  if (linkedinUrl || email) {
    try {
      await consumeBucket("avatar.resolve", userId, RATE_LIMITS.avatarResolve);

      let photoUrl: string | null = null;
      let source: ProfileImageSource = "public";
      if (linkedinUrl) {
        // Cache-first: a slug another account already resolved costs no lookup at all.
        const linkedIn = await resolveLinkedInPhotoCached(contactId, linkedinUrl, userId);
        if (linkedIn && typeof linkedIn === "object") {
          return NextResponse.redirect(linkedIn.sharedUrl);
        }
        photoUrl = linkedIn;
      }
      // Same ladder as the backfill: an email-only contact must resolve here too,
      // or on-demand rows would silently never fill in for them.
      if (!photoUrl && email) {
        photoUrl = await fetchGravatarPhotoUrl(contactId, email);
        source = "gravatar";
      }

      if (photoUrl) {
        await persistProfileImage(contactId, userId, photoUrl, source);
        return NextResponse.redirect(photoUrl);
      }
    } catch (err) {
      if (isRateLimitedError(err)) return retryLater(err.retryAfterSec);
      if (err instanceof AvatarSourceRateLimitError) {
        return retryLater(
          Math.max(1, Math.ceil((err.resetAt - Date.now()) / 1000))
        );
      }
    }
  }

  return miss(404);
}
