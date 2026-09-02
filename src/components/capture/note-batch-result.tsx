"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "@/lib/toast";
import { deleteContact } from "@/actions/contacts";
import { dismissNoteReminder, undoNoteBatch } from "@/actions/note-batches";
import type { NoteBatchResult } from "@/lib/note-batches";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const BASIS_LABEL: Record<string, string> = {
  absolute: "date in your notes",
  relative: "counted from",
  vague: "no date given — default 2 weeks from",
  window: "follow-up window from",
};
const ANCHOR_LABEL: Record<string, string> = {
  note: "the date in your notes",
  hint: "the calendar/email date",
  upload: "when you pasted",
};

export function NoteBatchResultView({
  batchId,
  status,
  anchorIso,
  anchorBasis,
  result,
  reminderStatus,
  contactNames,
}: {
  batchId: string;
  status: "saved" | "undone";
  anchorIso: string;
  anchorBasis: "note" | "hint" | "upload";
  result: NoteBatchResult;
  reminderStatus: Record<string, string>;
  contactNames: Record<string, string>;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [local, setLocal] = useState(reminderStatus);
  const undone = status === "undone";

  function dismiss(id: string) {
    start(async () => {
      try {
        await dismissNoteReminder(id);
        setLocal((s) => ({ ...s, [id]: "dismissed" }));
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not dismiss");
      }
    });
  }

  function undo() {
    start(async () => {
      try {
        const out = await undoNoteBatch(batchId);
        setLocal((s) =>
          Object.fromEntries(
            Object.entries(s).map(([id, st]) => [
              id,
              st === "pending" ? "dismissed" : st,
            ])
          )
        );
        toast.success(`Undone: ${out.remindersDismissed} reminders dismissed`);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Undo failed");
      }
    });
  }

  function removeContact(contactId: string) {
    if (!confirm("Delete this contact and its notes?")) return;
    start(async () => {
      try {
        await deleteContact(contactId);
        toast.success("Contact deleted");
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Delete failed");
      }
    });
  }

  const name = (id: string | null) => (id ? contactNames[id] ?? "Unknown" : "No one");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-border/70 bg-muted/30 px-4 py-3 text-sm">
        <span className="text-muted-foreground">
          Relative dates counted from <strong className="text-ink">{anchorIso}</strong> ({ANCHOR_LABEL[anchorBasis]}).
        </span>
        {undone ? (
          <Badge variant="secondary">Undone</Badge>
        ) : (
          <Button variant="outline" size="sm" disabled={pending} onClick={undo}>Undo this batch</Button>
        )}
      </div>

      <Card className="border-border/70 shadow-none">
        <CardHeader><CardTitle>People you spoke to</CardTitle></CardHeader>
        <CardContent>
          <ul className="space-y-2">
            {result.participants.map((p) => (
              <li key={p.contactId} className="flex items-center justify-between gap-2 text-sm">
                <span>
                  <Link href={`/contacts/${p.contactId}`} className="text-primary underline">{p.name}</Link>
                  {p.created && <Badge variant="secondary" className="ml-2 text-[10px]">New</Badge>}
                  {p.duplicate && <Badge variant="secondary" className="ml-2 text-[10px]">Already logged</Badge>}
                </span>
                {p.created && (
                  <Button variant="ghost" size="sm" disabled={pending} onClick={() => removeContact(p.contactId)}>Delete contact</Button>
                )}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {(result.mentions.length > 0 || result.unresolvedMentions.length > 0) && (
        <Card className="border-border/70 shadow-none">
          <CardHeader><CardTitle>People mentioned</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            {result.mentions.map((m) => (
              <p key={`${m.interactionId}-${m.contactId}`}>
                &ldquo;{m.text}&rdquo; → <Link href={`/contacts/${m.contactId}`} className="text-primary underline">{name(m.contactId)}</Link>
                <span className="text-muted-foreground"> · {Math.round(m.confidence * 100)}%</span>
              </p>
            ))}
            {result.unresolvedMentions.map((m, index) => (
              <p key={`${index}-${m.text}`} className="flex items-center justify-between gap-2">
                <span>&ldquo;{m.text}&rdquo;{m.context ? <span className="text-muted-foreground"> — {m.context}</span> : null}</span>
                <Link href={`/capture?mode=structured`} className="text-xs text-primary underline">Add as contact</Link>
              </p>
            ))}
          </CardContent>
        </Card>
      )}

      <Card className="border-border/70 shadow-none">
        <CardHeader><CardTitle>Reminders created</CardTitle></CardHeader>
        <CardContent>
          {result.reminders.length === 0 ? (
            <p className="text-sm text-muted-foreground">No reminders came out of these notes.</p>
          ) : (
            <ul className="space-y-2">
              {result.reminders.map((r) => {
                const st = local[r.id] ?? "pending";
                return (
                  <li key={r.id} className="flex items-start justify-between gap-2 rounded-xl border border-border/60 px-3 py-2 text-sm">
                    <div>
                      <p className={st !== "pending" ? "line-through text-muted-foreground" : ""}>{r.title}</p>
                      <p className="text-xs text-muted-foreground">
                        {r.dueIso} · {name(r.contactId)}
                        {r.dateBasis !== "absolute" && <> · {BASIS_LABEL[r.dateBasis]} {anchorIso}</>}
                        {r.rawDatePhrase && <> · &ldquo;{r.rawDatePhrase}&rdquo;</>}
                      </p>
                    </div>
                    {st === "pending" ? (
                      <Button variant="ghost" size="sm" disabled={pending} onClick={() => dismiss(r.id)}>Dismiss</Button>
                    ) : (
                      <Badge variant="secondary" className="text-[10px] capitalize">{st}</Badge>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {(result.skipped.relative + result.skipped.unverifiable + result.skipped.past + result.skipped.duplicate) > 0 && (
            <p className="mt-3 text-xs text-muted-foreground">
              Skipped: {result.skipped.past} already past, {result.skipped.relative} unclear timing, {result.skipped.unverifiable} unverifiable, {result.skipped.duplicate} already logged.
            </p>
          )}
        </CardContent>
      </Card>

      <div className="flex gap-2">
        <Link href="/capture"><Button variant="outline" size="sm">Paste more notes</Button></Link>
        <Link href="/reminders"><Button variant="ghost" size="sm">Open reminders</Button></Link>
      </div>
    </div>
  );
}
