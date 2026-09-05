import { AdminPageHeader, AdminPanel } from "@/components/admin/primitives";
import {
  SurfaceToggles,
  ViewAsUserButton,
} from "@/components/admin/surface-toggles";
import { requireAdminPage } from "@/lib/admin";
import { ConstellationFilterPanel } from "@/components/admin/constellation-filter-panel";
import { getConstellationConfig } from "@/lib/constellation-config";
import {
  getHiddenSurfaceKeys,
  isViewingAsUser,
} from "@/lib/surface-visibility";
import { surfacesOfKind } from "@/lib/surfaces";

export const metadata = { title: "Admin · Product" };

/**
 * What the product shows everybody.
 *
 * The rest of the console answers questions about accounts; this screen is the one place
 * that changes Orbit itself. Nothing here deletes anything — a hidden surface stops being
 * rendered and stops being reachable, and the rows behind it are untouched, so unhiding
 * restores it exactly.
 *
 * Operators are exempt from their own toggles, so that a half-finished page can be checked
 * before it is released. That exemption is also the trap this screen has to defend against:
 * the person who can undo a forgotten toggle is the only person who cannot see its effect.
 * Hence the count in the header, the "Hidden" tags in the product's own sidebar, and the
 * view-as-a-user button that drops the exemption on demand.
 */
export default async function AdminProductPage() {
  const adminUserId = await requireAdminPage();
  const [hidden, viewingAsUser, constellation] = await Promise.all([
    getHiddenSurfaceKeys(),
    isViewingAsUser(adminUserId),
    getConstellationConfig(),
  ]);

  const hiddenKeys = [...hidden];
  const count = hidden.size;

  return (
    <>
      <AdminPageHeader
        title="Product"
        subtitle={
          count === 0 ? (
            "Every surface is visible to every user."
          ) : (
            <>
              <span className="tabular-nums">{count}</span> surface
              {count === 1 ? "" : "s"} hidden from all users. You still see them —
              use view-as-a-user to check what they don&apos;t.
            </>
          )
        }
      />

      <div className="space-y-6">
        <AdminPanel
          title="Preview"
          action={<ViewAsUserButton active={viewingAsUser} />}
        >
          <p className="text-xs text-muted-foreground">
            {viewingAsUser
              ? "You are currently browsing Orbit as a general user. Hidden surfaces are gone for you too until you stop."
              : "Opens the app with every toggle below applied to you as well, so you see exactly what a general user sees. Lasts until you stop or close the browser, and changes nothing for anyone else."}
          </p>
        </AdminPanel>

        <AdminPanel title="Constellation">
          <ConstellationFilterPanel config={constellation} />
        </AdminPanel>

        <AdminPanel title="Pages">
          <SurfaceToggles surfaces={surfacesOfKind("page")} hidden={hiddenKeys} />
        </AdminPanel>

        <AdminPanel title="Dashboard cards">
          <SurfaceToggles
            surfaces={surfacesOfKind("dashboard")}
            hidden={hiddenKeys}
          />
        </AdminPanel>

        <AdminPanel title="Widgets">
          <SurfaceToggles surfaces={surfacesOfKind("widget")} hidden={hiddenKeys} />
        </AdminPanel>

        <AdminPanel title="Settings sections">
          <SurfaceToggles
            surfaces={surfacesOfKind("settings")}
            hidden={hiddenKeys}
          />
        </AdminPanel>
      </div>
    </>
  );
}
