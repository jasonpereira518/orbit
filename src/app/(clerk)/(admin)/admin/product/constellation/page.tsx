import { AdminPanel } from "@/components/admin/primitives";
import { ConstellationFilterPanel } from "@/components/admin/constellation-filter-panel";
import { getConstellationConfig } from "@/lib/constellation-config";
import { ProductHeader } from "../product-header";

export const metadata = { title: "Admin · Product · Constellation" };

/** Which contacts the constellation draws, for everyone. */
export default async function AdminProductConstellationPage() {
  const config = await getConstellationConfig();

  return (
    <>
      <ProductHeader />
      <AdminPanel title="Constellation filter">
        <ConstellationFilterPanel config={config} />
      </AdminPanel>
    </>
  );
}
