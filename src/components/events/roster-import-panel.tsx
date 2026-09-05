"use client";

/**
 * Getting a guest list in.
 *
 * This is the path that covers the common case, and the copy has to be straight about why it
 * exists: no platform exposes the guest list of an event you merely attended. Luma's API key
 * is scoped to a calendar you own, Eventbrite's attendees endpoint needs organiser scope, and
 * Partiful hides the invite list from guests by design. So for anything you did not host, the
 * list is pasted or uploaded — and saying so plainly is better than a "Sync attendees" button
 * that silently returns nothing.
 */
import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ClipboardPaste, Loader2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/lib/toast";
import { importAttendeesFromCsv, importAttendeesFromText } from "@/actions/events";

export function RosterImportPanel({ eventId }: { eventId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [text, setText] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  function report(result: { added: number; skipped: number; deduped: number }) {
    const extra = [
      result.deduped > 0 ? `${result.deduped} already listed` : null,
      // Reported, never silently dropped — a roster that quietly loses rows is worse than
      // one that says it could not read them.
      result.skipped > 0 ? `${result.skipped} unreadable` : null,
    ]
      .filter(Boolean)
      .join(", ");
    toast.success(
      `Added ${result.added} ${result.added === 1 ? "person" : "people"}${extra ? ` (${extra})` : ""}.`
    );
    router.refresh();
  }

  function submitText() {
    if (!text.trim()) return;
    start(async () => {
      try {
        report(await importAttendeesFromText(eventId, text));
        setText("");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not read that list.");
      }
    });
  }

  function submitFile(file: File) {
    start(async () => {
      try {
        report(await importAttendeesFromCsv(eventId, await file.text()));
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not read that CSV.");
      } finally {
        if (fileInput.current) fileInput.current.value = "";
      }
    });
  }

  return (
    <div className="rounded-2xl border border-border/70 bg-card p-5">
      <h2 className="font-medium text-ink">Add the guest list</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Paste it from the event page, or upload a CSV export. One person per line — names,
        emails, LinkedIn URLs and &ldquo;Name — Title at Company&rdquo; all work.
      </p>

      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={5}
        className="mt-3"
        placeholder={"Ada Lovelace <ada@analytical.io> — Engineer at Analytical\nGrace Hopper, COBOL Inc"}
        aria-label="Paste the guest list"
      />

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button onClick={submitText} disabled={pending || !text.trim()}>
          {pending ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <ClipboardPaste className="size-4" aria-hidden />
          )}
          Add pasted list
        </Button>

        <input
          ref={fileInput}
          type="file"
          accept=".csv,text/csv"
          className="sr-only"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) submitFile(file);
          }}
        />
        <Button
          variant="outline"
          onClick={() => fileInput.current?.click()}
          disabled={pending}
        >
          <Upload className="size-4" aria-hidden />
          Upload CSV
        </Button>
      </div>
    </div>
  );
}
