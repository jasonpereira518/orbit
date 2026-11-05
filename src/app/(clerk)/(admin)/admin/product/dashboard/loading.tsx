import { ProductSectionTabs } from "@/components/admin/admin-tabs";
import { AdminLoading } from "@/components/admin/loading-shells";

export default function Loading() {
  return (
    <AdminLoading
      title="Product"
      subtitle="Loading surfaces…"
      tabs={<ProductSectionTabs />}
      blocks={[
        { panel: true, title: "Dashboard cards", height: "h-40" },
        { panel: true, title: "Widgets", height: "h-40" },
        { panel: true, title: "Features", height: "h-40" },
      ]}
    />
  );
}
