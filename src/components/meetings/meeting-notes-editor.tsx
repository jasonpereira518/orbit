"use client";

/** Your notes on a past meeting: what you typed during the call, editable, saved on blur. */

import { useRef, useState } from "react";
import { saveMeetingNotes } from "@/actions/meetings";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/lib/toast";

export function MeetingNotesEditor({ sessionId, initial }: { sessionId: string; initial: string }) {
  const [value, setValue] = useState(initial);
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");
  const saved = useRef(initial);

  async function save() {
    if (value === saved.current) return;
    setStatus("saving");
    const res = await saveMeetingNotes(sessionId, value);
    if (!res.ok) {
      setStatus("idle");
      toast.error(res.error);
      return;
    }
    saved.current = value;
    setStatus("saved");
  }

  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor="meeting-notes" className="text-sm font-medium text-ink">
          My notes
        </label>
        <span className="text-xs text-muted-foreground" aria-live="polite">
          {status === "saving" ? "Saving…" : status === "saved" ? "Saved" : "Only you see these"}
        </span>
      </div>
      <Textarea
        id="meeting-notes"
        value={value}
        maxLength={20_000}
        onChange={(e) => {
          setValue(e.target.value);
          setStatus("idle");
        }}
        onBlur={() => void save()}
        placeholder="Nothing yet — jot what you want to remember about this meeting."
        className="min-h-28 resize-y leading-relaxed"
      />
    </section>
  );
}
