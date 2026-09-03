import { after } from "next/server";
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
import { isResumableImportType } from "@/lib/import-job-dispatch";
import { GMAIL_SCAN_IMPORT_TYPE } from "@/lib/gmail-scan-processor";

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

  // canRetry is computed here, server-side, rather than in the client `ImportHistory` row:
  // that component must never import anything reaching `@/db`, and `isResumableImportType`
  // lives in a module that does. The Gmail recruiter scan is additionally Sync-plan-gated
  // (see `requireSyncUser` in `retryImport`) — hiding the button for a user who can't use it
  // avoids a Retry click that always bounces off the paywall.
  const historyWithRetry = history.map((h) => ({
    ...h,
    canRetry:
      h.status === "failed" &&
      isResumableImportType(h.importType) &&
      (h.importType !== GMAIL_SCAN_IMPORT_TYPE || entitlements.canUseSync),
  }));

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div>
        <h1 className="font-[family-name:var(--font-display)] text-3xl text-ink">
          Imports
        </h1>
        <p className="mt-1 text-muted-foreground">
          Bring in the people you already know — from Google, Outlook, or a
          LinkedIn export.
        </p>
      </div>

      {showLinkedInNudge && (
        <LinkedInExportNudge requestedAt={linkedInExport.requestedAt as string} />
      )}

      <ImportHub
        history={historyWithRetry}
        calendarSubscriptions={calendarSubscriptions}
        canUseSync={entitlements.canUseSync}
      />
    </div>
  );
}
