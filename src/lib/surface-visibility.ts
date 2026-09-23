import { cache } from "react";
import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { appSurfaceFlags } from "@/db/schema";
import { isAdminUser } from "@/lib/admin";
import { recordAdminAction } from "@/lib/admin-operations";
import {
  COMING_SOON_COMPANIONS,
  COMING_SOON_KEYS,
  getSurface,
  isAlwaysVisible,
} from "@/lib/surfaces";

/**
 * The server half of surface visibility: which surfaces are hidden, and for whom.
 *
 * `src/lib/surfaces.ts` is the pure catalogue that client components may import. This
 * module reads the database and must never be imported from a client component.
 *
 * Enforcement is three layers, for the same reason the paywall is (see `plan-guards.ts`):
 * filtered navigation is cosmetic, Server Functions are reachable by direct POST, so the
 * nav, the route, and the action each have to check independently.
 */

/**
 * Set on an operator's own browser by `setViewAsUserAction`. Session-length and httpOnly —
 * nothing client-side reads it, and it should not survive the browser closing.
 *
 * Security posture: this cookie can only ever REMOVE the holder's own access, so forging
 * it gains an attacker nothing. `isViewingAsUser` still confirms the caller is an admin,
 * so a non-admin carrying it is treated as an ordinary user rather than as an operator
 * mid-preview — which keeps the banner, whose Exit button calls an admin-gated action,
 * from ever rendering for someone who could not use it.
 */
export const VIEW_AS_USER_COOKIE = "orbit_view_as_user";

/**
 * Set on an operator's own browser by `setPreviewUnreleasedAction`.
 *
 * Coming-soon pages default to closed for admins too — an operator building `/events` sees
 * the same dry-dock screen as everyone else unless they turn this on. That is the opposite
 * direction from `VIEW_AS_USER_COOKIE` (which starts an admin exempt and asks them to opt
 * INTO what a user sees): a released feature defaults open for an operator and a toggle can
 * narrow it, but an unreleased one must default closed or shipping the flag *is* shipping
 * the feature to whichever operator forgets to flip it back.
 */
export const PREVIEW_UNRELEASED_COOKIE = "orbit_preview_unreleased";

export class SurfaceHiddenError extends Error {
  readonly surfaceKey: string;

  constructor(surfaceKey: string) {
    super("This part of Orbit is not available right now.");
    this.name = "SurfaceHiddenError";
    this.surfaceKey = surfaceKey;
  }
}

export function isSurfaceHiddenError(err: unknown): err is SurfaceHiddenError {
  return err instanceof Error && err.name === "SurfaceHiddenError";
}

/**
 * Across requests, per server instance. Every page and gated action reads this table, and
 * on a sidebar click (which skips the layouts that would otherwise have read it once) it
 * was a round trip in front of the page's own queries. It changes only when an operator
 * flips a switch, so each instance re-reads it at most every `HIDDEN_KEYS_TTL_MS`:
 * `setSurfaceHidden` clears it at once on the instance that made the change, and other
 * instances catch up within the TTL. Hiding is product gating, not authorization — a
 * surface staying reachable for a few more seconds after it is hidden is acceptable.
 */
const HIDDEN_KEYS_TTL_MS = 15_000;
let hiddenKeysMemo: { keys: Set<string>; at: number } | null = null;

/** Forget the cross-request copy. For writers of `app_surface_flags`, including tests. */
export function invalidateHiddenSurfaceKeys(): void {
  hiddenKeysMemo = null;
}

/**
 * Every hidden surface key, regardless of who is asking.
 *
 * `cache()`d per request, the same idiom `getEntitlements` uses: the app-shell layout, the
 * route guard, and any action guard on one request all want this and should cost one
 * query between them. The table holds one row per hidden surface — a few dozen at the
 * absolute most — so reading all of it is cheaper than filtering in SQL.
 */
export const getHiddenSurfaceKeys = cache(async (): Promise<Set<string>> => {
  const now = Date.now();
  if (hiddenKeysMemo && now - hiddenKeysMemo.at < HIDDEN_KEYS_TTL_MS) {
    return hiddenKeysMemo.keys;
  }
  try {
    const db = await getDb();
    const rows = await db
      .select({ surfaceKey: appSurfaceFlags.surfaceKey })
      .from(appSurfaceFlags);
    const keys = new Set(rows.map((r) => r.surfaceKey));
    hiddenKeysMemo = { keys, at: now };
    return keys;
  } catch {
    // Visible is the safe failure. A database hiccup that hid half the product would be a
    // far worse outage than one that briefly showed a surface meant to be dark. Not
    // memoized, so the failure lasts one request rather than the whole TTL.
    return new Set<string>();
  }
});

/** True when this request is an operator deliberately previewing the app as a user. */
export const isViewingAsUser = cache(async (userId: string): Promise<boolean> => {
  if (!isAdminUser(userId)) return false;
  try {
    const store = await cookies();
    return store.get(VIEW_AS_USER_COOKIE)?.value === "1";
  } catch {
    // No request context — a background job, a cron, or a script. There is no browser
    // session to be previewing from, so the honest answer is no. Without this the
    // visibility resolver would throw everywhere `cookies()` is unavailable.
    return false;
  }
});

/** True when this request is an operator deliberately reaching past a coming-soon page. */
export const isPreviewingUnreleased = cache(async (userId: string): Promise<boolean> => {
  if (!isAdminUser(userId)) return false;
  try {
    const store = await cookies();
    return store.get(PREVIEW_UNRELEASED_COOKIE)?.value === "1";
  } catch {
    return false;
  }
});

