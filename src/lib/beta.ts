import { cache } from "react";
import { ensureUserSettings } from "@/lib/user-settings";

/**
 * Whether an account is a testing account.
 *
 * A beta account carries two grants, resolved in two different places from this one column:
 * full paid entitlements (`resolvePlan` in `src/lib/entitlements.ts`, which ranks `beta`
 * above every billing signal) and the surfaces marked `beta` in `src/lib/surfaces.ts`
 * (`resolveSurfaceVisibility`). This module is the single read of the flag itself.
 *
 * Beta is NOT early access to unreleased product features — see the column's comment in
 * `schema.ts`. It opens the testing tools and nothing else.
 *
 * Costs no extra query: `ensureUserSettings` is `cache()`d and already runs on every
 * authenticated request, so this is a second read of a row that is in memory anyway.
 */
export const isBetaUser = cache(async (userId: string): Promise<boolean> => {
  if (!userId || userId === "demo-user") return false;
  try {
    const row = await ensureUserSettings(userId);
    return row?.betaAccess === true;
  } catch {
    // Fails CLOSED, deliberately inverting the neighbouring rule in
    // `getHiddenSurfaceKeys`, which fails open because a database hiccup that hid half the
    // product is worse than one that shows a surface early. The reverse is true here: the
    // beta surfaces are testing tools — one of them wipes and reseeds the caller's own
    // account — and a hiccup that handed those to every user is far worse than one that
    // briefly withheld them from a tester.
    return false;
  }
});
