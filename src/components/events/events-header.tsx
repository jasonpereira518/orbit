import { PageHeader } from "@/components/layout/page-header";

/**
 * Static events header, rendered by BOTH page.tsx and loading.tsx so client navigation shows
 * identical pixels before and after data arrives. Must not fetch.
 *
 * A thin wrapper over the shared `PageHeader` rather than its own markup: the two callers
 * and `scripts/smoke-events-page.ts` (which renders it standalone) are the only reasons it
 * still exists as a file.
 */
export function EventsHeader({ actions }: { actions?: React.ReactNode }) {
  return (
    <PageHeader
      title="Events"
      description="Conferences, meetups and parties you went to — and the people you met there."
      actions={actions}
    />
  );
}
