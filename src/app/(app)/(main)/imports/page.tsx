import { after } from "next/server";
import Link from "next/link";
import { listImports } from "@/actions/imports";
import {
  listCalendarSubscriptions,
  syncStaleCalendarSubscriptions,
} from "@/actions/calendar";
import { ImportHub } from "@/components/imports/import-hub";
import { requireUserId } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";

/** Large connections imports process in the background via after(); allow it room to run. */
export const maxDuration = 300;

export default async function ImportsPage() {
  const [history, calendarSubscriptions, entitlements] = await Promise.all([
    listImports(),
    listCalendarSubscriptions(),
    getEntitlements(await requireUserId()),
  ]);

  // Keep the history paint fast; refresh subscriptions after the response.
  //
  // Gated on the entitlement rather than fired unconditionally. `requireEntitlement`
  // records a `gate_events` row BEFORE it throws, and the `.catch(() => {})` swallowed
  // the throw — so every free user who opened this page to upload a LinkedIn CSV
  // silently logged demand for calendar sync, on every visit and every refresh. That
  // table's own comment calls it "the only place demand for a gated feature can be
  // observed", and this was filling it with page views.
  if (entitlements.canUseSync) {
    after(() => {
      void syncStaleCalendarSubscriptions().catch(() => {});
    });
  }

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

      <ImportHub
        history={history}
        calendarSubscriptions={calendarSubscriptions}
        canUseSync={entitlements.canUseSync}
      />
    </div>
  );
}
