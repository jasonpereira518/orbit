import { Suspense } from "react";
import { AdminShell } from "@/components/admin/admin-shell";
import { requireAdminPage } from "@/lib/admin";
import { getCurrentUserProfile } from "@/lib/auth";

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
  // ONLY the gate blocks. The operator's email is chrome — it used to be awaited here,
  // which put a second Clerk round trip (`currentUser()`, serialized after the gate's
  // own `auth()`) on the critical path of every single navigation inside the console,
  // to print one address in the header. It streams in now instead.
  await requireAdminPage();

  return (
    <AdminShell
      adminEmail={
        <Suspense fallback={null}>
          <AdminEmail />
        </Suspense>
      }
    >
      {children}
    </AdminShell>
  );
}

async function AdminEmail() {
  const profile = await getCurrentUserProfile();
  if (!profile?.email) return null;
  return (
    <span className="hidden max-w-[16rem] truncate sm:inline">{profile.email}</span>
  );
}
