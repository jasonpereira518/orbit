import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { contacts } from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import {
  downloadImageAsDataUrl,
  fetchLinkedInPhotoDataUrl,
  isUnusableAvatarUrl,
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
 * Serve a contact's profile photo from a durable data URL, by proxying a
 * usable remote image, or by resolving their LinkedIn OG image on demand.
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

  // Proxy / persist a usable remote URL (Apollo / LinkedIn CDN, etc.).
  if (stored && !isUnusableAvatarUrl(stored)) {
    try {
      const dataUrl = await downloadImageAsDataUrl(stored);
      if (dataUrl) {
        void db
          .update(contacts)
          .set({ profileImageUrl: dataUrl, updatedAt: new Date() })
          .where(and(eq(contacts.id, contactId), eq(contacts.userId, userId)));
        const res = dataUrlResponse(dataUrl);
        if (res) return res;
      }
    } catch {
      // Fall through to LinkedIn resolution.
    }
  }

  // No durable photo yet — resolve from LinkedIn profile page when possible.
  if (contact.linkedinUrl?.trim()) {
    try {
      const dataUrl = await fetchLinkedInPhotoDataUrl(contact.linkedinUrl);
      if (dataUrl) {
        void db
          .update(contacts)
          .set({ profileImageUrl: dataUrl, updatedAt: new Date() })
          .where(and(eq(contacts.id, contactId), eq(contacts.userId, userId)));
        const res = dataUrlResponse(dataUrl);
        if (res) return res;
      }
    } catch {
      // ignore
    }
  }

  return new NextResponse(null, { status: 404 });
}
