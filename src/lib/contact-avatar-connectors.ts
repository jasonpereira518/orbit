import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { gmailConnections, outlookConnections } from "@/db/schema";
import {
  fetchGooglePeopleContacts,
  getValidAccessToken as getGoogleAccessToken,
  hasContactsScope,
} from "@/lib/gmail";
import {
  fetchOutlookContacts,
  getValidAccessToken as getOutlookAccessToken,
  hasContactsScope as hasOutlookContactsScope,
} from "@/lib/outlook";
import type { ProviderNameIndex } from "@/lib/contact-name-guess";

/**
 * Email-matched photo sources from the user's own connected Google/Outlook account —
 * the same address book they already granted contacts access to, so a match can only
 * ever be someone they know, never a stranger with the same name.
 */

/**
 * Only what the indexes below read: the first email, the first non-default photo, and the
 * name fields the fetchers' "has a name" filter keeps people by. Organizations and phone
 * numbers were fetched for every contact and thrown away.
 */
const GOOGLE_PHOTO_INDEX_FIELDS = "names,emailAddresses,photos";
const OUTLOOK_CONTACT_INDEX_SELECT = "displayName,givenName,surname,emailAddresses";

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Email -> Google Contacts photo URL, for the user's connected account. Empty when Google
 * isn't connected, lacks the contacts scope, or the lookup fails — this is a best-effort
 * source, not a required one, so failures are swallowed rather than thrown. */
export async function buildGooglePhotoIndex(userId: string): Promise<Map<string, string>> {
  const db = await getDb();
  const conn = await db.query.gmailConnections.findFirst({
    where: eq(gmailConnections.userId, userId),
  });
  if (!conn || conn.status !== "active" || !hasContactsScope(conn.scopes)) {
    return new Map();
  }

  try {
    const accessToken = await getGoogleAccessToken(userId);
    const people = await fetchGooglePeopleContacts(accessToken, GOOGLE_PHOTO_INDEX_FIELDS);
    const index = new Map<string, string>();
    for (const person of people) {
      const email = person.email?.trim();
      if (!email || !person.photoUrl) continue;
      const key = normalizeEmail(email);
      if (!index.has(key)) index.set(key, person.photoUrl);
    }
    return index;
  } catch {
    return new Map();
  }
}

/** Email -> Outlook contact id, for the user's connected account. The photo itself needs a
 * separate per-contact fetch (Graph doesn't inline it in the contacts list). Empty when
 * Outlook isn't connected or the lookup fails. */
export async function buildOutlookContactIndex(userId: string): Promise<Map<string, string>> {
  const db = await getDb();
  const conn = await db.query.outlookConnections.findFirst({
    where: eq(outlookConnections.userId, userId),
  });
  if (!conn || conn.status !== "active" || !hasOutlookContactsScope(conn.scopes)) {
    return new Map();
  }

  try {
    const accessToken = await getOutlookAccessToken(userId);
    const contacts = await fetchOutlookContacts(accessToken, OUTLOOK_CONTACT_INDEX_SELECT);
    const index = new Map<string, string>();
    for (const contact of contacts) {
      const email = contact.email?.trim();
      if (!email) continue;
      const key = normalizeEmail(email);
      if (!index.has(key)) index.set(key, contact.id);
    }
    return index;
  } catch {
    return new Map();
  }
}

/**
 * Email -> the name the user's own Google and Outlook address books give that person, for
 * the handle-name sweep (`@/lib/contact-name-sweep`). Google wins when both have someone.
 * Best-effort like the photo indexes: a missing connection or a failed fetch adds nothing.
 */
export async function buildProviderNameIndex(userId: string): Promise<ProviderNameIndex> {
  const db = await getDb();
  const [google, outlook] = await Promise.all([
    db.query.gmailConnections.findFirst({ where: eq(gmailConnections.userId, userId) }),
    db.query.outlookConnections.findFirst({ where: eq(outlookConnections.userId, userId) }),
  ]);
  const lists = await Promise.all([
    google?.status === "active" && hasContactsScope(google.scopes)
      ? getGoogleAccessToken(userId)
          .then((token) => fetchGooglePeopleContacts(token, "names,emailAddresses"))
          .catch(() => [])
      : [],
    outlook?.status === "active" && hasOutlookContactsScope(outlook.scopes)
      ? getOutlookAccessToken(userId)
          .then((token) => fetchOutlookContacts(token, OUTLOOK_CONTACT_INDEX_SELECT))
          .catch(() => [])
      : [],
  ]);
  const index: ProviderNameIndex = new Map();
  for (const person of lists.flat()) {
    const email = person.email?.trim();
    const full = person.fullName?.trim();
    if (!email || !full) continue;
    const key = normalizeEmail(email);
    if (!index.has(key)) {
      index.set(key, {
        first: person.firstName?.trim() || full.split(/\s+/)[0]!,
        last: person.lastName?.trim() || full.split(/\s+/).slice(1).join(" "),
        full,
      });
    }
  }
  return index;
}

/** One Outlook contact's photo as a data: URL, or null when they have none (a 404 from
 * Graph, which is the normal case, not an error). */
export async function fetchOutlookContactPhoto(
  userId: string,
  outlookContactId: string
): Promise<string | null> {
  try {
    const accessToken = await getOutlookAccessToken(userId);
    const res = await fetch(
      `https://graph.microsoft.com/v1.0/me/contacts/${outlookContactId}/photo/$value`,
      { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(10_000) }
    );
    if (!res.ok) return null;

    const contentType = (res.headers.get("content-type") || "image/jpeg").split(";")[0].trim();
    if (!contentType.startsWith("image/")) return null;

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength === 0) return null;
    return `data:${contentType};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}