export type SurfaceVisibility = {
  /** Keys hidden from THIS viewer. Empty for an exempt admin. */
  hidden: Set<string>;
  /** Keys hidden from ordinary users, whether or not this viewer is exempt. */
  hiddenForUsers: Set<string>;
  /** True when the viewer is an admin currently exempt from hiding. */
  exempt: boolean;
  viewingAsUser: boolean;
  /** Page keys THIS viewer gets the coming-soon screen for. Non-empty by default even for an admin — see `previewingUnreleased`. */
  comingSoon: Set<string>;
  /** True when an admin has opted into seeing real pages behind `comingSoon`. Always false for a non-admin. */
  previewingUnreleased: boolean;
};


/**
 * THE admin exemption, in one place. Every layer calls this and nothing else decides it.
 *
 * Operators keep access to hidden surfaces so they can check one before releasing it —
 * which is exactly why "view as a general user" exists, and why `hiddenForUsers` is
 * returned alongside: an exempt admin still needs to be shown WHICH surfaces their users
 * cannot see, or a forgotten toggle is invisible to the only person who can undo it.
 */
export async function resolveSurfaceVisibility(
  userId: string
): Promise<SurfaceVisibility> {
  const hiddenForUsers = await getHiddenSurfaceKeys();
  const admin = isAdminUser(userId);
  const viewingAsUser = admin && (await isViewingAsUser(userId));
  const exempt = admin && !viewingAsUser;
  const hidden = exempt ? new Set<string>() : new Set(hiddenForUsers);
  // Coming-soon is its OWN toggle, deliberately not tied to `exempt`: an operator is
  // exempt from hiding by default (so a released-but-hidden page is never a surprise 404
  // while they work on it), but an unreleased page must default CLOSED for everyone,
  // operators included, or merely being an admin ships the feature early. Reaching past it
  // takes the separate, explicit `previewingUnreleased` opt-in.
  const previewingUnreleased = admin && (await isPreviewingUnreleased(userId));
  const comingSoon = new Set<string>();
  if (!previewingUnreleased) {
    for (const key of COMING_SOON_KEYS) {
      comingSoon.add(key);
      for (const companion of COMING_SOON_COMPANIONS[key] ?? []) hidden.add(companion);
    }
  }
  return {
    hidden,
    hiddenForUsers,
    exempt,
    viewingAsUser,
    comingSoon,
    previewingUnreleased,
  };
}

export async function isSurfaceVisible(
  userId: string,
  surfaceKey: string
): Promise<boolean> {
  if (isAlwaysVisible(surfaceKey)) return true;
  const { hidden } = await resolveSurfaceVisibility(userId);
  return !hidden.has(surfaceKey);
}

/** Throws `SurfaceHiddenError` unless this viewer may reach `surfaceKey`. */
export async function requireVisibleSurface(userId: string, surfaceKey: string) {
  if (!(await isSurfaceVisible(userId, surfaceKey))) {
    throw new SurfaceHiddenError(surfaceKey);
  }
}

/**
 * Throws `SurfaceHiddenError` unless `surfaceKey` is both switched on and released for
 * this viewer. `requireVisibleSurface` ignores `comingSoon` on purpose — the pages that use
 * it predate the flag — but a page that ships closed must close its actions too: a Server
 * Function answers a direct POST whether or not the nav shows the page.
 */
export async function requireReleasedSurface(userId: string, surfaceKey: string) {
  if (isAlwaysVisible(surfaceKey)) return;
  const { hidden, comingSoon } = await resolveSurfaceVisibility(userId);
  if (hidden.has(surfaceKey) || comingSoon.has(surfaceKey)) {
    throw new SurfaceHiddenError(surfaceKey);
  }
}

/**
 * Hide or unhide a surface for everyone.
 *
 * Takes the admin id explicitly and does no auth of its own, matching every other operator
 * write in `admin-operations.ts` — the gate lives in the action, and keeping the work in a
 * plain function is what lets `scripts/smoke-surface-visibility.ts` exercise it without a
 * request context. For the same reason there is no `revalidatePath` here: it means nothing
 * outside a request, and the action calls it.
 *
 * No reason string is required, unlike suspension or deletion. Those call `requireReason`
 * because they are hard to undo; this writes or deletes one row and is reversible by the
 * same click that caused it. It is still audited.
 */
export async function setSurfaceHidden(
  adminUserId: string,
  surfaceKey: string,
  hidden: boolean
): Promise<void> {
  const surface = getSurface(surfaceKey);
  if (!surface) {
    throw new Error(`Unknown surface: ${surfaceKey}`);
  }
  if (surface.alwaysVisible) {
    throw new Error(`${surface.label} cannot be hidden. ${surface.reason ?? ""}`.trim());
  }

  const db = await getDb();
  if (hidden) {
    await db
      .insert(appSurfaceFlags)
      .values({ surfaceKey, hiddenBy: adminUserId })
      .onConflictDoNothing();
  } else {
    await db.delete(appSurfaceFlags).where(eq(appSurfaceFlags.surfaceKey, surfaceKey));
  }
  invalidateHiddenSurfaceKeys();

  await recordAdminAction({
    adminUserId,
    action: hidden ? "product.surface.hide" : "product.surface.show",
    resourceType: "surface",
    resourceId: surfaceKey,
    detail: { label: surface.label, kind: surface.kind },
  });
}
