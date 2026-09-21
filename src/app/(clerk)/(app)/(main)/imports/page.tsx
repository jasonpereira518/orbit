import { after } from "next/server";
import Link from "next/link";
import { listImports } from "@/actions/imports";
import {
  listCalendarSubscriptions,
  syncStaleCalendarSubscriptions,
} from "@/actions/calendar";
import { getGmailConnectionStatus } from "@/actions/gmail";
import { getOutlookConnectionStatus } from "@/actions/outlook";
import { ImportHub } from "@/components/imports/import-hub";
import { requireUserId } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";
import type { ProviderCalendarInput } from "@/lib/imports/calendar-sources";

/** Large connections imports process in the background via after(); allow it room to run. */
export const maxDuration = 300;

export default async function ImportsPage() {
  // Keep the history paint fast; refresh subscriptions after the response.
  after(() => {
    void syncStaleCalendarSubscriptions().catch(() => {});
  });

  // Both connection statuses are fetched here rather than in a mount effect inside the cards,
  // so the calendar section knows on first paint whether anything is syncing — and so the
  // contacts cards stop flashing "Not connected" before their own fetch resolves.
  const [history, calendarSubscriptions, entitlements, gmail, outlook] =
    await Promise.all([
      listImports(),
      listCalendarSubscriptions(),
      getEntitlements(await requireUserId()),
      getGmailConnectionStatus().catch(() => null),
      getOutlookConnectionStatus().catch(() => null),
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
    <div className="mx-auto max-w-3xl space-y-8">
      <div>
        <h1 className="font-[family-name:var(--font-display)] text-3xl text-ink">
          Imports
        </h1>
        <p className="mt-1 text-muted-foreground">
          Drop your exports here and Orbit sorts out the rest. Once
          they&rsquo;re in, browse everything in{" "}
          <Link
            href="/knowledge"
            className="underline-offset-2 hover:underline"
          >
            Knowledge
          </Link>
          .
        </p>
      </div>

      <ImportHub
        history={history}
        calendarSubscriptions={calendarSubscriptions}
        canUseSync={entitlements.canUseSync}
        google={google}
        outlook={microsoft}
        drive={{
          apiKey: process.env.NEXT_PUBLIC_GOOGLE_PICKER_API_KEY ?? null,
          appId: process.env.NEXT_PUBLIC_GOOGLE_APP_ID ?? null,
          // The OAuth client id is public (it's in every Google consent URL). Read on the
          // server and passed down so the browser's drive.file-only token comes from the
          // same client as the stored grant — see src/lib/imports/google-picker.ts.
          clientId: process.env.GOOGLE_CLIENT_ID?.trim() || null,
        }}
      />
    </div>
  );
}
