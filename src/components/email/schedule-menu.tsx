"use client";

import { ChevronDown, Clock, Loader2, Send } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { MonthCalendar, toLocalYmd } from "@/components/ui/date-picker";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SCHEDULE_MAX_LEAD_MS, SCHEDULE_MIN_LEAD_MS } from "@/lib/email/config";
import { atLocal, formatScheduled, schedulePresets, timeOptions } from "@/lib/email/schedule-presets";

function timeLabel(hhmm: string) {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(atLocal("2000-01-01", hhmm));
}

/**
 * Send, as a split button: the main half sends now (after the undo window); the chevron offers
 * a later time. "Pick date & time" asks the composer to show `SchedulePicker` on its own row,
 * rather than a popover — the composer is itself a dialog, and a bottom sheet on phones.
 */
export function ScheduleMenu({
  disabled,
  sending,
  onSendNow,
  onSchedule,
  onPickCustom,
}: {
  disabled: boolean;
  sending: boolean;
  onSendNow: () => void;
  onSchedule: (at: Date) => void;
  onPickCustom: () => void;
}) {
  const presets = useMemo(() => schedulePresets(new Date()), []);
  const now = new Date();

  return (
    <div className="flex items-center">
      <Button type="button" size="sm" onClick={onSendNow} disabled={disabled} className="rounded-r-none">
        {sending ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
        Send
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              size="sm"
              disabled={disabled}
              aria-label="Send later"
              className="rounded-l-none border-l border-primary-foreground/25 px-2"
            >
              <ChevronDown className="size-3.5" aria-hidden />
            </Button>
          }
        />
        <DropdownMenuContent align="end" className="w-auto min-w-56">
          <DropdownMenuItem onClick={() => onSchedule(presets.tomorrowMorning)}>
            <Clock className="size-3.5" aria-hidden />
            Send {formatScheduled(presets.tomorrowMorning, now).replace(/^around /, "")}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onSchedule(presets.mondayMorning)}>
            <Clock className="size-3.5" aria-hidden />
            Send {formatScheduled(presets.mondayMorning, now).replace(/^around /, "")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onPickCustom}>Pick date &amp; time…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export function SchedulePicker({
  disabled,
  onCancel,
  onConfirm,
}: {
  disabled: boolean;
  onCancel: () => void;
  onConfirm: (at: Date) => void;
}) {
  const initial = useMemo(() => schedulePresets(new Date()).tomorrowMorning, []);
  const [day, setDay] = useState<Date>(initial);
  const [month, setMonth] = useState<Date>(initial);
  const [time, setTime] = useState("08:00");
  const options = useMemo(() => timeOptions().map((t) => ({ value: t, label: timeLabel(t) })), []);

  // The picker's clock is when it opened; the server re-checks the lead at send.
  const [openedAt] = useState(() => Date.now());
  const at = atLocal(toLocalYmd(day), time);
  const lead = at.getTime() - openedAt;
  const problem =
    lead < SCHEDULE_MIN_LEAD_MS
      ? "Pick a time that hasn’t passed"
      : lead > SCHEDULE_MAX_LEAD_MS
        ? "Pick a time within the next 30 days"
        : null;

  return (
    <div role="group" aria-label="Pick a send time" className="ml-auto w-full max-w-72 rounded-xl border border-border/70 p-2">
      <MonthCalendar month={month} selected={day} onSelect={setDay} onMonthChange={setMonth} minDate={new Date()} />
      <div className="mt-2 flex items-center gap-2">
        <Select value={time} onValueChange={(v) => typeof v === "string" && setTime(v)} items={options}>
          <SelectTrigger aria-label="Time" className="h-8 flex-1">
            <SelectValue />
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false} className="max-h-64 p-1">
            {options.map((o) => (
              <SelectItem key={o.value} value={o.value} className="py-1.5 pl-2">
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <p className="mt-2 text-xs text-muted-foreground" role={problem ? "alert" : undefined}>
        {problem ?? `Sends ${formatScheduled(at, new Date(openedAt))}`}
      </p>
      <div className="mt-2 flex justify-end gap-1">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" size="sm" onClick={() => onConfirm(at)} disabled={disabled || Boolean(problem)}>
          Schedule
        </Button>
      </div>
    </div>
  );
}
