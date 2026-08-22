"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronDown, ChevronUp, Pencil, Sparkles, X } from "lucide-react";
import { toast } from "@/lib/toast";
import {
  confirmSuggestedReminder,
  discardSuggestedReminder,
  type SuggestedReminderRow,
} from "@/actions/suggested-reminders";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

function isoDayValue(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatDue(d: Date) {
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function SuggestedRemindersPanel({
  items,
}: {
  items: SuggestedReminderRow[];
}) {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const visible = items.filter((i) => !dismissed.has(i.id));

  if (!visible.length) return null;

  return (
    <section className="space-y-3 rounded-2xl border border-amber-500/30 bg-amber-500/[0.04] p-5">
      <div className="flex items-center gap-2">
        <Sparkles className="size-4 text-amber-600 dark:text-amber-300" />
        <h2 className="text-sm font-medium text-foreground">
          Suggested from your notes
        </h2>
        <span className="text-xs text-muted-foreground">
          {visible.length} to review
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        Dates Orbit found written in notes you captured. Nothing is scheduled until
        you confirm it.
      </p>
      <ul className="space-y-2">
        {visible.map((item) => (
          <SuggestionRow
            key={item.id}
            item={item}
            onResolved={() =>
              setDismissed((prev) => new Set(prev).add(item.id))
            }
          />
        ))}
      </ul>
    </section>
  );
}

function SuggestionRow({
  item,
  onResolved,
}: {
  item: SuggestedReminderRow;
  onResolved: () => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const [title, setTitle] = useState(item.title);
  const [dueDate, setDueDate] = useState(isoDayValue(new Date(item.dueDate)));

  function run(label: string, fn: () => Promise<unknown>) {
    start(async () => {
      try {
        await fn();
        toast.success(label);
        onResolved();
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Something went wrong");
      }
    });
  }

  return (
    <li className="rounded-xl border border-border/60 bg-card p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          {editing ? (
            <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                aria-label="Reminder title"
              />
              <Input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                aria-label="Due date"
                className={cn(
                  item.yearInferred && "ring-1 ring-amber-500/50"
                )}
              />
            </div>
          ) : (
            <>
              <p className="truncate text-sm font-medium text-foreground">
                {title}
              </p>
              <p className="text-xs text-muted-foreground">
                {formatDue(new Date(item.dueDate))}
                {item.contactName ? ` · ${item.contactName}` : ""}
              </p>
            </>
          )}

          {item.yearInferred && (
            <p className="text-xs text-amber-700 dark:text-amber-300">
              Year not stated in the notes — assumed{" "}
              {new Date(item.dueDate).getFullYear()}
            </p>
          )}

          <button
            type="button"
            onClick={() => setShowSource((v) => !v)}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            {showSource ? (
              <ChevronUp className="size-3" />
            ) : (
              <ChevronDown className="size-3" />
            )}
            from &ldquo;{item.rawDatePhrase}&rdquo;
          </button>
          {showSource && (
            <p className="rounded-lg bg-muted/50 p-2 text-xs text-muted-foreground">
              {item.sourceExcerpt}
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="icon"
            variant="ghost"
            aria-label="Edit"
            disabled={pending}
            onClick={() => setEditing((v) => !v)}
          >
            <Pencil className="size-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Confirm reminder"
            disabled={pending || !title.trim()}
            onClick={() =>
              run("Reminder added", () =>
                confirmSuggestedReminder(item.id, {
                  title: title.trim(),
                  dueDate,
                })
              )
            }
          >
            <Check className="size-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Discard suggestion"
            disabled={pending}
            onClick={() =>
              run("Suggestion discarded", () =>
                discardSuggestedReminder(item.id)
              )
            }
          >
            <X className="size-4" />
          </Button>
        </div>
      </div>
    </li>
  );
}
