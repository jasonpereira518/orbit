import { PageHeader } from "@/components/layout/page-header";

/**
 * Static events header, rendered by BOTH page.tsx and loading.tsx so client navigation shows
 * identical pixels before and after data arrives. Must not fetch. The page passes its Add
 * button as `actions`; the loading state draws the header without it.
 */
export function EventsHeader({ actions }: { actions?: React.ReactNode }) {
  return (
    <PageHeader
      title="Events"
      subtitle="Conferences, meetups and parties you went to — and the people you met there."
      actions={actions}
    />
  );
}
