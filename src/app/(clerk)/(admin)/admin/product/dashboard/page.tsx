import { AdminPanel } from "@/components/admin/primitives";
import { SurfaceToggles } from "@/components/admin/surface-toggles";
import { getHiddenSurfaceKeys } from "@/lib/surface-visibility";
import { surfacesOfKind } from "@/lib/surfaces";
import { ProductHeader } from "../product-header";

export const metadata = { title: "Admin · Product · Dashboard" };

/** Dashboard cards, widgets and features: everything smaller than a page that can be hidden. */
export default async function AdminProductDashboardPage() {
  const hidden = [...(await getHiddenSurfaceKeys())];

  return (
    <>
      <ProductHeader />
      <div className="space-y-6">
        <AdminPanel title="Dashboard cards">
          <SurfaceToggles surfaces={surfacesOfKind("dashboard")} hidden={hidden} />
        </AdminPanel>
        <AdminPanel title="Widgets">
          <SurfaceToggles surfaces={surfacesOfKind("widget")} hidden={hidden} />
        </AdminPanel>
        <AdminPanel title="Features">
          <SurfaceToggles surfaces={surfacesOfKind("feature")} hidden={hidden} />
        </AdminPanel>
      </div>
    </>
  );
}
