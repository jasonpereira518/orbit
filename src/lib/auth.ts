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

export function isUnauthorizedError(err: unknown): err is UnauthorizedError {
  return err instanceof UnauthorizedError;
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

/** Redirect signed-in users away from /sign-in and /sign-up. */
export async function redirectIfAuthenticated() {
  if (!isClerkConfigured()) return;

  const { userId } = await auth();
  if (!userId) return;

  redirect(await getPostAuthRedirectPath(userId));
}

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

  try {
    const { userId } = await auth();
    if (userId) {
      await bootstrapAuthenticatedUser(userId);
      return userId;
    }
  } catch {
    // Middleware missing or Clerk runtime issue
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
      return {
        id: user.id,
        name: user.fullName || user.firstName || "You",
        email: user.primaryEmailAddress?.emailAddress ?? "",
        imageUrl: user.imageUrl,
      };
    }
  } catch {
    // ignore
  }

  return null;
}
