import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { contacts } from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import { RATE_LIMITS, consumeBucket, isRateLimitedError } from "@/lib/rate-limit";
import {
  downloadAndPersistAvatar,
  fetchGravatarPhotoUrl,
  fetchLinkedInPhotoUrl,
  isDurableAvatarUrl,
  isUnusableAvatarUrl,
  MicrolinkRateLimitError,
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

async function persistProfileImage(
  contactId: string,
  userId: string,
  dataUrl: string
) {
  const db = await getDb();
  await db
    .update(contacts)
    .set({ profileImageUrl: dataUrl, updatedAt: new Date() })
    .where(and(eq(contacts.id, contactId), eq(contacts.userId, userId)));
}

/**
 * Serve a contact's profile photo: redirect to a durably stored photo
 * (legacy data URL or Blob), proxy/persist a usable remote image into
 * Blob storage, or resolve their LinkedIn OG image on demand.
 */
export async function GET(_req: Request, { params }: Params) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch {
    return new NextResponse(null, { status: 401 });
  }
  const { contactId } = await params;
  const db = await getDb();

  const contact = await db.query.contacts.findFirst({
    where: and(eq(contacts.id, contactId), eq(contacts.userId, userId)),
    columns: {
      id: true,
      profileImageUrl: true,
      linkedinUrl: true,
      email: true,
    },
  });

  if (!contact) {
    return miss(404);
  }

  const stored = contact.profileImageUrl?.trim() || "";

  if (stored.startsWith("data:image/")) {
    const res = dataUrlResponse(stored);
    if (res) return res;
  }

  // Already durably stored in Blob — send the browser straight there.
  if (isDurableAvatarUrl(stored)) {
    return NextResponse.redirect(stored);
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
      if (linkedinUrl) {
        photoUrl = await fetchLinkedInPhotoUrl(contactId, linkedinUrl);
      }
      // Same ladder as the backfill: an email-only contact must resolve here too,
      // or on-demand rows would silently never fill in for them.
      if (!photoUrl && email) {
        photoUrl = await fetchGravatarPhotoUrl(contactId, email);
      }

      if (photoUrl) {
        await persistProfileImage(contactId, userId, photoUrl);
        return NextResponse.redirect(photoUrl);
      }
    } catch (err) {
      if (isRateLimitedError(err)) return retryLater(err.retryAfterSec);
      if (err instanceof MicrolinkRateLimitError) {
        return retryLater(
          Math.max(1, Math.ceil((err.resetAt - Date.now()) / 1000))
        );
      }
    }
  }

  return miss(404);
}
