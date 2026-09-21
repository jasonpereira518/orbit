import { and, count, eq, isNotNull, lte } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts } from "@/db/schema";
import { getAiCapability } from "@/lib/ai";
import { AI_PROVIDERS } from "@/lib/ai-providers";
import { userHasApolloKey } from "@/lib/apollo";
import { getCurrentUserProfile } from "@/lib/auth";
import { getAppBaseUrl } from "@/lib/app-url";
import type { MeResponse } from "@/lib/extension/contract";
import {
  EXTENSION_CONTRACT_VERSION,
  MIN_SUPPORTED_CONTRACT_VERSION,
} from "@/lib/extension/contract";
import { extensionEntitlements } from "@/lib/extension/entitlements";
import { extensionRoute, preflight } from "@/lib/extension/http";

export const dynamic = "force-dynamic";

/**
 * Session probe and capability report. The extension calls this on open, both
 * to confirm it is still signed in and to learn whether AI features are
 * available — `hasAiKey: false` is a normal state that switches the popup to
 * heuristic starters, not an error.
 */
export const GET = extensionRoute<undefined, MeResponse>({
  handler: async ({ userId, entitlements }) => {
    const db = await getDb();
    const now = new Date();

    const [profile, ai, hasApolloKey, [contactRow], [dueRow]] =
      await Promise.all([
        getCurrentUserProfile(),
        getAiCapability(userId),
        userHasApolloKey(userId),
        db
          .select({ value: count() })
          .from(contacts)
          .where(eq(contacts.userId, userId)),
        // A targeted count — getDashboardData would do far more work than a
        // badge number justifies.
        db
          .select({ value: count() })
          .from(contacts)
          .where(
            and(
              eq(contacts.userId, userId),
              isNotNull(contacts.nextFollowUpAt),
              lte(contacts.nextFollowUpAt, now)
            )
          ),
      ]);

    return {
      contractVersion: EXTENSION_CONTRACT_VERSION,
      user: {
        name: profile?.name ?? null,
        email: profile?.email ?? null,
        imageUrl: profile?.imageUrl ?? null,
      },
      capabilities: {
        hasAiKey: ai.hasKey,
        hasApolloKey,
        aiProvider: ai.provider,
        aiProviderLabel:
          AI_PROVIDERS.find((provider) => provider.id === ai.provider)?.label ??
          ai.provider,
      },
      stats: {
        contactCount: contactRow?.value ?? 0,
        dueFollowUpCount: dueRow?.value ?? 0,
      },
      minSupportedContractVersion: MIN_SUPPORTED_CONTRACT_VERSION,
      // Free of any extra query: the wrapper already resolved the entitlements,
      // and the contact count above is what the remaining headroom needs.
      entitlements: extensionEntitlements(entitlements, contactRow?.value ?? 0),
      links: {
        app: getAppBaseUrl(),
        pricing: new URL("/pricing?from=extension", getAppBaseUrl()).toString(),
        settings: new URL("/settings", getAppBaseUrl()).toString(),
      },
    };
  },
});

export const OPTIONS = preflight;
