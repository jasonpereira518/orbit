import { AdminPanel } from "@/components/admin/primitives";
import { SurfaceToggles } from "@/components/admin/surface-toggles";
import { getHiddenSurfaceKeys } from "@/lib/surface-visibility";
import { surfacesOfKind } from "@/lib/surfaces";
import { ProductHeader } from "../product-header";

export const metadata = { title: "Admin · Product · Settings" };

/** The sections of the user-facing Settings page, each of which can be hidden. */
export default async function AdminProductSettingsPage() {
  const hidden = [...(await getHiddenSurfaceKeys())];

  return (
    <>
      <ProductHeader />
      <AdminPanel title="Settings sections">
        <SurfaceToggles surfaces={surfacesOfKind("settings")} hidden={hidden} />
      </AdminPanel>
    </>
  );
}
