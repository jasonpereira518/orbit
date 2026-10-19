"use client";

import { useState, useTransition } from "react";
import { ArrowRight, AtSign, BellRing, CalendarDays, Check, ListChecks, Users, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { IntentLink } from "@/components/ui/intent-link";
import { useRouter } from "next/navigation";
import { toast } from "@/lib/toast";
import { deleteContact } from "@/actions/contacts";
import { deleteNoteBatch, dismissNoteReminder, undoNoteBatch } from "@/actions/note-batches";
import { useConfirmFocus } from "@/components/settings/use-confirm-focus";
import type { NoteBatchResult } from "@/lib/note-batches";
import type { ReminderActionKind } from "@/db/schema";
import { ReminderFormDialog } from "@/components/reminders/reminder-form-dialog";
import { MeetingSummaryCard } from "@/components/capture/meeting-summary-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { friendlyError } from "@/lib/errors";
import { TOAST_COPY } from "@/lib/toast-copy";
import { CONTACT_DELETE_EXPLAINER } from "@/lib/contact-delete-copy";

export type NoteBatchReminderDetail = {
  description: string | null;
  actionKind: ReminderActionKind | null;
  listId: string | null;
};

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

/**
 * One colour and one symbol per kind of thing a capture makes, so a section is recognisable
 * before its title is read: people you met are the success tone, people only named are info,
 * things to do are the accent, dates are the warning tone. Every tone is a translucent wash
 * plus the matching semantic text colour, which `globals.css` keeps at contrast on both themes.
 */
const TONE = {
  people: {
    Icon: Users,
    chip: "bg-success/10 text-success",
    bar: "border-l-success",
    tile: "border-success/30 bg-success/8 hover:bg-success/12",
    ink: "text-success",
  },
  mentions: {
    Icon: AtSign,
    chip: "bg-info/10 text-info",
    bar: "border-l-info",
    tile: "border-info/30 bg-info/8 hover:bg-info/12",
    ink: "text-info",
  },
  actions: {
    Icon: ListChecks,
    chip: "bg-accent text-accent-foreground",
    bar: "border-l-primary",
    tile: "border-primary/25 bg-primary/6 hover:bg-primary/10",
    ink: "text-primary",
  },
  reminders: {
    Icon: BellRing,
    chip: "bg-warning/12 text-warning",
    bar: "border-l-warning",
    tile: "border-warning-border bg-warning-surface hover:bg-warning/12",
    ink: "text-warning",
  },
} as const satisfies Record<string, { Icon: LucideIcon; chip: string; bar: string; tile: string; ink: string }>;

type ToneKey = keyof typeof TONE;

/** A coloured card: icon, plain-language title, one line saying what the section is, a count. */
function ResultSection({
  id,
  tone,
  title,
  hint,
  count,
  children,
}: {
  id: string;
  tone: ToneKey;
  title: string;
  hint: string;
  count: number;
  children: React.ReactNode;
}) {
  const t = TONE[tone];
  return (
    <section
      id={id}
      className={cn(
        "scroll-mt-8 rounded-xl border border-l-4 border-border-subtle bg-card p-5",
        t.bar
      )}
    >
      <header className="mb-4 flex items-start gap-3">
        <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-xl", t.chip)}>
          <t.Icon className="size-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="font-medium text-ink">{title}</h2>
          <p className="text-sm text-muted-foreground">{hint}</p>
        </div>
        <span className={cn("rounded-full px-2.5 py-0.5 text-sm font-semibold tabular-nums", t.chip)}>
          {count}
        </span>
      </header>
      {children}
    </section>
  );
}

function Initial({ name, tone }: { name: string; tone: ToneKey }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold",
        TONE[tone].chip
      )}
    >
      {name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}

