import { AdminLoading, BackLinkSkeleton } from "@/components/admin/loading-shells";

/** Mirrors the contact-detail page: back link, header, then Record / Contact / Interactions. */
export default function AdminContactDetailLoading() {
  return (
    <AdminLoading
      title="Contact"
      above={<BackLinkSkeleton />}
      blocks={[
        { panel: true, title: "Record", height: "h-48" },
        { panel: true, title: "Contact details", height: "h-64" },
        { panel: true, title: "Interactions", height: "h-40" },
      ]}
    />
  );
}
