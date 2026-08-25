import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { contacts } from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import {
  downloadAndPersistAvatar,
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

  // No durable photo yet — resolve from LinkedIn (Microlink + Unavatar fallback).
  if (contact.linkedinUrl?.trim()) {
    try {
      const photoUrl = await fetchLinkedInPhotoUrl(contactId, contact.linkedinUrl);
      if (photoUrl) {
        await persistProfileImage(contactId, userId, photoUrl);
        return NextResponse.redirect(photoUrl);
      }
    } catch (err) {
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
