"use client";

import { useState, useTransition } from "react";
import { formatDistanceToNow } from "date-fns";
import { Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { RadarActionResult } from "@/actions/radar";
import { friendlyError } from "@/lib/errors";
import { toast } from "@/lib/toast";

/** What the strip draws. `key` is opaque: the handlers take it back, nothing else is sent. */
export type InboxPersonView = {
  key: string;
  name: string;
  title: string | null;
  kind: "job_posting" | "process_update" | "news" | "event";
  summary: string;
  /** ISO time of the email. */
  at: string;
};

export type InboxPeopleProps = {
  people: InboxPersonView[];
  onAdd: (key: string) => Promise<RadarActionResult & { contactId?: string }>;
  onDismiss: (key: string) => Promise<RadarActionResult>;
  /** Called after a change that the rest of the page should show (new cards). */
  onChanged?: () => void;
};

export const INBOX_KIND_LABELS: Record<InboxPersonView["kind"], string> = {
  process_update: "Hiring update",
  job_posting: "Job",
  event: "Event",
  news: "News",
};

/**
 * People your recent email names who are not in your orbit. Two buttons each, nothing automatic:
 * Orbit adds someone only when you press Add. The email's address is never drawn here; the
 * contact is built on the server from what the email said.
 */
export function InboxPeople({ people, onAdd, onDismiss, onChanged }: InboxPeopleProps) {
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [, start] = useTransition();

  const visible = people.filter((p) => !gone.has(p.key));
  if (visible.length === 0) return null;

  const run = (key: string, act: () => Promise<RadarActionResult>) => {
    setBusy(key);
    start(async () => {
      try {
        const result = await act();
        if (result.ok) {
          toast.success(result.message ?? "Done");
          setGone((prev) => new Set(prev).add(key));
        } else {
          // Not added (the plan's limit, or the suggestion changed). The row stays until the
          // refresh below says the server still offers it.
          toast.error(result.message);
        }
        onChanged?.();
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t do that — try again?"));
      } finally {
        setBusy(null);
      }
    });
  };

  return (
    <section aria-labelledby="radar-inbox" className="rounded-xl border border-border/60 px-3 py-2.5 sm:px-4">
      <h2 id="radar-inbox" className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        <Mail className="size-3.5" aria-hidden />
        From your inbox
      </h2>
      <p className="mt-0.5 text-xs text-muted-foreground">People your recent email names who aren’t in your orbit yet.</p>
      <ul className="mt-2 space-y-2">
        {visible.map((p) => (
          <li key={p.key} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
            <div className="min-w-0 flex-1 basis-56">
              <p className="truncate text-sm">
                <span className="font-medium text-ink">{p.name}</span>
                {p.title && <span className="text-muted-foreground"> · {p.title}</span>}
              </p>
              <p className="truncate text-xs text-muted-foreground" suppressHydrationWarning>
                {INBOX_KIND_LABELS[p.kind]} · {p.summary} · {formatDistanceToNow(new Date(p.at), { addSuffix: true })}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 px-2.5 text-xs"
                disabled={busy !== null}
                aria-label={`Add ${p.name} to Orbit`}
                onClick={() => run(p.key, () => onAdd(p.key))}
              >
                Add to Orbit
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-8 px-2 text-xs"
                disabled={busy !== null}
                aria-label={`Dismiss ${p.name}`}
                onClick={() => run(p.key, () => onDismiss(p.key))}
              >
                Dismiss
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
