"use client";

import { useRef, useState, useTransition } from "react";
import { ArrowRight, BellRing, CalendarDays, Check, MoreHorizontal } from "lucide-react";
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
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
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

/** A plain card: the house heading with its count, then one line saying what the section is. */
function ResultSection({
  title,
  hint,
  count,
  children,
}: {
  title: string;
  hint: React.ReactNode;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-border/70 bg-card p-5">
      <header className="mb-4 space-y-1">
        <h2 className="text-sm font-medium text-ink">
          {title} <span className="font-normal tabular-nums text-muted-foreground">· {count}</span>
        </h2>
        <div className="text-sm text-muted-foreground">{hint}</div>
      </header>
      {children}
    </section>
  );
}

/**
 * Undo and Delete for a whole capture, behind a ⋯. Delete still takes a second step: the
 * menu opens an inline confirm on its own line beside the trigger (so the parent should be a
 * wrapping flex row), and focus moves to it and back, as every two-step delete in the app does.
 */
export function NoteBatchActions({
  batchId,
  status,
  onUndone,
}: {
  batchId: string;
  status: "saved" | "undone";
  /** After a successful undo, before the refresh lands. */
  onUndone?: () => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const deleteFocus = useConfirmFocus(confirmingDelete ? "delete" : null);
  // The menu hands focus back to its trigger as it closes; when Delete opened the confirm,
  // focus belongs on the confirm instead.
  const askedDelete = useRef(false);

  function undo() {
    start(async () => {
      try {
        const out = await undoNoteBatch(batchId);
        onUndone?.();
        toast.success(`Undone: ${out.remindersDismissed} reminders dismissed`);
        router.refresh();
      } catch (err) {
        toast.error(friendlyError(err, TOAST_COPY.undoFailed));
      }
    });
  }

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

  function cancelDelete() {
    askedDelete.current = false;
    setConfirmingDelete(false);
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          ref={deleteFocus.triggerRef("delete")}
          disabled={pending}
          render={
            <Button variant="ghost" size="icon-sm" aria-label="Capture options" className="tap-target relative shrink-0">
              <MoreHorizontal aria-hidden />
            </Button>
          }
        />
        <DropdownMenuContent align="end" className="w-auto min-w-44" finalFocus={() => !askedDelete.current}>
          {status === "saved" && (
            <>
              <DropdownMenuItem onClick={undo}>Undo this batch</DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuItem
            variant="destructive"
            onClick={() => {
              askedDelete.current = true;
              setConfirmingDelete(true);
            }}
          >
            Delete capture
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {confirmingDelete && (
        <div className="flex basis-full flex-wrap items-center gap-2 rounded-xl border border-border/70 bg-muted/30 px-3 py-2">
          <span role="status" className="mr-auto text-sm text-muted-foreground">
            Delete this capture and its photos? The people and notes it saved stay.
          </span>
          <Button ref={deleteFocus.confirmRef("delete")} variant="destructive" size="sm" disabled={pending} onClick={deleteCapture}>
            {pending ? "Deleting…" : "Delete"}
          </Button>
          <Button variant="ghost" size="sm" disabled={pending} onClick={cancelDelete}>
            Cancel
          </Button>
        </div>
      )}
    </>
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
  embedded = false,
}: {
  /**
   * Inside a meeting's page: that page already shows the summary and its own way back, but
   * no capture header, so the view brings its own heading with the Undo/Delete menu.
   */
  embedded?: boolean;
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
  const [confirmingContact, setConfirmingContact] = useState<string | null>(null);
  const contactFocus = useConfirmFocus(confirmingContact);

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

  // The undo only dismisses reminders still pending; the refresh brings the rest.
  const markUndone = () =>
    setLocal((s) => Object.fromEntries(Object.entries(s).map(([id, st]) => [id, st === "pending" ? "dismissed" : st])));

  function removeContact(contactId: string) {
    start(async () => {
      try {
        await deleteContact(contactId);
        setConfirmingContact(null);
        toast.success("Contact deleted");
        router.refresh();
      } catch (err) {
        toast.error(friendlyError(err, TOAST_COPY.deleteFailed));
      }
    });
  }

  const mentionCount = result.mentions.length + result.unresolvedMentions.length;
  const name = (id: string | null) => (id ? contactNames[id] ?? "Unknown" : "No one");
  const editing = editingId ? result.reminders.find((r) => r.id === editingId) ?? null : null;

  return (
    <div className="space-y-4">
      {/* Inside a meeting's page, which has no capture header: the ⋯ sits on this heading. */}
      {embedded && (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="font-[family-name:var(--font-display)] text-xl text-ink">Saved to your network</h2>
            {status === "undone" && <Badge variant="secondary">Undone</Badge>}
          </div>
          <NoteBatchActions batchId={batchId} status={status} onUndone={markUndone} />
        </div>
      )}

      {result.meeting && !embedded && (
        <MeetingSummaryCard meeting={result.meeting} sessionId={result.meeting.sessionId} />
      )}

      <ResultSection
        title="People you spoke to"
        hint="Saved to your contacts, with this conversation logged on each."
        count={result.participants.length}
      >
        {result.participants.length === 0 ? (
          <EmptyState headingLevel={3} title="No one was saved as a contact from this batch." className="py-4" />
        ) : (
          <ul className="space-y-2">
            {result.participants.map((p) => (
              <li
                key={p.contactId}
                className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-xl border border-border/60 px-3 py-2 text-sm"
              >
                <span className="flex min-w-0 items-center gap-3">
                  <ContactAvatar contactId={p.contactId} fullName={p.name} size="sm" className="size-8 shrink-0" />
                  <IntentLink href={`/contacts/${p.contactId}`} className="truncate font-medium text-primary hover:underline">
                    {p.name}
                  </IntentLink>
                  {p.created && <Badge variant="secondary" className="text-3xs">New contact</Badge>}
                  {p.duplicate && <Badge variant="outline" className="text-3xs">Already logged</Badge>}
                </span>
                {p.created && (
                  <Button
                    ref={contactFocus.triggerRef(p.contactId)}
                    variant="ghost"
                    size="sm"
                    disabled={pending}
                    onClick={() => setConfirmingContact(p.contactId)}
                  >
                    Delete contact
                  </Button>
                )}
                {confirmingContact === p.contactId && (
                  <div className="flex basis-full flex-wrap items-center gap-2 border-t border-border/60 pt-2">
                    <span role="status" className="mr-auto text-xs text-muted-foreground">
                      Delete this contact? {CONTACT_DELETE_EXPLAINER}
                    </span>
                    <Button
                      ref={contactFocus.confirmRef(p.contactId)}
                      variant="destructive"
                      size="sm"
                      disabled={pending}
                      onClick={() => removeContact(p.contactId)}
                    >
                      {pending ? "Deleting…" : "Delete"}
                    </Button>
                    <Button variant="ghost" size="sm" disabled={pending} onClick={() => setConfirmingContact(null)}>
                      Cancel
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </ResultSection>

      {mentionCount > 0 && (
        <ResultSection
          title="People mentioned"
          hint="Named in your notes but not part of the conversation. Matched to people you already know where possible."
          count={mentionCount}
        >
          <ul className="space-y-2 text-sm">
            {result.mentions.map((m) => (
              <li
                key={`${m.interactionId}-${m.contactId}`}
                className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-border/60 px-3 py-2"
              >
                <span className="text-muted-foreground">&ldquo;{m.text}&rdquo;</span>
                <ArrowRight className="size-3.5 text-muted-foreground" aria-hidden />
                <IntentLink href={`/contacts/${m.contactId}`} className="font-medium text-primary hover:underline">
                  {name(m.contactId)}
                </IntentLink>
                <Badge variant="outline" className="text-3xs">
                  {Math.round(m.confidence * 100)}% sure
                </Badge>
              </li>
            ))}
            {result.unresolvedMentions.map((m, index) => (
              <li
                key={`${index}-${m.text}`}
                className="flex items-center justify-between gap-2 rounded-xl border border-dashed border-border/70 px-3 py-2"
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
          title="Action items"
          hint="Things someone said they would do. Ones with a date became reminders."
          count={result.actionItems.length}
        >
          <ul className="space-y-2">
            {result.actionItems.map((a) => (
              <li key={a.id} className="flex items-start justify-between gap-3 rounded-xl border border-border/60 px-3 py-2 text-sm">
                <span className="flex min-w-0 items-start gap-2.5">
                  <Check className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span>
                    <span className="block">{a.text}</span>
                    <span className="text-xs text-muted-foreground">For {name(a.contactId)}</span>
                  </span>
                </span>
                {a.reminderId ? (
                  <Badge variant="secondary" className="shrink-0 text-3xs">
                    <BellRing aria-hidden /> Reminder set
                  </Badge>
                ) : (
                  <Badge variant="outline" className="shrink-0 text-3xs">No reminder</Badge>
                )}
              </li>
            ))}
          </ul>
        </ResultSection>
      )}

      <ResultSection
        title="Reminders created"
        hint={
          <>
            <p>Follow-ups Orbit set for you, with the date it picked. Edit or dismiss any that look off.</p>
            <p className="text-xs">
              Relative dates counted from <span className="font-medium text-ink">{anchorIso}</span> ({ANCHOR_LABEL[anchorBasis]}).
            </p>
          </>
        }
        count={result.reminders.length}
      >
        {result.reminders.length === 0 ? (
          <EmptyState headingLevel={3} title="No reminders came out of these notes." className="py-4" />
        ) : (
          <ul className="space-y-2">
            {result.reminders.map((r) => {
              const st = local[r.id] ?? "pending";
              return (
                <li key={r.id} className="flex items-start justify-between gap-3 rounded-xl border border-border/60 px-3 py-2 text-sm">
                  <div className="min-w-0">
                    <p className={st !== "pending" ? "line-through text-muted-foreground" : "font-medium"}>{r.title}</p>
                    <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                      <Badge variant="outline">
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

      {!embedded && (
        <div className="flex gap-2">
          <Link href={result.meeting ? "/meetings" : "/capture"} className={buttonVariants({ variant: "outline", size: "sm" })}>
            {result.meeting ? "Record another meeting" : "Paste more notes"}
          </Link>
          <Link href="/reminders" className={buttonVariants({ variant: "ghost", size: "sm" })}>
            Open reminders
          </Link>
        </div>
      )}
    </div>
  );
}
