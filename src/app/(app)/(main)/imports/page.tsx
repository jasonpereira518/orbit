import { after } from "next/server";
import { listImports } from "@/actions/imports";
import {
  listCalendarSubscriptions,
  syncStaleCalendarSubscriptions,
} from "@/actions/calendar";
import { CalendarImportSection } from "@/components/imports/calendar-import-section";
import { ImportHistory } from "@/components/imports/import-history";
import { LinkedInConnectionsImport } from "@/components/imports/linkedin-connections-import";
import { LinkedInMessagesImport } from "@/components/imports/linkedin-messages-import";

export default async function ImportsPage() {
  // Keep the history paint fast; refresh subscriptions after the response.
  after(() => {
    void syncStaleCalendarSubscriptions().catch(() => {});
  });

  const [history, calendarSubscriptions] = await Promise.all([
    listImports(),
    listCalendarSubscriptions(),
  ]);

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div>
        <h1 className="font-[family-name:var(--font-display)] text-3xl text-primary">
          Imports
        </h1>
        <p className="mt-1 text-muted-foreground">
          Upload LinkedIn data, sync calendars, and review past imports.
        </p>
      </div>

      <LinkedInConnectionsImport />
      <LinkedInMessagesImport />
      <CalendarImportSection calendarSubscriptions={calendarSubscriptions} />
      <ImportHistory history={history} />
    </div>
  );
}
