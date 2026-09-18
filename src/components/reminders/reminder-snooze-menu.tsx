"use client";

import { useState } from "react";
import { Clock } from "lucide-react";
import { MonthCalendar, toLocalYmd } from "@/components/ui/date-picker";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { shortDayLabel, snoozePresets } from "@/lib/reminder-due-bucket";
import { cn } from "@/lib/utils";

/**
 * Snooze to a day: three presets and a calendar, one popover. Shared by a row, the detail
 * pane and the bulk bar. The same presets-plus-calendar shape as the contact page's
 * follow-up picker (`contact-follow-up-section.tsx`), in one surface rather than two.
 *
 * Controlled, so the queue's `s` shortcut can open it on the focused row.
 */
export function ReminderSnoozeMenu({
  today,
  open,
  onOpenChange,
  onPick,
  disabled,
  triggerClassName,
  triggerLabel,
  align = "end",
}: {
  /** The viewer's today, YYYY-MM-DD (from the server's page). */
  today: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `label` is the human phrase for the toast: "tomorrow", "Sat, Sep 26". */
  onPick: (ymd: string, label: string) => void;
  disabled?: boolean;
  triggerClassName?: string;
  /** Visible text; omit for an icon-only trigger. */
  triggerLabel?: string;
  align?: "start" | "center" | "end";
}) {
  const presets = snoozePresets(today);
  const [month, setMonth] = useState(() => new Date(`${presets.tomorrow}T12:00:00`));

  const options: Array<{ ymd: string; label: string; phrase: string }> = [
    { ymd: presets.tomorrow, label: "Tomorrow", phrase: "tomorrow" },
    // On a Friday "this weekend" IS tomorrow; one option is enough.
    ...(presets.weekend !== presets.tomorrow
      ? [{ ymd: presets.weekend, label: "This weekend", phrase: "the weekend" }]
      : []),
    { ymd: presets.nextWeek, label: "Next week", phrase: "next week" },
  ];

  function pick(ymd: string, phrase: string) {
    onPick(ymd, phrase);
    onOpenChange(false);
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (next) setMonth(new Date(`${presets.tomorrow}T12:00:00`));
      }}
    >
      <PopoverTrigger
        type="button"
        disabled={disabled}
        aria-label={triggerLabel ? undefined : "Snooze"}
        title={triggerLabel ? undefined : "Snooze (s)"}
        className={cn(
          "inline-flex items-center justify-center gap-1.5 rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50",
          triggerLabel ? "h-7 px-2 text-xs font-medium" : "size-7",
          triggerClassName
        )}
      >
        <Clock className="size-3.5" />
        {triggerLabel}
      </PopoverTrigger>
      <PopoverContent
        align={align}
        className="w-auto rounded-2xl border border-border/70 bg-card p-2 shadow-lg ring-0"
      >
        <p className="px-2 pb-1 pt-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Snooze until
        </p>
        <ul className="mb-2">
          {options.map((o) => (
            <li key={o.label}>
              <button
                type="button"
                onClick={() => pick(o.ymd, o.phrase)}
                className="flex w-full items-center justify-between gap-6 rounded-lg px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
              >
                <span>{o.label}</span>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {shortDayLabel(o.ymd)}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <div className="border-t border-border/60 px-1 pt-2">
          <MonthCalendar
            month={month}
            onMonthChange={setMonth}
            minDate={new Date(`${presets.tomorrow}T00:00:00`)}
            onSelect={(day) => {
              const ymd = toLocalYmd(day);
              pick(ymd, shortDayLabel(ymd));
            }}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
