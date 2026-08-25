import { cache } from "react";
import { notFound } from "next/navigation";
import { isClerkConfigured, requireUserId } from "@/lib/auth";

/**
 * Thrown by admin server actions when the caller is not an operator.
 *
 * The message is deliberately "Not found" and never mentions admin: a 403 confirms the
 * surface exists and that you found its path, which is pure information leak on a console
 * that has exactly one legitimate user and no access-request flow.
 */
export class AdminForbiddenError extends Error {
  constructor() {
    super("Not found");
    this.name = "AdminForbiddenError";
  }
}

/**
 * Read at call time rather than module scope so the value stays overridable per environment
 * and never gets inlined at build time.
 *
 * Must NOT be a `NEXT_PUBLIC_*` variable — that would ship the allowlist to every browser.
 */
function adminIds(): Set<string> {
  return new Set(
    (process.env.ADMIN_USER_IDS ?? "")
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

/**
 * Gated on `isClerkConfigured()` rather than `!isDemoMode()` on purpose.
 *
 * `isDemoMode()` is only true when NODE_ENV === "development", so it would let a production
 * build run locally without Clerk keys slip through. "Admin requires a real, Clerk-verified
 * identity" is the strictly stronger rule, and it is one condition instead of two.
 */
export function adminAccessEnabled(): boolean {
  return isClerkConfigured() && adminIds().size > 0;
}

export function isAdminUser(userId: string | null | undefined): boolean {
  if (!adminAccessEnabled()) return false;
  // Belt and braces: in demo mode every caller resolves to this literal, so even a
  // mistaken ADMIN_USER_IDS=demo-user must not grant access. `adminAccessEnabled()`
  // already covers it; this survives that check being loosened later.
  if (!userId || userId === "demo-user") return false;
  return adminIds().has(userId);
}

/**
 * The gate for server actions and route handlers.
 *
 * Every export in `src/actions/admin.ts` must call this. A layout check is not sufficient:
 * layouts do not re-run for Server Action POSTs, and actions are reachable by direct POST
 * rather than only through Orbit's own UI — the same lesson `src/lib/plan-guards.ts`
 * documents for the paywall.
 */
export const requireAdminUserId = cache(async (): Promise<string> => {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch {
    throw new AdminForbiddenError();
  }
  if (!isAdminUser(userId)) throw new AdminForbiddenError();
  return userId;
});

/** The gate for pages and layouts: renders a real 404 rather than an error boundary. */
export async function requireAdminPage(): Promise<string> {
  try {
    return await requireAdminUserId();
  } catch {
    notFound();
  }
}
