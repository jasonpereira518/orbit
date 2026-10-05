/**
 * Authentication for the extension API.
 *
 * THIS IS THE ONLY FILE THAT KNOWS HOW THE EXTENSION AUTHENTICATES. Route
 * handlers call `requireExtensionUserId(req)` and never import from `@clerk/*`
 * or read headers themselves. Swapping the scheme (e.g. to Orbit-issued bearer
 * tokens, if Clerk's syncHost proves awkward against MV3 service-worker
 * lifetimes) should touch this file and `src/proxy.ts`, and nothing else.
 *
 * Today: the extension ships Clerk's session via `@clerk/chrome-extension`,
 * `clerkMiddleware` in src/proxy.ts populates the auth state (the route is
 * listed as "public" there only so an unauthenticated call gets a JSON 401
 * instead of a 302 to an HTML sign-in page), and `auth()` resolves it here.
 */

import { timingSafeEqual } from "node:crypto";
import { auth } from "@clerk/nextjs/server";
import {
  bootstrapAuthenticatedUser,
  isClerkConfigured,
  type AuthenticatedUser,
} from "@/lib/auth";
import { isHeldByStealth } from "@/lib/site-access";

export class ExtensionUnauthorizedError extends Error {
  constructor(message = "Not signed in to Orbit") {
    super(message);
    this.name = "ExtensionUnauthorizedError";
  }
}

export class ExtensionRateLimitError extends Error {
  retryAfterSeconds: number;
  constructor(retryAfterSeconds: number, message = "Too many requests") {
    super(message);
    this.name = "ExtensionRateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Header carrying the local-dev shared secret. */
export const DEV_SECRET_HEADER = "x-orbit-dev-secret";

function safeEquals(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Local development has no Clerk keys (see `isDemoMode`), and src/proxy.ts falls
 * back to a non-Clerk middleware, so there is no session for the extension to
 * ride. Rather than leave the write API open in dev — which is what mirroring
 * `requireUserId`'s demo-user shortcut would do — require an explicit shared
 * secret that only exists when the developer sets it.
 */
function devUserId(req: Request): string | null {
  if (process.env.NODE_ENV !== "development") return null;
  const expected = process.env.EXTENSION_DEV_SECRET?.trim();
  if (!expected) return null;
  const provided = req.headers.get(DEV_SECRET_HEADER)?.trim();
  if (!provided || !safeEquals(provided, expected)) return null;
  return process.env.EXTENSION_DEV_USER_ID?.trim() || "demo-user";
}

export async function requireExtensionUserId(req: Request): Promise<string> {
  return (await requireExtensionUser(req)).userId;
}

/**
 * `requireExtensionUserId`, also handing back the `user_settings` row the bootstrap read.
 *
 * Route handlers are where `cache()` is a pass-through, so a handler that then calls
 * `ensureUserSettings` / `getEntitlements` / `userHasApolloKey(userId)` reads that row again.
 * `extensionRoute` puts it on the handler's context as `settings` for that reason.
 */
export async function requireExtensionUser(
  req: Request
): Promise<{ userId: string; settings: AuthenticatedUser["settings"] }> {
  const devId = devUserId(req);
  if (devId) {
    return { userId: devId, settings: await bootstrapAuthenticatedUser(devId) };
  }

  if (!isClerkConfigured()) {
    throw new ExtensionUnauthorizedError(
      "Orbit is not configured for sign-in on this server."
    );
  }

  let userId: string | null = null;
  try {
    ({ userId } = await auth());
  } catch {
    // Middleware missing or a Clerk runtime issue — treat as unauthenticated.
    throw new ExtensionUnauthorizedError();
  }

  if (!userId) throw new ExtensionUnauthorizedError();

  // The same two account gates `requireUserId` applies. Without them a suspended account, or
  // one stealth is holding, kept full read/write access through the extension.
  const settings = await bootstrapAuthenticatedUser(userId);
  if (settings.suspendedAt) {
    throw new ExtensionUnauthorizedError("This Orbit account is suspended.");
  }
  if (await isHeldByStealth(userId, settings)) {
    throw new ExtensionUnauthorizedError("This account is waiting for an invitation.");
  }
  return { userId, settings };
}
