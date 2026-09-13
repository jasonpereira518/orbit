import { AdminPageHeader, AdminPanel } from "@/components/admin/primitives";
import { Skeleton } from "@/components/ui/skeleton";

/** Mirrors the contact-detail page: back link + header + Record/Contact/Interactions panels — no account sidebar. */
export default function AdminContactDetailLoading() {
  return (
    <>
      <Skeleton className="mb-3 h-3 w-32" />
      <AdminPageHeader title="Loading contact…" />
      <div className="space-y-6">
        <AdminPanel title="Record">
          <Skeleton className="h-48 w-full" />
        </AdminPanel>
        <AdminPanel title="Contact details">
          <Skeleton className="h-64 w-full" />
        </AdminPanel>
        <AdminPanel title="Interactions">
          <Skeleton className="h-40 w-full" />
        </AdminPanel>
      </div>
    </>
  );
}
