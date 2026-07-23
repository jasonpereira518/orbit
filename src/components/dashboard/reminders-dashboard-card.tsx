"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { ReminderActionKind } from "@/db/schema";
import { ReminderRow } from "@/components/dashboard/reminder-row";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

const PREVIEW_COUNT = 5;

export type DashboardReminderItem = {
  id: string;
  title: string;
  description?: string | null;
  dueDate?: Date | string | null;
  reminderType: string;
  actionKind?: ReminderActionKind;
  contactId?: string | null;
  contactName?: string | null;
};

export function RemindersDashboardCard({
  items,
}: {
  items: DashboardReminderItem[];
}) {
  const [expanded, setExpanded] = useState(false);
  const hasMore = items.length > PREVIEW_COUNT;
  const visible = expanded ? items : items.slice(0, PREVIEW_COUNT);
  const hiddenCount = items.length - PREVIEW_COUNT;

  return (
    <Card
      id="reminders"
      className="flex h-full flex-col border-border/70 shadow-none scroll-mt-8"
    >
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle className="text-base">Reminders</CardTitle>
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
              {visible.map((r) => (
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
                />
              ))}
            </div>
            {hasMore ? (
              <div className="mt-auto pt-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="w-full text-muted-foreground"
                  onClick={() => setExpanded((v) => !v)}
                >
                  {expanded
                    ? "See less"
                    : `See more${hiddenCount > 0 ? ` (${hiddenCount})` : ""}`}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
