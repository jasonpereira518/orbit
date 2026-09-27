import { and, eq, ilike, or, sql } from "drizzle-orm";
import { after } from "next/server";
import { getDb } from "@/db";
import { contacts } from "@/db/schema";
import type {
  ContactSearchResponse,
  SaveContactRequest,
  SaveContactResponse,
} from "@/lib/extension/contract";
import { saveContactRequestSchema } from "@/lib/extension/contract.schema";
import { extensionRoute, preflight } from "@/lib/extension/http";
import { saveContactFromExtension } from "@/lib/extension/writes";

export const dynamic = "force-dynamic";

const SEARCH_LIMIT = 10;

/** Create a contact, or merge the page's fields into an existing one. */
export const POST = extensionRoute<SaveContactRequest, SaveContactResponse>({
  schema: saveContactRequestSchema,
  handler: ({ userId, input }) => saveContactFromExtension(userId, input, after),
});

/**
 * Keyword lookup, so the user can link a page to someone Orbit stored under a
 * different name. Without this, a `none` result is a dead end whenever the
 * stored record doesn't match what the page says.
 */
export const GET = extensionRoute<undefined, ContactSearchResponse>({
  handler: async ({ userId, req }) => {
    const q = new URL(req.url).searchParams.get("q")?.trim() ?? "";
    if (!q) return { results: [] };

    const db = await getDb();
    const like = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    const rows = await db
      .select({
        id: contacts.id,
        fullName: contacts.fullName,
        company: contacts.company,
        title: contacts.title,
        // Only an absolute https photo is useful to the extension: it is a different
        // origin (so `/api/avatars/{id}` would not resolve) and the wire contract
        // requires https. Decided in SQL so an inline row's base64 — up to 120 KB per
        // contact — never crosses the wire just to be dropped here.
        photoUrl: sql<string | null>`CASE
          WHEN ${contacts.profileImageUrl} IS NULL
            OR btrim(${contacts.profileImageUrl}) = ''
            OR ${contacts.profileImageUrl} LIKE 'data:%'
            OR ${contacts.profileImageUrl} LIKE '%unavatar.io%'
            OR ${contacts.profileImageUrl} LIKE '%static.licdn.com/aero%'
            OR ${contacts.profileImageUrl} NOT LIKE 'https://%'
          THEN NULL
          ELSE btrim(${contacts.profileImageUrl})
        END`,
      })
      .from(contacts)
      .where(
        and(
          eq(contacts.userId, userId),
          or(
            ilike(contacts.fullName, like),
            ilike(contacts.company, like),
            ilike(contacts.email, like)
          )
        )
      )
      .limit(SEARCH_LIMIT);

    return {
      results: rows.map((row) => ({
        id: row.id,
        fullName: row.fullName,
        company: row.company,
        title: row.title,
        photoUrl: row.photoUrl,
      })),
    };
  },
});

export const OPTIONS = preflight;
