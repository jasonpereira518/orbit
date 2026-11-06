import { cache } from "react";
import { cookies } from "next/headers";
import { eq, inArray, like } from "drizzle-orm";
import { getDb } from "@/db";
import { appSurfaceFlags } from "@/db/schema";
import { isAdminUser } from "@/lib/admin";
import { recordAdminAction } from "@/lib/admin-audit";
import { isDemoAccount } from "@/lib/demo-account";
import { isDemoWorkspace } from "@/lib/demo-workspace";
import { PaywallError, getEntitlements } from "@/lib/entitlements";
import { PLANS, PLAN_SHORT_LABELS, type Plan } from "@/lib/plans/plan-config";
import {
  COMING_SOON_COMPANIONS,
  DEFAULT_COMING_SOON_KEYS,
  LIVE_FLAG_PREFIX,
  ORDER_FLAG_PREFIX,
  SOON_FLAG_PREFIX,
  TIERS_FLAG_PREFIX,
  canMarkComingSoon,
  canTierLock,
  effectiveComingSoonKeys,
  getSurface,
  isAlwaysVisible,
  parseTierRules,
  surfaceKeyForHref,
  tierLockedFor,
} from "@/lib/surfaces";
import { APP_NAV_CORE, APP_NAV_EXTRAS } from "@/components/layout/app-nav";

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
type FlagSnapshot = {
  hidden: Set<string>;
  comingSoon: Set<string>;
  navOrder: string[];
  tierRules: Map<string, Plan[]>;
};
let flagsMemo: { snapshot: FlagSnapshot; at: number } | null = null;

/** Forget the cross-request copy. For writers of `app_surface_flags`, including tests. */
export function invalidateHiddenSurfaceKeys(): void {
  flagsMemo = null;
}

/**
 * One read of `app_surface_flags`, split into its two meanings: plain keys are hidden
 * surfaces, `soon:`/`live:` rows are coming-soon overrides (see `effectiveComingSoonKeys`).
 * Kept in one table so marking a page coming soon needs no schema migration.
 */
const getFlagSnapshot = cache(async (): Promise<FlagSnapshot> => {
  const now = Date.now();
  if (flagsMemo && now - flagsMemo.at < HIDDEN_KEYS_TTL_MS) return flagsMemo.snapshot;
  try {
    const db = await getDb();
    const rows = await db
      .select({ surfaceKey: appSurfaceFlags.surfaceKey })
      .from(appSurfaceFlags);
    const all = rows.map((r) => r.surfaceKey);
    const isOverride = (k: string) =>
      k.startsWith(SOON_FLAG_PREFIX) ||
      k.startsWith(LIVE_FLAG_PREFIX) ||
      k.startsWith(ORDER_FLAG_PREFIX) ||
      k.startsWith(TIERS_FLAG_PREFIX);
    const orderRow = all.find((k) => k.startsWith(ORDER_FLAG_PREFIX));
    const snapshot: FlagSnapshot = {
      hidden: new Set(all.filter((k) => !isOverride(k))),
      comingSoon: effectiveComingSoonKeys(all),
      navOrder: orderRow
        ? orderRow.slice(ORDER_FLAG_PREFIX.length).split(",").filter(Boolean)
        : [],
      tierRules: parseTierRules(all),
    };
    flagsMemo = { snapshot, at: now };
    return snapshot;
  } catch {
    // Visible is the safe failure for hiding: a database hiccup that hid half the product
    // would be a far worse outage than one that briefly showed a surface meant to be dark.
    // Coming-soon falls back to the code defaults for the same reason. Not memoized, so the
    // failure lasts one request rather than the whole TTL.
    return {
      hidden: new Set<string>(),
      comingSoon: new Set(DEFAULT_COMING_SOON_KEYS),
      navOrder: [],
      // Open, like `hidden`: a hiccup should not lock paying users out of a page.
      tierRules: new Map(),
    };
  }
});

