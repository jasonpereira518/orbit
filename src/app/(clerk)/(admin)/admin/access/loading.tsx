import { AccessTabs } from "@/components/admin/admin-tabs";
import { AdminLoading } from "@/components/admin/loading-shells";

/** Mirrors /admin/access (Waitlist): tiles, the two switches, the two summaries, the roster. */
export default function AdminWaitlistLoading() {
  return (
    <AdminLoading
      title="Access"
      tabs={<AccessTabs />}
      blocks={[
        { tiles: 5 },
        { panel: true, title: "Product demo", height: "h-10" },
        { panel: true, title: "Add from event", height: "h-10" },
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
