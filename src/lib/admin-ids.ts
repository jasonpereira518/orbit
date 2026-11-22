/**
 * Who is an operator, with no auth import: `admin.ts` pulls in Clerk (`@/lib/auth`), and modules
 * that only need the id check (surface visibility, the deep-read gate) would otherwise close an
 * import cycle through auth → demo data → contact writes → closeness. `admin.ts` re-exports all
 * of this unchanged.
 */
import { isClerkConfigured, isLocalhost } from "@/lib/demo-account";

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

/** The configured operator ids, for callers that filter by them (traffic analytics). */
export function adminUserIds(): string[] {
  return [...adminIds()];
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
  // Every local dev server reaches the console — signed in with real Clerk keys or as the
  // shared demo-user — without an ADMIN_USER_IDS entry (the dev Clerk instance's ids never
  // match prod's). `isLocalhost()` is NODE_ENV === "development", which no deployed build
  // (production or preview) ever runs with, so this can't leak past `next dev`.
  if (isLocalhost()) return true;
  if (!adminAccessEnabled()) return false;
  // Belt and braces: in demo mode every caller resolves to this literal, so even a
  // mistaken ADMIN_USER_IDS=demo-user must not grant access. `adminAccessEnabled()`
  // already covers it; this survives that check being loosened later.
  if (!userId || userId === "demo-user") return false;
  return adminIds().has(userId);
}
