import { cache } from "react";
import { auth, currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { isClerkConfigured, isDemoMode } from "@/lib/demo-account";
import { ensureLocalDemoData } from "@/lib/demo-data/ensure";
import { needsOnboarding } from "@/lib/onboarding";
import { isHeldByStealth } from "@/lib/site-access";
import { ensureUserSettings } from "@/lib/user-settings";

export class UnauthorizedError extends Error {
  constructor(message = "Unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

/**
 * Thrown by `requireUserId()` for an account an operator has suspended.
 *
 * Distinct from `UnauthorizedError` because the two need opposite handling: unauthorized
 * means "sign in", suspended means "signing in again will not help". `(app)/layout.tsx`
 * redirects to /suspended rather than to /sign-in.
 */
export class AccountSuspendedError extends Error {
  constructor(public readonly suspendedAt: Date) {
    super("Account suspended");
    this.name = "AccountSuspendedError";
  }
}

/**
 * Thrown by `requireUserId()` for an account stealth is holding: one created while the site
 * was in stealth, without an admin's invitation (see `src/lib/site-access.ts`). A subclass of
 * `UnauthorizedError` so every route that already answers 401 for "not signed in" answers
 * the same for this; `(app)/layout.tsx` sends the person to the waitlist instead.
 */
export class AccountHeldError extends UnauthorizedError {
  constructor() {
    super("This account is waiting for an invitation");
    this.name = "AccountHeldError";
  }
}

export { isClerkConfigured, isDemoMode };

/**
 * Idempotent per-request bootstrap so layouts + pages don't repeat DB work. On localhost it
 * also fills an empty account with the demo workspace (see `ensureLocalDemoData`), before
 * anything downstream — the onboarding gate included — reads the account.
 */
export const bootstrapAuthenticatedUser = cache(async (userId: string) => {
  const settings = await ensureUserSettings(userId);
  await ensureLocalDemoData(userId);
  return settings;
});

export async function getPostAuthRedirectPath(userId: string) {
  return (await needsOnboarding(userId)) ? "/onboarding" : "/dashboard";
}

/**
 * Redirect signed-in users away from /sign-in and /sign-up.
 *
 * Demo mode counts as signed in: `requireUserId()` already treats `demo-user` as an
 * authenticated identity everywhere else in the app (dashboard, settings, /upgrade), so
 * showing these two pages a dead "Clerk is not configured" wall instead of just carrying
 * the visitor into the app was the inconsistency, not a deliberate gate. This runs the
 * same way on any demo server or worktree — it keys off `isDemoMode()`, not local config.
 */
export async function redirectIfAuthenticated() {
  if (isDemoMode()) {
    redirect(await getPostAuthRedirectPath("demo-user"));
  }

  if (!isClerkConfigured()) return;

  const { userId } = await auth();
  if (!userId) return;

  redirect(await getPostAuthRedirectPath(userId));
}

/**
 * The suspension gate.
 *
 * This lives here rather than in `(app)/layout.tsx` because a layout is not the boundary:
 * layouts do not re-run for Server Action POSTs, and actions are reachable by direct POST
 * rather than only through Orbit's own UI — the same lesson `src/lib/plan-guards.ts` and
 * `src/lib/admin.ts` both document. `requireUserId` is the one function every page, action
 * and route handler already funnels through, and it already holds the settings row, so the
 * check costs nothing extra.
 *
 * Demo mode is exempt: `demo-user` is a shared local literal, never a real account.
 */
export const requireUserId = cache(async (): Promise<string> => {
  if (isDemoMode()) {
    await bootstrapAuthenticatedUser("demo-user");
    return "demo-user";
  }

  if (!isClerkConfigured()) {
    throw new UnauthorizedError(
      "Authentication is required. Configure Clerk API keys."
    );
  }

  // Scoped to the Clerk call alone: it is the only thing here whose failure means
  // "not signed in". Everything after it — the settings bootstrap, and so the database —
  // must be allowed to throw its own error. A catch wrapped around the bootstrap reports
  // every outage as UnauthorizedError, which is what turned a missing `user_settings`
  // column into 15 bogus auth failures on /dashboard while the real cause stayed hidden.
  let userId: string | null = null;
  try {
    ({ userId } = await auth());
  } catch {
    // Middleware missing or Clerk runtime fault — indistinguishable from signed out.
  }

  if (userId) {
    const settings = await bootstrapAuthenticatedUser(userId);
    if (settings.suspendedAt) {
      throw new AccountSuspendedError(settings.suspendedAt);
    }
    if (await isHeldByStealth(userId, settings)) throw new AccountHeldError();
    return userId;
  }

  throw new UnauthorizedError();
});

export type UserProfile = {
  id: string;
  name: string;
  email: string;
  imageUrl?: string;
};

/**
 * The signed-in user's profile for RENDERING — a name to greet, an avatar, an address to
 * show — read from the `user_settings` mirror instead of Clerk's Backend API.
 *
 * `getCurrentUserProfile()` below is a network call to Clerk on every use. The dashboard,
 * the graph and the settings page all made it while rendering, so a page switch waited on
 * Clerk as well as on Postgres. The mirror (`setUserEmail` / `setUserIdentity`, kept by the
 * `user.created`/`user.updated` webhook) holds the same fields, and the row is already
 * loaded and request-cached by `requireUserId()` — so this is usually zero round trips.
 *
 * Falls back to Clerk whenever the mirror cannot answer (no email, or no name at all),
 * which is also what backfills it. Anything where a stale value would be WRONG rather than
 * merely out of date — a Stripe customer's email, a From line — keeps calling
 * `getCurrentUserProfile()` directly.
 *
 * Request-`cache()`d because /settings asks for it twice in one render. The wrapper changes
 * nothing about the answer: it takes no arguments and reads only request-scoped state.
 */
export const getDisplayProfile = cache(async (): Promise<UserProfile | null> => {
  if (isDemoMode() || !isClerkConfigured()) return getCurrentUserProfile();

  try {
    const { userId } = await auth();
    if (userId) {
      const mirrored = displayProfileFromSettings(userId, await ensureUserSettings(userId));
      if (mirrored) return mirrored;
    }
  } catch {
    // Fall through to Clerk: a missing mirror is a slower page, never a broken one.
  }
  return getCurrentUserProfile();
});

/**
 * The mirror's answer, or `null` when it cannot give a whole one — the same predicate
 * `getDisplayProfile()` uses, exported so a caller that is ALREADY holding the
 * `user_settings` row can skip the call instead of re-deriving the rule and risking drift.
 *
 * `(app)/layout.tsx` is that caller. It holds `settings` from `bootstrapAuthenticatedUser`,
 * and its only use for a profile is the nav's account menu — but `getDisplayProfile()` falls
 * through to `getCurrentUserProfile()` whenever the mirror lacks BOTH names, which is the
 * permanent state of an account created without name collection. That fall-through is a
 * Clerk Backend API round trip plus an identity write, on the critical path of every
 * authenticated navigation, for the life of that account. Deciding from the row already in
 * hand costs nothing, and the slow path is left to the accounts that genuinely need it.
 *
 * Pure and synchronous on purpose: no `auth()`, no database, nothing to cache.
 */
export function displayProfileFromSettings(
  userId: string,
  settings: {
    firstName?: string | null;
    lastName?: string | null;
    email?: string | null;
    profileImageUrl?: string | null;
  } | null
): UserProfile | null {
  const name = [settings?.firstName, settings?.lastName].filter(Boolean).join(" ");
  if (!settings?.email || !name) return null;
  return {
    id: userId,
    name,
    email: settings.email,
    imageUrl: settings.profileImageUrl ?? undefined,
  };
}

export async function getCurrentUserProfile(): Promise<UserProfile | null> {
  if (isDemoMode()) {
    return {
      id: "demo-user",
      name: "Demo User",
      email: "demo@orbit.local",
      imageUrl: undefined,
    };
  }

  if (!isClerkConfigured()) {
    return null;
  }

  try {
    const user = await currentUser();
    if (user) {
      const email = user.primaryEmailAddress?.emailAddress ?? "";
      // Opportunistic backfill for accounts that predate the email column, and a safety
      // net if a user.updated webhook is ever missed. Deliberately here rather than in
      // bootstrapAuthenticatedUser, which runs on every authenticated request — this
      // path already pays for the currentUser() call. Best-effort; never blocks render.
      //
      // The name and avatar are backfilled the same way, so `getDisplayProfile()` can answer
      // from the mirror next time instead of calling Clerk again.
      void import("@/lib/user-settings")
        .then(async ({ setUserEmail, setUserIdentity }) => {
          if (email) await setUserEmail(user.id, email);
          await setUserIdentity(user.id, {
            firstName: user.firstName,
            lastName: user.lastName,
            imageUrl: user.imageUrl,
          });
        })
        .catch(() => {});
      return {
        id: user.id,
        name: user.fullName || user.firstName || "You",
        email,
        imageUrl: user.imageUrl,
      };
    }
  } catch {
    // ignore
  }

  return null;
}
