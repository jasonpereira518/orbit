import { ProductSectionTabs } from "@/components/admin/admin-tabs";
import { AdminLoading } from "@/components/admin/loading-shells";

export default function AdminProductPhotosLoading() {
  return (
    <AdminLoading
      title="Product"
      subtitle="Reading the pool…"
      tabs={<ProductSectionTabs />}
      blocks={[{ toolbar: true }, { panel: true, height: "h-64" }]}
    />
  );
}
