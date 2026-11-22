import { cache } from "react";
import { notFound } from "next/navigation";
import { requireUserId } from "@/lib/auth";

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

export { adminAccessEnabled, adminUserIds, isAdminUser } from "@/lib/admin-ids";
import { isAdminUser } from "@/lib/admin-ids";

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
