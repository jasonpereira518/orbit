import { pageVisibilityGate } from "@/components/coming-soon/page-gate";
import { after } from "next/server";
import Link from "next/link";
import { getLatestFinishedImport, listImports } from "@/actions/imports";
import {
  listCalendarSubscriptions,
  syncStaleCalendarSubscriptions,
} from "@/actions/calendar";
import { getGmailConnectionStatus } from "@/actions/gmail";
import { getOutlookConnectionStatus } from "@/actions/outlook";
import { ImportHub } from "@/components/imports/import-hub";
import { LinkedInExportCard } from "@/components/linkedin/linkedin-export-card";
import { linkedinCardState } from "@/lib/linkedin-export-card";
import { hasLinkedInImport } from "@/lib/linkedin-reminder";
import { ensureUserSettings } from "@/lib/user-settings";
import { requireUserId } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";
import { CHAT_IMPORTS_SURFACE_KEY } from "@/lib/surfaces";
import { isSurfaceLive } from "@/lib/surface-visibility";
import type { ProviderCalendarInput } from "@/lib/imports/calendar-sources";
import { RenderStamp } from "@/components/layout/render-stamp";
import { PageHeader } from "@/components/layout/page-header";
import { PageShell } from "@/components/layout/page-shell";

/** Large connections imports process in the background via after(); allow it room to run. */
export const maxDuration = 300;

export default async function ImportsPage() {
  const gate = await pageVisibilityGate("page.imports");
  if (gate) return gate;

  // Keep the history paint fast; refresh subscriptions after the response.
  after(() => {
    void syncStaleCalendarSubscriptions().catch(() => {});
  });

  // Both connection statuses are fetched here rather than in a mount effect inside the cards,
  // so the calendar section knows on first paint whether anything is syncing — and so the
  // contacts cards stop flashing "Not connected" before their own fetch resolves.
  const userId = await requireUserId();
  const [history, latestFinish, calendarSubscriptions, entitlements, gmail, outlook, chatImports, settings, linkedinImported] =
    await Promise.all([
      listImports(),
      getLatestFinishedImport(),
      listCalendarSubscriptions(),
      getEntitlements(userId),
      getGmailConnectionStatus().catch(() => null),
      getOutlookConnectionStatus().catch(() => null),
      isSurfaceLive(userId, CHAT_IMPORTS_SURFACE_KEY),
      ensureUserSettings(userId),
      hasLinkedInImport(userId),
    ]);

  const google: ProviderCalendarInput | null = gmail
    ? {
        kind: "google",
        configured: gmail.configured,
        connected: gmail.connected,
        emailAddress: gmail.emailAddress,
        status: gmail.status,
        hasCalendarScope: gmail.hasCalendarScope,
        syncError: gmail.syncError,
        lastSyncedAt: gmail.lastSyncedAt,
      }
    : null;

  const microsoft: ProviderCalendarInput | null = outlook
    ? {
        kind: "outlook",
        configured: outlook.configured,
        connected: outlook.connected,
        emailAddress: outlook.emailAddress,
        status: outlook.status,
        hasCalendarScope: outlook.hasCalendarScope,
        syncError: outlook.syncError,
        lastSyncedAt: outlook.lastSyncedAt,
      }
    : null;

  return (
    <PageShell width="default">
      <RenderStamp />
      <PageHeader
        title="Imports"
        description={
          <>
            Drop your exports here and Orbit sorts out the rest. Once they’re in, browse everything in{" "}
            <Link href="/knowledge" className="underline-offset-2 hover:underline">
              Knowledge
            </Link>
            .
          </>
        }
      />

      {linkedinCardState({
        imported: linkedinImported,
        requestedAt: settings.linkedinExportRequestedAt ?? null,
        onboardingDone: Boolean(settings.onboardingCompletedAt),
      }).show && <LinkedInExportCard where="imports" requestedAt={settings.linkedinExportRequestedAt?.toISOString() ?? null} />}

      <ImportHub
        history={history}
        latestFinish={latestFinish}
        calendarSubscriptions={calendarSubscriptions}
        canUseSync={entitlements.canUseSync}
        google={google}
        outlook={microsoft}
        chatImports={chatImports}
        drive={{
          apiKey: process.env.NEXT_PUBLIC_GOOGLE_PICKER_API_KEY ?? null,
          appId: process.env.NEXT_PUBLIC_GOOGLE_APP_ID ?? null,
          // The OAuth client id is public (it's in every Google consent URL). Read on the
          // server and passed down so the browser's drive.file-only token comes from the
          // same client as the stored grant — see src/lib/imports/google-picker.ts.
          clientId: process.env.GOOGLE_CLIENT_ID?.trim() || null,
        }}
      />
    </PageShell>
  );
}
