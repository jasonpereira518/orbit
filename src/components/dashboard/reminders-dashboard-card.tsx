"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { ReminderActionKind, ReminderPriority, ReminderCategory } from "@/db/schema";
import { ReminderRow } from "@/components/dashboard/reminder-row";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

// Three: this card shares a stretched row with Due follow-ups, whose rows are much shorter
// than these. More reminders leave that card half empty beside this one; "See more" opens the
// full page for the rest.
const PREVIEW_COUNT = 3;

export type DashboardReminderItem = {
  id: string;
  title: string;
  description?: string | null;
  dueDate?: Date | string | null;
  reminderType: string;
  actionKind?: ReminderActionKind;
  contactId?: string | null;
  contactName?: string | null;
  noteBatchId?: string | null;
  priority?: ReminderPriority;
  category?: ReminderCategory;
  timingRationale?: string | null;
  importanceReason?: string | null;
};

export function RemindersDashboardCard({
  items,
}: {
  items: DashboardReminderItem[];
}) {
  const hasMore = items.length > PREVIEW_COUNT;
  const preview = items.slice(0, PREVIEW_COUNT);
  const hiddenCount = items.length - PREVIEW_COUNT;

  return (
    <Card
      id="reminders"
      className="flex h-full flex-col border-border/70 shadow-none scroll-mt-8"
    >
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle as="h2" className="text-base">Reminders</CardTitle>
        <Link
          href="/reminders"
          className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}
        >
          View all
          <ArrowRight className="ml-1 h-3.5 w-3.5" />
        </Link>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col space-y-2">
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No pending reminders. Capture notes to create follow-ups.
          </p>
        ) : (
          <>
            <div className="space-y-2">
              {preview.map((r) => (
                <ReminderRow
                  key={r.id}
                  id={r.id}
                  title={r.title}
                  description={r.description}
                  dueDate={r.dueDate}
                  reminderType={r.reminderType}
                  actionKind={r.actionKind}
                  contactId={r.contactId}
                  contactName={r.contactName}
                  noteBatchId={r.noteBatchId}
                  priority={r.priority}
                  category={r.category}
                  timingRationale={r.timingRationale}
                  importanceReason={r.importanceReason}
                />
              ))}
            </div>
            {hasMore ? (
              <div className="mt-auto pt-1">
                <Link
                  href="/reminders"
                  className={cn(
                    buttonVariants({ variant: "ghost", size: "sm" }),
                    "w-full text-muted-foreground"
                  )}
                >
                  {`See more (${hiddenCount})`}
                </Link>
              </div>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
