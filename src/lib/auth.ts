import { cache } from "react";
import { auth, currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { needsOnboarding } from "@/lib/onboarding";
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

export function isClerkConfigured() {
  return Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
}

/** Local dev without Clerk keys — shared demo-user data. */
export function isDemoMode() {
  return !isClerkConfigured() && process.env.NODE_ENV === "development";
}

/** Idempotent per-request bootstrap so layouts + pages don't repeat DB work. */
export const bootstrapAuthenticatedUser = cache(async (userId: string) => {
  return ensureUserSettings(userId);
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
      if (email) {
        void import("@/lib/user-settings")
          .then(({ setUserEmail }) => setUserEmail(user.id, email))
          .catch(() => {});
      }
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
