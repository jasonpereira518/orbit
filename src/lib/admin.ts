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
 * The one deliberate hole: the console, reachable as `demo-user`, for local development.
 *
 * The console cannot otherwise be opened without Clerk keys, which makes it the one part
 * of Orbit nobody can look at while building it — you cannot check a layout, a hover
 * state, or a panel's empty case against a screen that 404s.
 *
 * THREE CONDITIONS, ALL REQUIRED, and each closes a different door:
 *
 *   ADMIN_DEMO_ACCESS === "1"   Opt-in. Never a default, so this cannot be arrived at by
 *                               forgetting something — it has to be typed on purpose.
 *   NODE_ENV === "development"  Never a built artifact. `next build` sets "production",
 *                               so a production bundle ignores the flag entirely even if
 *                               the variable is set in its environment.
 *   !isClerkConfigured()        Only where there is no real identity to check against.
 *                               With Clerk keys present the `ADMIN_USER_IDS` allowlist
 *                               governs and this returns false, so the flag can never
 *                               widen access on a real deployment.
 *
 * Production is additionally unreachable from here for a structural reason: `src/proxy.ts`
 * answers 503 to every request when Clerk is unconfigured and NODE_ENV is "production", so
 * "demo mode in production" is not a state the app can be in.
 *
 * WHAT IT DOES NOT DO: grant anything to a real account. It admits exactly the literal
 * `demo-user`, which only exists when there is no authentication at all and whose data is
 * the local PGlite database.
 */
export function demoAdminEnabled(): boolean {
  return (
    process.env.ADMIN_DEMO_ACCESS === "1" &&
    process.env.NODE_ENV === "development" &&
    !isClerkConfigured()
  );
}

/**
 * Gated on `isClerkConfigured()` rather than `!isDemoMode()` on purpose.
 *
 * `isDemoMode()` is only true when NODE_ENV === "development", so it would let a production
 * build run locally without Clerk keys slip through. "Admin requires a real, Clerk-verified
 * identity" is the strictly stronger rule, and it is one condition instead of two.
 *
 * `demoAdminEnabled()` is the single, explicitly opt-in exception — see above for why it
 * cannot be reached by accident or in a built artifact.
 */
export function adminAccessEnabled(): boolean {
  if (demoAdminEnabled()) return true;
  return isClerkConfigured() && adminIds().size > 0;
}

export function isAdminUser(userId: string | null | undefined): boolean {
  if (!adminAccessEnabled()) return false;
  // In demo mode every caller resolves to this literal. It is admitted ONLY through the
  // explicit development flag — never because somebody put `demo-user` in
  // ADMIN_USER_IDS, which stays meaningless.
  if (userId === "demo-user") return demoAdminEnabled();
  if (!userId) return false;
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
    // Unauthenticated. Nothing to record — there is no identity to record it against, and
    // logging every signed-out probe would bury the case that matters below.
    throw new AdminForbiddenError();
  }
  if (!isAdminUser(userId)) {
    // A SIGNED-IN USER WHO IS NOT AN OPERATOR. The response stays a 404 — a 403 would
    // confirm both that the surface exists and that they found its path — but the attempt
    // is now on the record. That combination was the gap: refusing invisibly meant nobody
    // could ever answer "has anyone tried?".
    //
    // Awaited and swallowed. It fires only on refusal, so steady-state cost is zero, and a
    // failure here must not change what the caller sees.
    await recordAccessDenial(userId);
    throw new AdminForbiddenError();
  }
  return userId;
});

/**
 * Records a refused attempt, without altering the refusal.
 *
 * Imported lazily so `admin.ts` — which every admin surface pulls in — does not gain a
 * database import on the path where the gate *passes*.
 */
async function recordAccessDenial(userId: string): Promise<void> {
  try {
    const { getDb } = await import("@/db");
    const { adminAuditLog } = await import("@/db/schema");
    const db = await getDb();
    await db.insert(adminAuditLog).values({
      adminUserId: userId,
      action: "access.denied",
      targetUserId: null,
      detail: {},
    });
  } catch {
    // Never let the audit write change the answer the gate gives.
  }
}

/** The gate for pages and layouts: renders a real 404 rather than an error boundary. */
export async function requireAdminPage(): Promise<string> {
  try {
    return await requireAdminUserId();
  } catch {
    notFound();
  }
}
