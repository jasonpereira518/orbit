import { AdminShell } from "@/components/admin/admin-shell";
import { requireAdminPage } from "@/lib/admin";
import { getCurrentUserProfile } from "@/lib/auth";
import { getHiddenSurfaceKeys } from "@/lib/surface-visibility";

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
  await requireAdminPage();
  const [profile, hidden] = await Promise.all([
    getCurrentUserProfile(),
    getHiddenSurfaceKeys(),
  ]);

  return (
    <AdminShell adminEmail={profile?.email} hiddenSurfaceCount={hidden.size}>
      {children}
    </AdminShell>
  );
}
