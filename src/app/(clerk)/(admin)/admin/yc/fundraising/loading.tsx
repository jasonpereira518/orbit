import { AdminLoading } from "@/components/admin/loading-shells";

export default function AdminFundraisingLoading() {
  return (
    <AdminLoading
      title="Funding"
      blocks={[
        { tiles: 4 },
        { panel: true, title: "How the total is built", height: "h-52" },
        { panel: true, title: "Open a round", height: "h-10" },
        { panel: true, title: "Non-dilutive", height: "h-36" },
        { panel: true, title: "Reconciliation", height: "h-28" },
      ]}
    />
  );
}
