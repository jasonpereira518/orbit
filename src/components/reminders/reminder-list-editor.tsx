"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Ban, Trash2 } from "lucide-react";
import { updateReminderList } from "@/actions/reminders";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent } from "@/components/ui/popover";
import { friendlyError } from "@/lib/errors";
import { ListGlyph } from "@/components/reminders/list-glyph";
import { LIST_COLORS, LIST_ICONS, listColorClass } from "@/lib/reminder-list-style";
import type { ReminderListSummary } from "@/lib/reminders-page";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

/**
 * A list's editor — name, icon, colour — opened by right-clicking the list in the rail or
 * from its ⋯ button (the way in for touch and keyboard, which have no right-click).
 *
 * Anchored to the row rather than to a trigger, so one editor serves every list. Keyed on
 * the list by the caller, so a draft never leaks from one list into the next.
 */
export function ReminderListEditor({
  list,
  anchor,
  onClose,
  onRequestDelete,
}: {
  list: ReminderListSummary;
  anchor: HTMLElement | null;
  onClose: () => void;
  onRequestDelete: (list: ReminderListSummary) => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [name, setName] = useState(list.name);
  const [icon, setIcon] = useState<string | null>(list.icon);
  const [color, setColor] = useState<string | null>(list.color);

  const tint = listColorClass(color);
  const changed = name.trim() !== list.name || icon !== list.icon || color !== list.color;

  function save() {
    if (!changed) {
      onClose();
      return;
    }
    start(async () => {
      try {
        const res = await updateReminderList(list.id, {
          ...(list.isInbox ? {} : { name }),
          icon,
          color,
        });
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        toast.success("List updated", { keep: false });
        onClose();
        router.refresh();
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t update that list — try again?"));
      }
    });
  }

  return (
    <Popover open onOpenChange={(open) => !open && onClose()}>
      <PopoverContent
        anchor={anchor}
        side="right"
        align="start"
        sideOffset={8}
        className="w-72 rounded-2xl border border-border/70 bg-card p-3 shadow-lg ring-0"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
          className="space-y-3"
        >
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted",
                tint ?? "text-muted-foreground"
              )}
            >
              <ListGlyph list={{ icon, color, isInbox: list.isInbox }} tinted={false} />
            </span>
            <div className="min-w-0 flex-1">
              <label htmlFor={`list-name-${list.id}`} className="sr-only">
                List name
              </label>
              <Input
                id={`list-name-${list.id}`}
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={list.isInbox}
                autoFocus={!list.isInbox}
                className="h-8"
              />
            </div>
          </div>
          {list.isInbox && (
            <p className="-mt-1 text-xs text-muted-foreground">
              The Inbox keeps its name — it’s where Orbit files new reminders.
            </p>
          )}

          <fieldset>
            <legend className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Icon
            </legend>
            <div className="grid grid-cols-6 gap-1">
              {Object.entries(LIST_ICONS).map(([key, { icon: Icon, label }]) => {
                const selected = (icon ?? (list.isInbox ? "inbox" : "list")) === key;
                return (
                  <button
                    key={key}
                    type="button"
                    aria-label={label}
                    aria-pressed={selected}
                    title={label}
                    onClick={() => setIcon(key)}
                    className={cn(
                      "flex aspect-square items-center justify-center rounded-lg transition-colors duration-fast",
                      "outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                      selected
                        ? cn("bg-muted ring-1 ring-border", tint ?? "text-foreground")
                        : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                    )}
                  >
                    <Icon className="size-4" />
                  </button>
                );
              })}
            </div>
          </fieldset>

          <fieldset>
            <legend className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Color
            </legend>
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                aria-label="No color"
                aria-pressed={color === null}
                title="No color"
                onClick={() => setColor(null)}
                className={cn(
                  "flex size-7 items-center justify-center rounded-full border border-border text-muted-foreground",
                  "outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                  color === null && "ring-2 ring-foreground/40 ring-offset-2 ring-offset-card"
                )}
              >
                <Ban className="size-3.5" />
              </button>
              {Object.entries(LIST_COLORS).map(([key, { label, dot }]) => (
                <button
                  key={key}
                  type="button"
                  aria-label={label}
                  aria-pressed={color === key}
                  title={label}
                  onClick={() => setColor(key)}
                  className={cn(
                    "size-7 rounded-full",
                    dot,
                    "outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                    color === key && "ring-2 ring-foreground/40 ring-offset-2 ring-offset-card"
                  )}
                />
              ))}
            </div>
          </fieldset>

          <div className="flex items-center gap-2 border-t border-border/60 pt-3">
            {!list.isInbox && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 gap-1.5 px-2 text-muted-foreground hover:text-destructive"
                onClick={() => onRequestDelete(list)}
              >
                <Trash2 className="size-3.5" /> Delete
              </Button>
            )}
            <div className="flex-1" />
            <Button type="button" variant="outline" size="sm" className="h-8" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" size="sm" className="h-8" disabled={pending || !name.trim()}>
              {pending ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}
