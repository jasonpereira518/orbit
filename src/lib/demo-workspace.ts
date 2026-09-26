import { cache } from "react";
import { ensureUserSettings } from "@/lib/user-settings";

/**
 * The demo workspace: a real, deployed account that exists to record product demos from.
 *
 * Distinct from `demo-account.ts`. A demo *account* (localhost, or `DEMO_ACCOUNT_USER_ID`)
 * has its plan gates lifted and says so on the plan card; `env.ts` forbids the showcase id in
 * production. The demo *workspace* runs in production on an ordinary comped Orbit plan (see
 * `scripts/seed-demo-workspace.ts`), so nothing on screen reads as a demo, and adds exactly
 * one behaviour: its integrations read as connected (`demo-workspace-connections.ts`)
 * without any OAuth token ever being stored, so no sync or cron calls a provider for it.
 *
 * Keyed by email rather than a Clerk id so the same address works on every Clerk instance
 * and database. The address is the one Clerk verified and mirrored to
 * `user_settings.email`, so it cannot be claimed by typing it somewhere. The list is code,
 * not config: widening it takes a reviewed commit, never an environment variable.
 */
export const DEMO_WORKSPACE_EMAILS: readonly string[] = ["jasonnp510@gmail.com"];

export function isDemoWorkspaceEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return DEMO_WORKSPACE_EMAILS.includes(email.trim().toLowerCase());
}

/**
 * The account's address when it is the demo workspace, else null. Free on a request:
 * `ensureUserSettings` is the row `bootstrapAuthenticatedUser` already loaded, memoised per
 * request.
 */
export const demoWorkspaceEmail = cache(async (userId: string): Promise<string | null> => {
  const settings = await ensureUserSettings(userId);
  return isDemoWorkspaceEmail(settings.email) ? settings.email!.trim().toLowerCase() : null;
});

export async function isDemoWorkspace(userId: string): Promise<boolean> {
  return (await demoWorkspaceEmail(userId)) !== null;
}
