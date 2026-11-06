import { AccessTabs } from "@/components/admin/admin-tabs";
import { AdminLoading } from "@/components/admin/loading-shells";

/** Mirrors /admin/access/invites: the invite form, then the invitation list. */
export default function AdminInvitesLoading() {
  return (
    <AdminLoading
      title="Access"
      tabs={<AccessTabs />}
      blocks={[
        { panel: true, title: "Invite someone", height: "h-20" },
        { panel: true, title: "Invitations", height: "h-40" },
      ]}
    />
  );
}