export function NoteBatchResultView({
  batchId,
  status,
  anchorIso,
  anchorBasis,
  result,
  reminderStatus,
  reminderDetails,
  contactNames,
}: {
  batchId: string;
  status: "saved" | "undone";
  anchorIso: string;
  anchorBasis: "note" | "hint" | "upload";
  result: NoteBatchResult;
  reminderStatus: Record<string, string>;
  reminderDetails: Record<string, NoteBatchReminderDetail>;
  contactNames: Record<string, string>;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [local, setLocal] = useState(reminderStatus);
  const [editingId, setEditingId] = useState<string | null>(null);
  const undone = status === "undone";
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const deleteFocus = useConfirmFocus(confirmingDelete ? "delete" : null);

  function deleteCapture() {
    start(async () => {
      try {
        await deleteNoteBatch(batchId);
        toast.success("Capture deleted");
        router.push("/capture");
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t delete that capture — try again?"));
      }
    });
  }

  function dismiss(id: string) {
    start(async () => {
      try {
        await dismissNoteReminder(id);
        setLocal((s) => ({ ...s, [id]: "dismissed" }));
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t dismiss that — try again?"));
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
        toast.error(friendlyError(err, TOAST_COPY.undoFailed));
      }
    });
  }

  function removeContact(contactId: string) {
    if (!confirm(`Delete this contact? ${CONTACT_DELETE_EXPLAINER}`)) return;
    start(async () => {
      try {
        await deleteContact(contactId);
        toast.success("Contact deleted");
        router.refresh();
      } catch (err) {
        toast.error(friendlyError(err, TOAST_COPY.deleteFailed));
      }
    });
  }

  const mentionCount = result.mentions.length + result.unresolvedMentions.length;
  const summaryTiles: { id: string; tone: ToneKey; label: string; count: number }[] = [
    { id: "batch-people", tone: "people", label: "People", count: result.participants.length },
    { id: "batch-mentions", tone: "mentions", label: "Mentioned", count: mentionCount },
    { id: "batch-actions", tone: "actions", label: "Action items", count: result.actionItems.length },
    { id: "batch-reminders", tone: "reminders", label: "Reminders", count: result.reminders.length },
  ];
  const name = (id: string | null) => (id ? contactNames[id] ?? "Unknown" : "No one");
  const editing = editingId ? result.reminders.find((r) => r.id === editingId) ?? null : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border-subtle bg-surface-inset px-4 py-3 text-sm">
        <span className="text-muted-foreground">
          Relative dates counted from <strong className="text-ink">{anchorIso}</strong> ({ANCHOR_LABEL[anchorBasis]}).
        </span>
        {confirmingDelete ? (
          <span className="flex flex-wrap items-center gap-2">
            <span role="status" className="text-xs text-muted-foreground">
              Delete this capture and its photos? The people and notes it saved stay.
            </span>
            <Button ref={deleteFocus.confirmRef("delete")} variant="destructive" size="sm" disabled={pending} onClick={deleteCapture}>
              {pending ? "Deleting…" : "Delete"}
            </Button>
            <Button variant="ghost" size="sm" disabled={pending} onClick={() => setConfirmingDelete(false)}>
              Cancel
            </Button>
          </span>
        ) : (
          <span className="flex flex-wrap items-center gap-2">
            {undone ? (
              <Badge variant="secondary">Undone</Badge>
            ) : (
              <Button variant="outline" size="sm" disabled={pending} onClick={undo}>Undo this batch</Button>
            )}
            <Button
              ref={deleteFocus.triggerRef("delete")}
              variant="ghost"
              size="sm"
              disabled={pending}
              className="text-muted-foreground hover:text-destructive"
              onClick={() => setConfirmingDelete(true)}
            >
              Delete capture
            </Button>
          </span>
        )}
      </div>

      {result.meeting && (
        <MeetingSummaryCard meeting={result.meeting} sessionId={result.meeting.sessionId} />
      )}

      {/* The whole capture in four numbers. Each tile jumps to its section. */}
      <nav aria-label="What was created" className="grid grid-cols-2 gap-2 sm:grid-cols-[repeat(auto-fit,minmax(9rem,1fr))]">
        {summaryTiles.filter((tile) => tile.count > 0 || tile.id === "batch-people" || tile.id === "batch-reminders").map((tile) => {
          const t = TONE[tile.tone];
          return (
            <a
              key={tile.id}
              href={`#${tile.id}`}
              className={cn(
                "flex flex-col gap-1 rounded-xl border p-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                t.tile
              )}
            >
              <span className={cn("flex items-center gap-1.5 text-xs font-medium", t.ink)}>
                <t.Icon className="size-3.5" aria-hidden />
                {tile.label}
              </span>
              <span className="font-heading text-3xl leading-none text-ink tabular-nums">
                {tile.count}
              </span>
            </a>
          );
        })}
      </nav>

      <ResultSection
        id="batch-people"
        tone="people"
        title="People you spoke to"
        hint="Saved to your contacts, with this conversation logged on each."
        count={result.participants.length}
      >
        {result.participants.length === 0 && (
          <p className="text-sm text-muted-foreground">No one was saved as a contact from this batch.</p>
        )}
        <ul className="space-y-2">
          {result.participants.map((p) => (
            <li
              key={p.contactId}
              className="flex items-center justify-between gap-3 rounded-xl border border-border-subtle px-3 py-2 text-sm"
            >
              <span className="flex min-w-0 items-center gap-3">
                <Initial name={p.name} tone="people" />
                <IntentLink href={`/contacts/${p.contactId}`} className="truncate font-medium text-primary hover:underline">
                  {p.name}
                </IntentLink>
                {p.created && (
                  <Badge tone="success" size="sm">New contact</Badge>
                )}
                {p.duplicate && <Badge tone="neutral" size="sm">Already logged</Badge>}
              </span>
              {p.created && (
                <Button variant="ghost" size="sm" disabled={pending} onClick={() => removeContact(p.contactId)}>
                  Delete contact
                </Button>
              )}
            </li>
          ))}
        </ul>
      </ResultSection>

      {mentionCount > 0 && (
        <ResultSection
          id="batch-mentions"
          tone="mentions"
          title="People mentioned"
          hint="Named in your notes but not part of the conversation. Matched to people you already know where possible."
          count={mentionCount}
        >
          <ul className="space-y-2 text-sm">
            {result.mentions.map((m) => (
              <li
                key={`${m.interactionId}-${m.contactId}`}
                className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-border-subtle px-3 py-2"
              >
                <span className="text-muted-foreground">&ldquo;{m.text}&rdquo;</span>
                <ArrowRight className="size-3.5 text-info" aria-hidden />
                <IntentLink href={`/contacts/${m.contactId}`} className="font-medium text-primary hover:underline">
                  {name(m.contactId)}
                </IntentLink>
                <Badge tone="info" size="sm">
                  {Math.round(m.confidence * 100)}% sure
                </Badge>
              </li>
            ))}
            {result.unresolvedMentions.map((m, index) => (
              <li
                key={`${index}-${m.text}`}
                className="flex items-center justify-between gap-2 rounded-xl border border-dashed border-border-subtle px-3 py-2"
              >
                <span>
                  &ldquo;{m.text}&rdquo;
                  {m.context ? <span className="text-muted-foreground"> — {m.context}</span> : null}
                  <span className="ml-2 text-xs text-muted-foreground">Not in your contacts yet</span>
                </span>
                <Link href="/contacts/new" className="shrink-0 text-xs font-medium text-primary hover:underline">
                  Add as contact
                </Link>
              </li>
            ))}
          </ul>
        </ResultSection>
      )}

      {result.actionItems.length > 0 && (
        <ResultSection
          id="batch-actions"
          tone="actions"
          title="Action items"
          hint="Things someone said they would do. Ones with a date became reminders."
          count={result.actionItems.length}
        >
          <ul className="space-y-2">
            {result.actionItems.map((a) => (
              <li key={a.id} className="flex items-start justify-between gap-3 rounded-xl border border-border-subtle px-3 py-2 text-sm">
                <span className="flex min-w-0 items-start gap-2.5">
                  <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                  <span>
                    <span className="block">{a.text}</span>
                    <span className="text-xs text-muted-foreground">For {name(a.contactId)}</span>
                  </span>
                </span>
                {a.reminderId ? (
                  <Badge tone="success" size="sm" className="shrink-0">
                    <BellRing aria-hidden /> Reminder set
                  </Badge>
                ) : (
                  <Badge tone="neutral" size="sm" className="shrink-0">No reminder</Badge>
                )}
              </li>
            ))}
          </ul>
        </ResultSection>
      )}

      <ResultSection
        id="batch-reminders"
        tone="reminders"
        title="Reminders created"
        hint="Follow-ups Orbit set for you, with the date it picked. Edit or dismiss any that look off."
        count={result.reminders.length}
      >
        {result.reminders.length === 0 ? (
          <p className="text-sm text-muted-foreground">No reminders came out of these notes.</p>
        ) : (
          <ul className="space-y-2">
            {result.reminders.map((r) => {
              const st = local[r.id] ?? "pending";
              return (
                <li key={r.id} className="flex items-start justify-between gap-3 rounded-xl border border-border-subtle px-3 py-2 text-sm">
                  <div className="min-w-0">
                    <p className={st !== "pending" ? "line-through text-muted-foreground" : "font-medium"}>{r.title}</p>
                    <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                      <Badge tone="warning" size="sm">
                        <CalendarDays aria-hidden /> {r.dueIso}
                      </Badge>
                      <span>{name(r.contactId)}</span>
                      {r.dateBasis !== "absolute" && <span>· {BASIS_LABEL[r.dateBasis]} {anchorIso}</span>}
                      {r.rawDatePhrase && <span>· &ldquo;{r.rawDatePhrase}&rdquo;</span>}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {st === "pending" ? (
                      <>
                        <Button variant="ghost" size="sm" disabled={pending} onClick={() => setEditingId(r.id)}>Edit</Button>
                        <Button variant="ghost" size="sm" disabled={pending} onClick={() => dismiss(r.id)}>Dismiss</Button>
                      </>
                    ) : (
                      <Badge variant="secondary" className="text-3xs capitalize">{st}</Badge>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {(result.skipped.relative + result.skipped.unverifiable + result.skipped.past + result.skipped.duplicate) > 0 && (
          <p className="mt-3 text-xs text-muted-foreground">
            Left out: {result.skipped.past} already past, {result.skipped.relative} unclear timing, {result.skipped.unverifiable} unverifiable, {result.skipped.duplicate} already logged.
          </p>
        )}
      </ResultSection>

      {/* One dialog for the whole list, keyed by the row being edited — the form seeds
          itself from `initial` on open, and calls router.refresh() after saving. */}
      {editing && (
        <ReminderFormDialog
          key={editing.id}
          open
          onOpenChange={(next) => { if (!next) setEditingId(null); }}
          mode="edit"
          lists={[]}
          defaultListId={reminderDetails[editing.id]?.listId ?? null}
          initial={{
            id: editing.id,
            title: editing.title,
            description: reminderDetails[editing.id]?.description ?? null,
            // Local noon, like every other date in this app: a bare `YYYY-MM-DD` parses
            // as UTC midnight and reads back a day early west of Greenwich.
            dueDate: `${editing.dueIso}T12:00:00`,
            listId: reminderDetails[editing.id]?.listId ?? null,
            contactId: editing.contactId,
            actionKind: reminderDetails[editing.id]?.actionKind ?? "auto",
          }}
        />
      )}

      <div className="flex gap-2">
        <Link href={result.meeting ? "/capture?mode=meeting" : "/capture"}>
          <Button variant="outline" size="sm">{result.meeting ? "Record another meeting" : "Paste more notes"}</Button>
        </Link>
        <Link href="/reminders"><Button variant="ghost" size="sm">Open reminders</Button></Link>
      </div>
    </div>
  );
}
