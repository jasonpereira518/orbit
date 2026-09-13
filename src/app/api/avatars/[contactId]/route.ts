import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { contacts } from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import { RATE_LIMITS, consumeBucket, isRateLimitedError } from "@/lib/rate-limit";
import {
  downloadAndPersistAvatar,
  hasFreshNoPhotoMarker,
  noPhotoMarker,
  fetchLinkedInPhotoUrl,
  isDurableAvatarUrl,
  isUnusableAvatarUrl,
  MicrolinkRateLimitError,
  parseImageDataUrl,
} from "@/lib/contact-avatar";
import { isUuid } from "@/lib/ids";

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
  // Same uuid guard as the contact pages. Without it a junk id in an <img src>
  // returns a 500 instead of the 404 the caller already handles.
  if (!isUuid(contactId)) {
    return new NextResponse(null, { status: 404 });
  }
  const db = await getDb();

  const contact = await db.query.contacts.findFirst({
    where: and(eq(contacts.id, contactId), eq(contacts.userId, userId)),
    columns: {
      id: true,
      profileImageUrl: true,
      linkedinUrl: true,
    },
  });

  if (!contact) {
    return new NextResponse(null, { status: 404 });
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
  // A recent miss is remembered, so a contact with no findable photo costs one lookup a
  // week instead of one per page view. Without this, browsing ~30 profiles in a minute
  // spent the whole `avatarResolve` budget and started 429ing.
  if (hasFreshNoPhotoMarker(stored)) {
    return new NextResponse(null, { status: 404 });
  }

  if (contact.linkedinUrl?.trim()) {
    try {
      // Scope string matches the policy key, as every other call site does.
      await consumeBucket("avatarResolve", userId, RATE_LIMITS.avatarResolve);
      const photoUrl = await fetchLinkedInPhotoUrl(contactId, contact.linkedinUrl);
      if (photoUrl) {
        await persistProfileImage(contactId, userId, photoUrl);
        return NextResponse.redirect(photoUrl);
      }
      // Looked, found nothing. Record it rather than asking again on the next render.
      await persistProfileImage(contactId, userId, noPhotoMarker());
    } catch (err) {
      if (isRateLimitedError(err)) {
        return new NextResponse(null, {
          status: 429,
          headers: { "Retry-After": String(err.retryAfterSec) },
        });
      }
      if (err instanceof MicrolinkRateLimitError) {
        const retryAfterSec = Math.max(
          1,
          Math.ceil((err.resetAt - Date.now()) / 1000)
        );
        return new NextResponse(null, {
          status: 429,
          headers: { "Retry-After": String(retryAfterSec) },
        });
      }
    }
  }

  return new NextResponse(null, { status: 404 });
}
