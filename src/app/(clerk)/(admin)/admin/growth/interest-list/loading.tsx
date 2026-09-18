import { AdminLoading } from "@/components/admin/loading-shells";

export default function AdminInterestListLoading() {
  return (
    <AdminLoading
      title="Interest list"
      blocks={[
        { tiles: 4 },
        {
          pair: [
            { title: "Signups by week", height: "h-16" },
            { title: "Where they come from", height: "h-16" },
          ],
        },
        { panel: true, height: "h-64" },
      ]}
    />
  );
}
