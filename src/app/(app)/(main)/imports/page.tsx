import { after } from "next/server";
import Link from "next/link";
import { listImports } from "@/actions/imports";
import {
  listCalendarSubscriptions,
  syncStaleCalendarSubscriptions,
} from "@/actions/calendar";
import { getLinkedInExportStatus } from "@/actions/linkedin-export";
import { ImportHub } from "@/components/imports/import-hub";
import { LinkedInExportNudge } from "@/components/imports/linkedin-export-nudge";
import { requireUserId } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";

/** Large connections imports process in the background via after(); allow it room to run. */
export const maxDuration = 300;

/** Beyond this the export almost certainly isn't coming; the nudge stops offering it. */
const NUDGE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Plain module-level function, not inlined in the component: `Date.now()` in the render
 * body itself trips `react-hooks/purity` (impure call during render).
 */
function shouldShowLinkedInNudge(status: {
  requestedAt: string | null;
  hasLinkedInImport: boolean;
}): boolean {
  if (!status.requestedAt || status.hasLinkedInImport) return false;
  return Date.now() - new Date(status.requestedAt).getTime() < NUDGE_MAX_AGE_MS;
}

export default async function ImportsPage() {
  // Keep the history paint fast; refresh subscriptions after the response.
  after(() => {
    void syncStaleCalendarSubscriptions().catch(() => {});
  });

  const [history, calendarSubscriptions, entitlements, linkedInExport] =
    await Promise.all([
      listImports(),
      listCalendarSubscriptions(),
      getEntitlements(await requireUserId()),
      getLinkedInExportStatus(),
    ]);

  const showLinkedInNudge = shouldShowLinkedInNudge(linkedInExport);

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div>
        <h1 className="font-[family-name:var(--font-display)] text-3xl text-ink">
          Imports
        </h1>
        <p className="mt-1 text-muted-foreground">
          Upload LinkedIn data, sync calendars, and review past imports. After
          import, browse everything in{" "}
          <Link href="/knowledge" className="underline-offset-2 hover:underline">
            Knowledge
          </Link>
          .
        </p>
      </div>

      {showLinkedInNudge && (
        <LinkedInExportNudge requestedAt={linkedInExport.requestedAt as string} />
      )}

      <ImportHub
        history={history}
        calendarSubscriptions={calendarSubscriptions}
        canUseSync={entitlements.canUseSync}
      />
    </div>
  );
}
