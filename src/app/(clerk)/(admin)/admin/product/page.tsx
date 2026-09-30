import { AdminPageHeader, AdminPanel } from "@/components/admin/primitives";
import {
  PreviewUnreleasedButton,
  SurfaceToggles,
  UnhideAllButton,
  ViewAsUserButton,
} from "@/components/admin/surface-toggles";
import { requireAdminPage } from "@/lib/admin";
import { PageStatusList } from "@/components/admin/page-status-list";
import { ProductTabs } from "@/components/admin/product-tabs";
import { ConstellationFilterPanel } from "@/components/admin/constellation-filter-panel";
import { getConstellationConfig } from "@/lib/constellation-config";
import {
  getComingSoonKeys,
  getHiddenSurfaceKeys,
  getNavOrder,
  isPreviewingUnreleased,
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
  const [hidden, comingSoon, navOrder, viewingAsUser, previewingUnreleased, constellation] =
    await Promise.all([
      getHiddenSurfaceKeys(),
      getComingSoonKeys(),
      getNavOrder(),
      isViewingAsUser(adminUserId),
      isPreviewingUnreleased(adminUserId),
      getConstellationConfig(),
    ]);

  const hiddenKeys = [...hidden];
  const pageSurfaces = surfacesOfKind("page");
  const pageKeys = new Set(pageSurfaces.map((p) => p.key));
  const hiddenIn = (kinds: Array<Parameters<typeof surfacesOfKind>[0]>) =>
    kinds.flatMap((k) => surfacesOfKind(k)).filter((s) => hidden.has(s.key)).length;
  // A hidden page wins over coming-soon, so it is counted once, as hidden.
  const soonCount = [...comingSoon].filter((k) => pageKeys.has(k) && !hidden.has(k)).length;
  const count = hidden.size;

  const summary = [
    count > 0 && `${count} hidden`,
    soonCount > 0 && `${soonCount} coming soon`,
  ].filter(Boolean);

  return (
    <>
      <AdminPageHeader
        title="Product"
        subtitle={
          summary.length === 0
            ? "Every surface is live for every user."
            : `${summary.join(" · ")} for all users. You still see hidden surfaces — use the preview below to check what they see.`
        }
        action={<UnhideAllButton hiddenKeys={hiddenKeys} />}
      />

      <div className="mb-6 grid gap-3 md:grid-cols-2">
        <div className="flex flex-col justify-between gap-3 rounded-xl border border-border/70 bg-card p-4">
          <div>
            <h2 className="text-sm font-medium">See what users see</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {viewingAsUser
                ? "You are browsing Orbit as a general user. Hidden surfaces are gone for you too until you stop."
                : "Opens the app with every change below applied to you as well. Lasts until you stop or close the browser; nobody else is affected."}
            </p>
          </div>
          <div>
            <ViewAsUserButton active={viewingAsUser} />
          </div>
        </div>
        <div className="flex flex-col justify-between gap-3 rounded-xl border border-border/70 bg-card p-4">
          <div>
            <h2 className="text-sm font-medium">Build on unreleased pages</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {previewingUnreleased
                ? "You are seeing the real pages behind every coming-soon screen. Everyone else still gets coming-soon until you stop."
                : "Coming-soon pages are closed to admins too. Turn this on to open the real page instead. Lasts until you stop or close the browser; nobody else is affected."}
            </p>
          </div>
          <div>
            <PreviewUnreleasedButton active={previewingUnreleased} />
          </div>
        </div>
      </div>

      <ProductTabs
        tabs={[
          {
            id: "pages",
            label: "Pages & sidebar",
            flagged: hiddenIn(["page"]),
            content: (
              <AdminPanel title="Pages, in sidebar order">
                <PageStatusList
                  pages={pageSurfaces}
                  order={navOrder}
                  hidden={hiddenKeys}
                  comingSoon={[...comingSoon]}
                />
              </AdminPanel>
            ),
          },
          {
            id: "dashboard",
            label: "Dashboard & widgets",
            flagged: hiddenIn(["dashboard", "widget"]),
            content: (
              <div className="space-y-6">
                <AdminPanel title="Dashboard cards">
                  <SurfaceToggles surfaces={surfacesOfKind("dashboard")} hidden={hiddenKeys} />
                </AdminPanel>
                <AdminPanel title="Widgets">
                  <SurfaceToggles surfaces={surfacesOfKind("widget")} hidden={hiddenKeys} />
                </AdminPanel>
              </div>
            ),
          },
          {
            id: "settings",
            label: "Settings sections",
            flagged: hiddenIn(["settings"]),
            content: (
              <AdminPanel title="Settings sections">
                <SurfaceToggles surfaces={surfacesOfKind("settings")} hidden={hiddenKeys} />
              </AdminPanel>
            ),
          },
          {
            id: "constellation",
            label: "Constellation",
            content: (
              <AdminPanel title="Constellation filter">
                <ConstellationFilterPanel config={constellation} />
              </AdminPanel>
            ),
          },
        ]}
      />
    </>
  );
}
