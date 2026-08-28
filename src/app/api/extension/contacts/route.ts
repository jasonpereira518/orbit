import { and, eq, ilike, or } from "drizzle-orm";
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
    const rows = await db.query.contacts.findMany({
      where: and(
        eq(contacts.userId, userId),
        or(
          ilike(contacts.fullName, like),
          ilike(contacts.company, like),
          ilike(contacts.email, like)
        )
      ),
      columns: {
        id: true,
        fullName: true,
        company: true,
        title: true,
        profileImageUrl: true,
      },
      limit: SEARCH_LIMIT,
    });

    return {
      results: rows.map((row) => ({
        id: row.id,
        fullName: row.fullName,
        company: row.company,
        title: row.title,
        photoUrl: row.profileImageUrl,
      })),
    };
  },
});

export const OPTIONS = preflight;
