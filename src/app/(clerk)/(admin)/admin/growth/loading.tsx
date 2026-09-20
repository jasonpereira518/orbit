import { AdminLoading } from "@/components/admin/loading-shells";

/** Mirrors the page's layout block for block, so the swap does not jump. */
export default function AdminGrowthLoading() {
  return (
    <AdminLoading
      title="Growth"
      subtitle="Bucketing history…"
      blocks={[
        { range: true },
        { tiles: 5 },
        { panel: true, title: "Accounts over time", height: "h-80" },
        {
          pair: [
            { title: "Opened Orbit", height: "h-80" },
            { title: "Did something", height: "h-80" },
          ],
        },
        { panel: true, title: "Retention by signup month", height: "h-72" },
        { panel: true, title: "Actions per active account", height: "h-72" },
      ]}
    />
  );
}
