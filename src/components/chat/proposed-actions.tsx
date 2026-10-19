"use client";

import {
  AlarmClock,
  Bell,
  Calendar,
  CalendarPlus,
  Check,
  CircleCheck,
  ListChecks,
  Loader2,
  MessageCircle,
  NotebookPen,
  Tag,
  Trash2,
  Undo2,
  UserPen,
  UserPlus,
  X,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { commitProposedAction, dismissProposedAction, undoProposedAction } from "@/actions/chat-actions";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import { Button } from "@/components/ui/button";
import type { StoredProposedAction } from "@/lib/chat-proposed-actions";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { integrationHref } from "@/components/settings/sections";

type LegacyKind = Exclude<StoredProposedAction["args"]["kind"], "tool">;

const ICON: Record<LegacyKind, typeof NotebookPen> = {
  log_interaction: NotebookPen,
  create_reminder: Bell,
  schedule_follow_up: Calendar,
  update_contact: UserPen,
  create_contact: UserPlus,
  complete_reminder: CircleCheck,
  snooze_reminder: AlarmClock,
};

/** Icons for the chat writes (`CHAT_WRITES` in @/lib/tools/chat-writes), by tool name. */
const TOOL_ICON: Record<string, typeof NotebookPen> = {
  log_note: NotebookPen,
  update_contact: UserPen,
  add_tags: Tag,
  remove_tags: Tag,
  create_contact: UserPlus,
  delete_contact: Trash2,
  complete_action_item: ListChecks,
  create_reminder: Bell,
  complete_reminder: CircleCheck,
  snooze_reminder: AlarmClock,
  reschedule_reminder: AlarmClock,
  delete_reminder: Trash2,
  schedule_follow_up: Calendar,
  create_event: CalendarPlus,
  mark_spoke_to: MessageCircle,
  delete_event: Trash2,
};

const RESULT_HREF: Record<LegacyKind, (resultId: string) => string | null> = {
  log_interaction: () => null,
  create_reminder: () => "/reminders",
  schedule_follow_up: () => "/reminders",
  update_contact: (id) => `/contacts/${id}`,
  create_contact: (id) => `/contacts/${id}`,
  complete_reminder: () => "/reminders",
  snooze_reminder: () => "/reminders",
};

function contactIdOf(action: StoredProposedAction): string | null {
  if (action.args.kind === "tool") return action.contactId ?? null;
  return "contactId" in action.args ? (action.args.contactId ?? null) : null;
}

function hrefOf(action: StoredProposedAction): string | null {
  if (action.args.kind === "tool") return action.href ?? null;
  return action.resultId ? RESULT_HREF[action.args.kind](action.resultId) : null;
}

/** Commit one proposal and report the state the server settled it in. */
async function commitOne(messageId: string, action: StoredProposedAction): Promise<StoredProposedAction> {
  try {
    const res = await commitProposedAction(messageId, action.id);
    if (res.ok) return { ...action, status: "done", resultId: res.resultId ?? null };
    toast.error(res.reason);
  } catch {
    toast.error("Couldn’t do that — try again?");
  }
  return { ...action, status: "proposed" };
}

/**
 * A card per change a chat answer proposed, with the exact sentence of what will happen.
 * Confirm is the only path to the real write; Dismiss and a reload leave it untouched. A done
 * card whose commit stored an inverse offers Undo. A destructive one says what will be lost.
 *
 * Local `busy` covers the click-to-response gap; what persists is the row's own `status`,
 * passed back from the server on success and failure, so a reload shows the true state.
 */
export function ProposedActionsCard({
  messageId,
  action,
  contactName,
  onSettled,
}: {
  messageId: string;
  action: StoredProposedAction;
  /** From `chat-panel`'s own retrieval-grounded map — absent for an action naming nobody. */
  contactName?: string | null;
  onSettled: (next: StoredProposedAction) => void;
}) {
  const [busy, setBusy] = useState(false);
  const Icon = action.args.kind === "tool" ? (TOOL_ICON[action.args.tool] ?? NotebookPen) : ICON[action.args.kind];
  const contactId = contactIdOf(action);
  const destructive = Boolean(action.destructive);

  async function confirm() {
    if (busy || action.status !== "proposed") return;
    setBusy(true);
    try {
      onSettled(await commitOne(messageId, action));
    } finally {
      setBusy(false);
    }
  }

  async function dismiss() {
    if (busy || action.status !== "proposed") return;
    setBusy(true);
    try {
      const res = await dismissProposedAction(messageId, action.id);
      if (res.ok) onSettled({ ...action, status: "dismissed" });
      else toast.error(res.reason);
    } catch {
      toast.error("Couldn’t dismiss that — try again?");
    } finally {
      setBusy(false);
    }
  }

  async function undo() {
    if (busy || action.status !== "done" || !action.undo) return;
    setBusy(true);
    try {
      const res = await undoProposedAction(messageId, action.id);
      if (res.ok) onSettled({ ...action, status: "undone" });
      else toast.error(res.reason);
    } catch {
      toast.error("Couldn’t undo that — try again?");
    } finally {
      setBusy(false);
    }
  }

  const resultHref = hrefOf(action);

  return (
    <div
      className={cn(
        "flex items-start gap-2.5 rounded-xl border bg-background p-3",
        destructive && action.status === "proposed" ? "border-destructive/40" : "border-border/70"
      )}
    >
      {contactId ? (
        <ContactAvatar
          contactId={contactId}
          fullName={contactName ?? ""}
          profileImageUrl={null}
          size="sm"
          className="size-8 shrink-0"
        />
      ) : (
        <span
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-full",
            destructive ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground"
          )}
        >
          <Icon className="size-4" aria-hidden />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <p className="text-xs leading-snug text-foreground">{action.preview}</p>
        <div className="mt-2 flex items-center gap-2">
          {action.status === "proposed" && (
            <>
              <Button
                type="button"
                size="sm"
                variant={destructive ? "destructive" : "default"}
                onClick={confirm}
                disabled={busy}
                aria-label={`${destructive ? "Confirm and delete" : "Confirm"}: ${action.preview}`}
              >
                {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Check className="size-3.5" aria-hidden />}
                {destructive ? "Delete" : "Confirm"}
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={dismiss} disabled={busy} aria-label={`Dismiss: ${action.preview}`}>
                <X className="size-3.5" aria-hidden />
                Dismiss
              </Button>
            </>
          )}
          {action.status === "committing" && (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" aria-hidden /> Working…
            </span>
          )}
          {action.status === "done" && (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Check className="size-3.5 text-primary" aria-hidden />
              {action.autoApplied ? "Done for you" : "Done"}
              {resultHref && (
                <>
                  {" · "}
                  <Link href={resultHref} className="text-primary underline underline-offset-2">
                    View
                  </Link>
                </>
              )}
              {action.undo && (
                <>
                  {" · "}
                  <button
                    type="button"
                    onClick={undo}
                    disabled={busy}
                    className="inline-flex items-center gap-1 text-primary underline underline-offset-2 disabled:opacity-50"
                    aria-label={`Undo: ${action.preview}`}
                  >
                    {busy ? <Loader2 className="size-3 animate-spin" aria-hidden /> : <Undo2 className="size-3" aria-hidden />}
                    Undo
                  </button>
                </>
              )}
            </span>
          )}
          {action.status === "undoing" && (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" aria-hidden /> Undoing…
            </span>
          )}
          {action.status === "undone" && <span className="text-xs text-muted-foreground">Undone</span>}
          {action.status === "dismissed" && <span className="text-xs text-muted-foreground">Dismissed</span>}
        </div>
      </div>
    </div>
  );
}

/**
 * The answer's cards, with Confirm all when there are two or more waiting. Confirm all commits
 * them one at a time, never a destructive one, and stops at the first that fails — what was
 * done stays done, the rest stay waiting.
 */
export function ProposedActionsList({
  messageId,
  actions,
  nameById,
  onSettled,
}: {
  messageId: string;
  actions: StoredProposedAction[];
  nameById: ReadonlyMap<string, string>;
  onSettled: (actionId: string, next: StoredProposedAction) => void;
}) {
  const [running, setRunning] = useState<{ done: number; of: number } | null>(null);
  const waiting = actions.filter((a) => a.status === "proposed" && !a.destructive);
  const anyAutoApplied = actions.some((a) => a.autoApplied);

  async function confirmAll() {
    if (running || waiting.length < 2) return;
    setRunning({ done: 0, of: waiting.length });
    try {
      for (const [i, action] of waiting.entries()) {
        const next = await commitOne(messageId, action);
        onSettled(action.id, next);
        if (next.status !== "done") break;
        setRunning({ done: i + 1, of: waiting.length });
      }
    } finally {
      setRunning(null);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {anyAutoApplied && (
        <p className="text-xs text-muted-foreground">
          Chat made the small changes below itself, as you allowed — each has Undo.{" "}
          <Link href={integrationHref("ai")} className="text-primary underline underline-offset-2">
            Change this
          </Link>
        </p>
      )}
      {waiting.length >= 2 && (
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" variant="secondary" onClick={confirmAll} disabled={Boolean(running)}>
            {running ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Check className="size-3.5" aria-hidden />}
            {running ? `Confirming ${running.done + 1} of ${running.of}…` : `Confirm all (${waiting.length})`}
          </Button>
          <span className="sr-only" role="status" aria-live="polite">
            {running ? `Confirmed ${running.done} of ${running.of}` : ""}
          </span>
        </div>
      )}
      {actions.map((action) => {
        const contactId = contactIdOf(action);
        return (
          <ProposedActionsCard
            key={action.id}
            messageId={messageId}
            action={action}
            contactName={contactId ? nameById.get(contactId) : null}
            onSettled={(next) => onSettled(action.id, next)}
          />
        );
      })}
    </div>
  );
}
