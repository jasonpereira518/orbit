"use client";

import { useMemo, useState } from "react";
import {
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isBefore,
  isSameDay,
  isSameMonth,
  startOfDay,
  startOfMonth,
  startOfWeek,
} from "date-fns";
import { Calendar, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"] as const;

export function toLocalYmd(d: Date) {
  return format(d, "yyyy-MM-dd");
}

export function parseLocalYmd(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [y, m, day] = value.split("-").map(Number);
  const d = new Date(y, m - 1, day);
  if (
    d.getFullYear() !== y ||
    d.getMonth() !== m - 1 ||
    d.getDate() !== day
  ) {
    return null;
  }
  return d;
}

/** Month grid used inside the date picker popover. */
export function MonthCalendar({
  month,
  selected,
  onSelect,
  onMonthChange,
  minDate,
  className,
}: {
  month: Date;
  selected?: Date | null;
  onSelect: (date: Date) => void;
  onMonthChange: (month: Date) => void;
  minDate?: Date | null;
  className?: string;
}) {
  const min = minDate ? startOfDay(minDate) : null;
  const days = useMemo(() => {
    const start = startOfWeek(startOfMonth(month));
    const end = endOfWeek(endOfMonth(month));
    return eachDayOfInterval({ start, end });
  }, [month]);

  const today = startOfDay(new Date());

  return (
    <div className={cn("w-[17.5rem]", className)}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="font-[family-name:var(--font-display)] text-base text-primary">
          {format(month, "MMMM yyyy")}
        </p>
        <div className="flex items-center gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="rounded-full text-muted-foreground"
            aria-label="Previous month"
            onClick={() => onMonthChange(addMonths(month, -1))}
          >
            <ChevronLeft className="size-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="rounded-full text-muted-foreground"
            aria-label="Next month"
            onClick={() => onMonthChange(addMonths(month, 1))}
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>

      <div className="mb-1 grid grid-cols-7 gap-0.5">
        {WEEKDAYS.map((d) => (
          <div
            key={d}
            className="py-1 text-center text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
          >
            {d}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-0.5">
        {days.map((day) => {
          const inMonth = isSameMonth(day, month);
          const isSelected = selected ? isSameDay(day, selected) : false;
          const isToday = isSameDay(day, today);
          const disabled = min ? isBefore(startOfDay(day), min) : false;

          return (
            <button
              key={day.toISOString()}
              type="button"
              disabled={disabled}
              onClick={() => onSelect(day)}
              className={cn(
                "relative flex size-9 items-center justify-center rounded-full text-sm transition-colors",
                "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
                !inMonth && "text-muted-foreground/40",
                inMonth && !isSelected && "text-foreground hover:bg-accent",
                isToday &&
                  !isSelected &&
                  "font-medium text-primary ring-1 ring-primary/25",
                isSelected &&
                  "bg-primary font-medium text-primary-foreground hover:bg-primary/90",
                disabled &&
                  "pointer-events-none text-muted-foreground/30 opacity-50"
              )}
            >
              {format(day, "d")}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function DatePickerButton({
  value,
  onSelect,
  onClear,
  disabled,
  minDate,
  label = "Calendar",
  className,
}: {
  /** YYYY-MM-DD */
  value?: string | null;
  onSelect: (ymd: string) => void;
  onClear?: () => void;
  disabled?: boolean;
  minDate?: Date | null;
  label?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = value ? parseLocalYmd(value) : null;
  const [month, setMonth] = useState<Date>(
    () => selected ?? minDate ?? new Date()
  );

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setMonth(selected ?? minDate ?? new Date());
      }}
    >
      <PopoverTrigger
        type="button"
        disabled={disabled}
        className={cn(
          "inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-sm font-medium transition-colors",
          "hover:bg-muted disabled:pointer-events-none disabled:opacity-50",
          className
        )}
      >
        <Calendar className="size-3.5" />
        {label}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-auto rounded-2xl border border-border/70 bg-card p-3 shadow-lg ring-0"
      >
        <MonthCalendar
          month={month}
          selected={selected}
          onMonthChange={setMonth}
          minDate={minDate}
          onSelect={(day) => {
            onSelect(toLocalYmd(day));
            setOpen(false);
          }}
        />
        <div className="mt-3 flex items-center justify-between border-t border-border/60 pt-2.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-muted-foreground"
            disabled={!value || !onClear}
            onClick={() => {
              onClear?.();
              setOpen(false);
            }}
          >
            Clear
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-primary"
            onClick={() => {
              const today = startOfDay(new Date());
              if (minDate && isBefore(today, startOfDay(minDate))) return;
              onSelect(toLocalYmd(today));
              setMonth(today);
              setOpen(false);
            }}
          >
            Today
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
