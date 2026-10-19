/**
 * What a connect run actually did.
 *
 * A persistent card rather than only a toast, because one number here needs to survive
 * longer than four seconds: `blockedByPlan`. Folding "we dropped four people because your
 * plan is full" into a success message would make a partial failure look like a success,
 * which is the one outcome a user must not miss.
 *
 * Deliberately not a client component — it renders from props alone, so `smoke-events-page`
 * can assert its copy with `renderToStaticMarkup`.
 */
import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { TONE } from "@/lib/tone";
import { cn } from "@/lib/utils";
import type { ConnectSummary } from "@/lib/events/types";

export function IngestResultCard({
  summary,
}: {
  summary: ConnectSummary & { remaining?: number };
}) {
  const blocked = summary.blockedByPlan > 0;
  return (
    <Card>
      <CardContent>
      <p className="text-sm text-ink">
        <strong>{summary.created}</strong> added to your contacts,{" "}
        <strong>{summary.matched}</strong> already there.
      </p>
      {summary.unmatched > 0 ? (
        <p className="mt-1 text-sm text-muted-foreground">
          {summary.unmatched} row{summary.unmatched === 1 ? "" : "s"} had no usable name and
          {summary.unmatched === 1 ? " was" : " were"} skipped.
        </p>
      ) : null}
      {summary.remaining ? (
        <p className="mt-1 text-sm text-muted-foreground">
          {summary.remaining} still to go — they stay selected, so you can continue.
        </p>
      ) : null}
      {blocked ? (
        <div className={cn("mt-3 flex items-start gap-2 rounded-lg border p-3", TONE.warning.box)}>
          <AlertTriangle className={cn("mt-0.5 size-4 shrink-0", TONE.warning.text)} aria-hidden />
          <p className="text-sm text-ink">
            {summary.blockedByPlan}{" "}
            {summary.blockedByPlan === 1 ? "person wasn't" : "people weren't"} added — your
            plan&apos;s contact limit is full.{" "}
            <Link href="/upgrade" className="underline underline-offset-2">
              Upgrade to add them
            </Link>
            .
          </p>
        </div>
      ) : null}
      </CardContent>
    </Card>
  );
}
