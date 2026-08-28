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
import { bootstrapAuthenticatedUser, isClerkConfigured } from "@/lib/auth";

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
  const devId = devUserId(req);
  if (devId) {
    await bootstrapAuthenticatedUser(devId);
    return devId;
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

  await bootstrapAuthenticatedUser(userId);
  return userId;
}
