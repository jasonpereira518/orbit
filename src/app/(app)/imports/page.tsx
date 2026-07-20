import { listImports } from "@/actions/imports";
import {
  listCalendarSubscriptions,
  syncStaleCalendarSubscriptions,
} from "@/actions/calendar";
import { ImportForm } from "@/components/imports/import-form";

export default async function ImportsPage() {
  // Refresh subscribed calendars when stale (every ~30 min while using the app)
  try {
    await syncStaleCalendarSubscriptions();
  } catch {
    // non-fatal — feed may be unreachable
  }

  const [history, calendarSubscriptions] = await Promise.all([
    listImports(),
    listCalendarSubscriptions(),
  ]);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="font-[family-name:var(--font-display)] text-3xl text-[#0f3d3e]">
          Imports
        </h1>
        <p className="mt-1 text-muted-foreground">
          Bring in LinkedIn connections, message history, and calendar meetings.
          Subscribe to an ICS feed to keep 1:1s and networking events in sync.
        </p>
      </div>
      <ImportForm
        history={history}
        calendarSubscriptions={calendarSubscriptions}
      />
    </div>
  );
}
