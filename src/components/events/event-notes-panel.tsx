"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import {
  BookOpen,
  Check,
  Loader2,
  NotebookPen,
  Save,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/toast";
import { saveEventNotes } from "@/actions/events";
import { friendlyError } from "@/lib/errors";

export function EventNotesPanel({
  eventId,
  initialNotes,
}: {
  eventId: string;
  initialNotes?: string | null;
}) {
  const [notes, setNotes] = useState(initialNotes ?? "");
  const [pending, start] = useTransition();
  const [syncStatus, setSyncStatus] = useState<"idle" | "saving" | "synced" | "dirty">("idle");
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);

  function executeSave(content: string) {
    setSyncStatus("saving");
    start(async () => {
      try {
        const result = await saveEventNotes(eventId, content);
        if (!result.ok) {
          setSyncStatus("dirty");
          toast.error(friendlyError(result.error, "Could not save notes"));
          return;
        }
        setSyncStatus("synced");
        setLastSavedAt(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
      } catch (err) {
        setSyncStatus("dirty");
        toast.error(friendlyError(err, "Could not save notes"));
      }
    });
  }

  function handleNotesChange(newText: string) {
    setNotes(newText);
    setSyncStatus("dirty");

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    debounceTimerRef.current = setTimeout(() => {
      executeSave(newText);
    }, 1200);
  }

  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, []);

  return (
    <div className="rounded-2xl border border-border/70 bg-card p-5 shadow-sm transition-all">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 pb-3">
        <div className="flex items-center gap-2.5">
          <div className="flex size-8 items-center justify-center rounded-lg bg-[var(--event-tint,theme(colors.primary.DEFAULT/10))] text-[var(--event-accent,theme(colors.primary.DEFAULT))]">
            <NotebookPen className="size-4" />
          </div>
          <div>
            <h3 className="font-medium text-ink">Event Notes & Learnings</h3>
            <p className="text-xs text-muted-foreground">
              Jot down key takeaways, impressions, and action items. Feeds directly into your Orbit Knowledge Base.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {syncStatus === "saving" && (
            <span className="inline-flex items-center gap-1 text-2xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" /> Saving...
            </span>
          )}
          {syncStatus === "synced" && (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-2xs font-medium text-emerald-600 dark:text-emerald-400">
              <Check className="size-3" /> Synced to Knowledge Context {lastSavedAt ? `(${lastSavedAt})` : ""}
            </span>
          )}
          {syncStatus === "dirty" && (
            <span className="text-2xs text-amber-500 font-medium">Unsaved changes</span>
          )}

          <Button
            size="sm"
            variant="outline"
            onClick={() => executeSave(notes)}
            disabled={pending || syncStatus === "synced"}
            className="h-8 gap-1.5 text-xs"
          >
            <Save className="size-3.5" /> Save
          </Button>
        </div>
      </div>

      <div className="mt-3">
        <textarea
          value={notes}
          onChange={(e) => handleNotesChange(e.target.value)}
          placeholder="Take notes: who you spoke to, what you learned, follow-up promises, interesting ideas... (Orbit AI can answer questions about these notes in Chat)"
          className="min-h-[140px] w-full resize-y rounded-xl border border-border/60 bg-background/50 p-3 text-sm text-ink placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
        />
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <Sparkles className="size-3.5 text-primary" />
          <span>Searchable in <strong>Orbit AI Chat</strong> and listed under <strong>Knowledge Base</strong>.</span>
        </div>

        <Link
          href={`/capture?eventId=${eventId}`}
          className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
        >
          <BookOpen className="size-3.5" />
          Log who you met from notes
        </Link>
      </div>
    </div>
  );
}
