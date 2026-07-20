import { after } from "next/server";
import Link from "next/link";
import { listImports } from "@/actions/imports";
import {
  listCalendarSubscriptions,
  syncStaleCalendarSubscriptions,
} from "@/actions/calendar";
import { ImportHub } from "@/components/imports/import-hub";

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
          Upload LinkedIn data, sync calendars, and review past imports. After
          import, browse everything in{" "}
          <Link href="/knowledge" className="underline-offset-2 hover:underline">
            Knowledge
          </Link>
          .
        </p>
      </div>

      <ImportHub
        history={history}
        calendarSubscriptions={calendarSubscriptions}
      />
    </div>
  );
}
