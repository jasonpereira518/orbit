import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { contacts } from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import {
  downloadImageAsDataUrl,
  isUnusableAvatarUrl,
} from "@/lib/contact-avatar";

type Params = { params: Promise<{ contactId: string }> };

/**
 * Serve a contact's profile photo from a durable data URL or by proxying
 * a usable remote image (with LinkedIn referer). Returns 404 when missing.
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
    columns: { id: true, profileImageUrl: true },
  });

  if (!contact?.profileImageUrl) {
    return new NextResponse(null, { status: 404 });
  }

  const stored = contact.profileImageUrl.trim();

  if (stored.startsWith("data:image/")) {
    const comma = stored.indexOf(",");
    const meta = stored.slice(5, comma); // image/jpeg;base64
    const contentType = meta.split(";")[0] || "image/jpeg";
    const b64 = stored.slice(comma + 1);
    if (!b64) return new NextResponse(null, { status: 404 });
    const body = Buffer.from(b64, "base64");
    return new NextResponse(body, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "private, max-age=86400",
      },
    });
  }

  if (isUnusableAvatarUrl(stored)) {
    return new NextResponse(null, { status: 404 });
  }

  // Proxy remote images so LinkedIn CDN hotlink rules don't blank the UI.
  try {
    const dataUrl = await downloadImageAsDataUrl(stored);
    if (!dataUrl) return new NextResponse(null, { status: 404 });

    // Persist durable copy for next time (fire-and-forget style update).
    void db
      .update(contacts)
      .set({ profileImageUrl: dataUrl, updatedAt: new Date() })
      .where(and(eq(contacts.id, contactId), eq(contacts.userId, userId)));

    const comma = dataUrl.indexOf(",");
    const meta = dataUrl.slice(5, comma);
    const contentType = meta.split(";")[0] || "image/jpeg";
    const b64 = dataUrl.slice(comma + 1);
    return new NextResponse(Buffer.from(b64, "base64"), {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "private, max-age=86400",
      },
    });
  } catch {
    return new NextResponse(null, { status: 404 });
  }
}
