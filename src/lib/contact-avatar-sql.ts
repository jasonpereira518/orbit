import { sql } from "drizzle-orm";
import { contacts } from "@/db/schema";
import { NO_PHOTO_PREFIX } from "@/lib/contact-avatar-url";

/**
 * `clientContactAvatarUrl()` expressed in SQL, so list scans can return a browser-safe
 * avatar URL WITHOUT selecting `profile_image_url` itself.
 *
 * That column holds base64 up to 120 KB per contact when Blob storage is not configured.
 * Every hot path used to select it for every contact and then rewrite it to
 * `/api/avatars/{id}` server-side — the bytes crossed the wire from Postgres only to be
 * thrown away. Deciding it in Postgres keeps them there. Mirrors `isUnusableAvatarUrl`
 * and `clientContactAvatarUrl` in `src/lib/contact-avatar-url.ts`; keep the three in step.
 *
 * Server-only (imports drizzle); the pure helpers stay in `contact-avatar-url.ts`.
 *
 * The `NO_PHOTO_PREFIX` branch is the one that was missing. The negative-cache marker is not
 * a photo, and without that branch it fell through to the ELSE and was handed to the graph
 * and the dashboard as the src of an image element — a broken image where an initials
 * fallback belongs. `isUnusableAvatarUrl` has refused the marker since it shipped; this
 * mirror never learned it, which is precisely the drift the note above warns about. The
 * prefix is now interpolated from the same constant rather than restated here.
 */
export const clientAvatarUrlSql = sql<string | null>`CASE
  WHEN ${contacts.profileImageUrl} IS NULL OR btrim(${contacts.profileImageUrl}) = '' THEN NULL
  WHEN ${contacts.profileImageUrl} LIKE ${NO_PHOTO_PREFIX + "%"} THEN NULL
  WHEN ${contacts.profileImageUrl} LIKE 'data:image/%' THEN '/api/avatars/' || ${contacts.id}
  WHEN ${contacts.profileImageUrl} LIKE '%unavatar.io%'
    OR ${contacts.profileImageUrl} LIKE '%static.licdn.com/aero%' THEN NULL
  ELSE btrim(${contacts.profileImageUrl})
END`;

/**
 * The columns the contacts list selects.
 *
 * Exported so `scripts/smoke-page-budgets.ts` can run the real projection and assert the
 * base64 column never leaves Postgres. `listContactsPage` itself calls `requireUserId()`,
 * so a smoke cannot invoke it directly — and an unguarded hot query is exactly how the
 * bare-column regression got in, on the one scan that matters most.
 */
export const contactsListSelection = {
  id: contacts.id,
  fullName: contacts.fullName,
  firstName: contacts.firstName,
  lastName: contacts.lastName,
  preferredName: contacts.preferredName,
  title: contacts.title,
  company: contacts.company,
  school: contacts.school,
  location: contacts.location,
  linkedinUrl: contacts.linkedinUrl,
  profileImageUrl: clientAvatarUrlSql,
  /**
   * Whether `/api/avatars/{id}` has any source to try for this contact.
   *
   * Computed in SQL so the list can opt a row into on-demand resolution without the
   * payload carrying the email address itself — the list has no other use for it.
   */
  canResolveAvatar: sql<boolean>`(
    (${contacts.linkedinUrl} IS NOT NULL AND btrim(${contacts.linkedinUrl}) <> '')
    OR (${contacts.email} IS NOT NULL AND btrim(${contacts.email}) <> '')
  )`,
  relationshipScore: contacts.relationshipScore,
  closeness: contacts.closeness,
  closenessTier: contacts.closenessTier,
  priorityLevel: contacts.priorityLevel,
  nextFollowUpAt: contacts.nextFollowUpAt,
  lastInteractionAt: contacts.lastInteractionAt,
  sortKey: contacts.sortKey,
  updatedAt: contacts.updatedAt,
};