/**
 * Every hidden surface key, regardless of who is asking.
 *
 * `cache()`d per request, the same idiom `getEntitlements` uses: the app-shell layout, the
 * route guard, and any action guard on one request all want this and should cost one
 * query between them. The table holds one row per hidden surface — a few dozen at the
 * absolute most — so reading all of it is cheaper than filtering in SQL.
 */
export const getHiddenSurfaceKeys = cache(async (): Promise<Set<string>> => {
  return (await getFlagSnapshot()).hidden;
});

/** The operator's sidebar order as surface keys; empty means the code's own order. */
export const getNavOrder = cache(async (): Promise<string[]> => {
  return (await getFlagSnapshot()).navOrder;
});

/**
 * Pages currently marked coming soon for everyone: the code defaults plus the operator's
 * overrides. Independent of who is asking and of the preview cookie; use for jobs and for
 * the "Soon" tags, and `resolveSurfaceVisibility(...).comingSoon` for what a viewer gets.
 */
export const getComingSoonKeys = cache(async (): Promise<Set<string>> => {
  return (await getFlagSnapshot()).comingSoon;
});

/** Every tier rule: page key → the plans allowed to open it. Absent means every plan. */
export const getTierRules = cache(async (): Promise<Map<string, Plan[]>> => {
  return (await getFlagSnapshot()).tierRules;
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
  /** Every page marked coming soon, preview or not. What the nav tags "Soon". */
  comingSoonMarked: Set<string>;
  /** Sidebar order chosen by the operator, as surface keys. */
  navOrder: string[];
  /** Pages THIS viewer's plan may not open → the plans that may. Empty for an exempt admin and the demo workspace. */
  tierLocked: Map<string, Plan[]>;
  /** Every tier rule, whoever is asking — what an exempt admin's nav tags. */
  tierRules: Map<string, Plan[]>;
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
  const marked = await getComingSoonKeys();
  // The demo workspace records product demos, so its unreleased PAGES read as released —
  // no teaser, no "Soon" tag, companions shown. Unreleased features stay hidden.
  const demoPages = marked.size > 0 && (await isDemoWorkspace(userId));
  const comingSoon = new Set<string>();
  const comingSoonMarked = new Set(marked);
  if (!previewingUnreleased) {
    for (const key of marked) {
      if (demoPages && getSurface(key)?.kind === "page") {
        comingSoonMarked.delete(key);
        continue;
      }
      // A page gets the coming-soon screen; a feature has no screen of its own to show, so
      // it is simply hidden, which every entry point and guard already respects.
      if (getSurface(key)?.kind === "page") comingSoon.add(key);
      else hidden.add(key);
      for (const companion of COMING_SOON_COMPANIONS[key] ?? []) hidden.add(companion);
    }
  }
  // Tier rules follow the same exemption as hiding (an operator checking a page keeps it).
  // Demo accounts (localhost, the showcase) are exempt exactly as `getEntitlements` lifts
  // every plan gate for them, and so is the demo workspace. Read the plan only when a rule
  // exists: most requests then cost nothing extra, and when one does `getEntitlements` is
  // the call the app layout has already made this request.
  const tierRules = await getTierRules();
  const tierLocked =
    tierRules.size === 0 || exempt || isDemoAccount(userId) || (await isDemoWorkspace(userId))
      ? new Map<string, Plan[]>()
      : tierLockedFor(tierRules, (await getEntitlements(userId)).plan);
  return {
    hidden,
    hiddenForUsers,
    exempt,
    viewingAsUser,
    comingSoon,
    previewingUnreleased,
    comingSoonMarked,
    navOrder: await getNavOrder(),
    tierLocked,
    tierRules,
  };
}

/** "Radar is on Orbit Max and Lifetime." — the refusal a tier-locked page's actions give. */
export function tierLockedMessage(label: string, plans: readonly Plan[]): string {
  const names = plans.map((p) => PLAN_SHORT_LABELS[p]);
  const list =
    names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `${label} is available on ${list} plans.`;
}

/**
 * Throws the upgrade refusal when this viewer's plan may not open `surfaceKey`. A
 * `PaywallError`, not `SurfaceHiddenError`, so the toast names the plan that opens it.
 */
async function throwIfTierLocked(userId: string, visibility: SurfaceVisibility, surfaceKey: string) {
  const plans = visibility.tierLocked.get(surfaceKey);
  if (!plans) return;
  const label = getSurface(surfaceKey)?.label ?? surfaceKey;
  const { plan } = await getEntitlements(userId);
  throw new PaywallError("page", plan, tierLockedMessage(label, plans));
}

export async function isSurfaceVisible(
  userId: string,
  surfaceKey: string
): Promise<boolean> {
  if (isAlwaysVisible(surfaceKey)) return true;
  const { hidden, tierLocked } = await resolveSurfaceVisibility(userId);
  return !hidden.has(surfaceKey) && !tierLocked.has(surfaceKey);
}

/**
 * True when this viewer can USE `surfaceKey`: not hidden, and released or being previewed.
 * `isSurfaceVisible` says yes to a coming-soon page, which is right for the page (it renders
 * its teaser) and wrong for anything elsewhere that points INTO it — a bell row or a chat
 * suggestion drawn from a feature the viewer cannot open yet.
 */
export async function isSurfaceLive(userId: string, surfaceKey: string): Promise<boolean> {
  const { hidden, comingSoon, tierLocked } = await resolveSurfaceVisibility(userId);
  return !hidden.has(surfaceKey) && !comingSoon.has(surfaceKey) && !tierLocked.has(surfaceKey);
}

/** Throws `SurfaceHiddenError` (or `PaywallError` for a tier-locked page) unless this viewer may reach `surfaceKey`. */
export async function requireVisibleSurface(userId: string, surfaceKey: string) {
  if (isAlwaysVisible(surfaceKey)) return;
  const visibility = await resolveSurfaceVisibility(userId);
  if (visibility.hidden.has(surfaceKey)) throw new SurfaceHiddenError(surfaceKey);
  await throwIfTierLocked(userId, visibility, surfaceKey);
}

/**
 * Throws `SurfaceHiddenError` unless `surfaceKey` is both switched on and released for
 * this viewer. `requireVisibleSurface` ignores `comingSoon` on purpose — the pages that use
 * it predate the flag — but a page that ships closed must close its actions too: a Server
 * Function answers a direct POST whether or not the nav shows the page.
 */
export async function requireReleasedSurface(userId: string, surfaceKey: string) {
  if (isAlwaysVisible(surfaceKey)) return;
  const visibility = await resolveSurfaceVisibility(userId);
  if (visibility.hidden.has(surfaceKey) || visibility.comingSoon.has(surfaceKey)) {
    throw new SurfaceHiddenError(surfaceKey);
  }
  await throwIfTierLocked(userId, visibility, surfaceKey);
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

/**
 * Mark a page coming soon, or release it, for everyone.
 *
 * Stores only the difference from the code default in `surfaces.ts`: matching the default
 * deletes both override rows, so the table never carries a redundant row and a page whose
 * default later changes in code follows it. Audited like every other operator write.
 */
export async function setSurfaceComingSoon(
  adminUserId: string,
  surfaceKey: string,
  soon: boolean
): Promise<void> {
  const surface = getSurface(surfaceKey);
  if (!surface) throw new Error(`Unknown surface: ${surfaceKey}`);
  if (!canMarkComingSoon(surfaceKey)) {
    throw new Error(`${surface.label} cannot be marked coming soon. ${surface.reason ?? ""}`.trim());
  }

  const db = await getDb();
  const soonKey = `${SOON_FLAG_PREFIX}${surfaceKey}`;
  const liveKey = `${LIVE_FLAG_PREFIX}${surfaceKey}`;
  await db.delete(appSurfaceFlags).where(inArray(appSurfaceFlags.surfaceKey, [soonKey, liveKey]));
  if (soon !== DEFAULT_COMING_SOON_KEYS.has(surfaceKey)) {
    await db
      .insert(appSurfaceFlags)
      .values({ surfaceKey: soon ? soonKey : liveKey, hiddenBy: adminUserId })
      .onConflictDoNothing();
  }
  invalidateHiddenSurfaceKeys();

  await recordAdminAction({
    adminUserId,
    action: soon ? "product.surface.coming_soon" : "product.surface.release",
    resourceType: "surface",
    resourceId: surfaceKey,
    detail: { label: surface.label, kind: surface.kind },
  });
}

/** Surface keys of every page that has a sidebar entry — the only ones an order may name. */
export function navSurfaceKeys(): string[] {
  return [...APP_NAV_CORE, ...APP_NAV_EXTRAS]
    .map((item) => surfaceKeyForHref(item.href))
    .filter((k): k is string => k !== null);
}

/**
 * Save the sidebar order for everyone. Replaces the whole list in one write; every key must
 * be a real nav page, so a forged action cannot smuggle arbitrary text into the flag row.
 */
export async function setNavOrder(adminUserId: string, keys: string[]): Promise<void> {
  const valid = new Set(navSurfaceKeys());
  if (new Set(keys).size !== keys.length || keys.some((k) => !valid.has(k))) {
    throw new Error("That sidebar order includes a page that is not in the sidebar.");
  }
  const db = await getDb();
  await db.delete(appSurfaceFlags).where(like(appSurfaceFlags.surfaceKey, `${ORDER_FLAG_PREFIX}%`));
  if (keys.length > 0) {
    await db
      .insert(appSurfaceFlags)
      .values({ surfaceKey: `${ORDER_FLAG_PREFIX}${keys.join(",")}`, hiddenBy: adminUserId })
      .onConflictDoNothing();
  }
  invalidateHiddenSurfaceKeys();

  await recordAdminAction({
    adminUserId,
    action: "product.nav.reorder",
    resourceType: "surface",
    resourceId: "nav-order",
    detail: { order: keys },
  });
}

/**
 * Limit a page to some tiers, or open it to every tier again.
 *
 * Every plan deletes the rule rather than storing a redundant one. An empty list is refused:
 * a page nobody may open is what Hide is for, and a rule that locks out everyone (operators
 * aside) would be that switch wearing a disguise. Audited like every other operator write.
 */
export async function setSurfaceTiers(
  adminUserId: string,
  surfaceKey: string,
  plans: readonly string[]
): Promise<void> {
  const surface = getSurface(surfaceKey);
  if (!surface) throw new Error(`Unknown surface: ${surfaceKey}`);
  if (!canTierLock(surfaceKey)) {
    throw new Error(`${surface.label} cannot be limited to some plans. ${surface.reason ?? ""}`.trim());
  }
  if (plans.some((p) => !(PLANS as readonly string[]).includes(p))) {
    throw new Error("That tier list includes a plan that does not exist.");
  }
  const allowed = PLANS.filter((p) => plans.includes(p));
  if (allowed.length === 0) {
    throw new Error("Pick at least one plan. To close a page for everyone, hide it instead.");
  }

  const db = await getDb();
  await db
    .delete(appSurfaceFlags)
    .where(like(appSurfaceFlags.surfaceKey, `${TIERS_FLAG_PREFIX}${surfaceKey}:%`));
  if (allowed.length < PLANS.length) {
    await db
      .insert(appSurfaceFlags)
      .values({
        surfaceKey: `${TIERS_FLAG_PREFIX}${surfaceKey}:${allowed.join(",")}`,
        hiddenBy: adminUserId,
      })
      .onConflictDoNothing();
  }
  invalidateHiddenSurfaceKeys();

  await recordAdminAction({
    adminUserId,
    action: "product.surface.tiers",
    resourceType: "surface",
    resourceId: surfaceKey,
    detail: { label: surface.label, plans: allowed },
  });
}
