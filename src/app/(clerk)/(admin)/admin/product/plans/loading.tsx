import { ProductSectionTabs } from "@/components/admin/admin-tabs";
import { AdminLoading } from "@/components/admin/loading-shells";

export default function Loading() {
  return (
    <AdminLoading
      title="Product"
      subtitle="Loading plan rules…"
      tabs={<ProductSectionTabs />}
      blocks={[
        { panel: true, title: "Features", height: "h-96" },
        { panel: true, title: "Limits", height: "h-48" },
      ]}
    />
  );
}
