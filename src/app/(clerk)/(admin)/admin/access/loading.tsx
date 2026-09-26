import { AdminLoading } from "@/components/admin/loading-shells";

/** Mirrors /admin/access: the switch, the invite form, then the invitation list. */
export default function AdminAccessLoading() {
  return (
    <AdminLoading
      title="Access"
      subtitle="Loading…"
      blocks={[
        { panel: true, title: "Stealth", height: "h-24" },
        { panel: true, title: "Invite someone", height: "h-20" },
        { panel: true, title: "Invitations", height: "h-40" },
      ]}
    />
  );
}
