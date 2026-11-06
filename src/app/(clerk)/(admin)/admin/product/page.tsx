import { AdminPanel } from "@/components/admin/primitives";
import { PreviewUnreleasedButton, ViewAsUserButton } from "@/components/admin/surface-toggles";
import { requireAdminPage } from "@/lib/admin";
import { PageStatusList } from "@/components/admin/page-status-list";
import {
  getComingSoonKeys,
  getHiddenSurfaceKeys,
  getNavOrder,
  getTierRules,
  isPreviewingUnreleased,
  isViewingAsUser,
} from "@/lib/surface-visibility";
import { surfacesOfKind } from "@/lib/surfaces";
import { ProductHeader } from "./product-header";

export const metadata = { title: "Admin · Product" };

/**
 * What the product shows everybody — the Pages tab, and the section's front door.
 *
 * The rest of the console answers questions about accounts; this section is the one place
 * that changes Orbit itself. Nothing here deletes anything — a hidden surface stops being
 * rendered and stops being reachable, and the rows behind it are untouched, so unhiding
 * restores it exactly.
 *
 * Operators are exempt from their own toggles, so that a half-finished page can be checked
 * before it is released. That exemption is also the trap this section has to defend against:
 * the person who can undo a forgotten toggle is the only person who cannot see its effect.
 * Hence the count in the header and on each tab, the "Hidden" tags in the product's own
 * sidebar, and the view-as-a-user button here that drops the exemption on demand.
 */
export default async function AdminProductPage() {
  const adminUserId = await requireAdminPage();
  const [hidden, comingSoon, navOrder, tierRules, viewingAsUser, previewingUnreleased] =
    await Promise.all([
      getHiddenSurfaceKeys(),
      getComingSoonKeys(),
      getNavOrder(),
      getTierRules(),
      isViewingAsUser(adminUserId),
      isPreviewingUnreleased(adminUserId),
    ]);

  return (
    <>
      <ProductHeader />

      <div className="mb-6 grid gap-3 md:grid-cols-2">
        <div className="flex flex-col justify-between gap-3 rounded-xl border border-border/70 bg-card p-4">
          <div>
            <h2 className="text-sm font-medium">See what users see</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {viewingAsUser
                ? "You are browsing Orbit as a general user. Hidden surfaces are gone for you too until you stop."
                : "Opens the app with every change in this section applied to you as well. Lasts until you stop or close the browser; nobody else is affected."}
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

      <AdminPanel title="Pages, in sidebar order">
        <PageStatusList
          pages={surfacesOfKind("page")}
          order={navOrder}
          hidden={[...hidden]}
          comingSoon={[...comingSoon]}
          tierRules={Object.fromEntries(tierRules)}
        />
      </AdminPanel>
    </>
  );
}
