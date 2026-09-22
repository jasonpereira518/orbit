import type {
  ContactSearchResponse,
  SaveContactRequest,
  SaveContactResponse,
} from "@/lib/extension/contract";
import { saveContactRequestSchema } from "@/lib/extension/contract.schema";
import { deferSafely, extensionRoute, preflight } from "@/lib/extension/http";
import { extensionFeatures } from "@/lib/extension/entitlements";
import { searchContactsForExtension } from "@/lib/extension/search";
import { saveContactFromExtension } from "@/lib/extension/writes";

export const dynamic = "force-dynamic";

/** Create a contact, or merge the page's fields into an existing one. */
export const POST = extensionRoute<SaveContactRequest, SaveContactResponse>({
  schema: saveContactRequestSchema,
  handler: ({ userId, input }) => saveContactFromExtension(userId, input, deferSafely),
});

/**
 * Search, so the user can find anyone — to jot a note about them, or to link a
 * page to someone Orbit stored under a different name. Keyword on every plan,
 * ranked on Pro; see `src/lib/extension/search.ts`.
 */
export const GET = extensionRoute<undefined, ContactSearchResponse>({
  handler: async ({ userId, req, entitlements }) => {
    const q = new URL(req.url).searchParams.get("q")?.trim() ?? "";
    return searchContactsForExtension(userId, q, {
      ranked: extensionFeatures(entitlements).search,
    });
  },
});

export const OPTIONS = preflight;
