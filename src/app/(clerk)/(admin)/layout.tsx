import { AdminShell } from "@/components/admin/admin-shell";
import { requireAdminPage } from "@/lib/admin";
import { getHiddenSurfaceKeys } from "@/lib/surface-visibility";
import { unresolvedFeedbackCount } from "@/lib/admin-feedback";
import { getDb } from "@/db";
import { userSettings } from "@/db/schema";
import { eq } from "drizzle-orm";
import "./admin-console.css";

/**
 * Its own route group, outside `(app)` — so it inherits neither the product shell nor the
 * onboarding gate. See `AdminShell` for why reusing `AppShell` would be wrong.
 *
 * `requireAdminPage()` renders a real 404 for anyone else: a 403 or a redirect both
 * confirm the route exists, and there is no access-request flow to justify saying so.
 *
 * This gate is necessary but NOT sufficient — layouts do not re-run for Server Action
 * POSTs, so every action in `src/actions/admin.ts` re-asserts it independently.
 */
export const dynamic = "force-dynamic";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const adminUserId = await requireAdminPage();
  const db = await getDb();
  // The email comes from the admin's own `user_settings` mirror, which this layout reads
  // anyway for YC mode. `getCurrentUserProfile()` here cost a Clerk API call plus two
  // backfill UPDATEs on every admin navigation; the product shell still does that backfill.
  const [hidden, settings, unresolvedFeedback] = await Promise.all([
    getHiddenSurfaceKeys(),
    db.query.userSettings.findFirst({ where: eq(userSettings.userId, adminUserId) }),
    unresolvedFeedbackCount(),
  ]);

  return (
    <AdminShell
      adminEmail={settings?.email}
      hiddenSurfaceCount={hidden.size}
      unresolvedFeedbackCount={unresolvedFeedback}
      ycMode={settings?.ycModeEnabled ?? false}
    >
      {children}
    </AdminShell>
  );
}
