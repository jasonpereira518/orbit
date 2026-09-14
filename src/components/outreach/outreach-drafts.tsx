"use client";
import { useState, useTransition } from "react";
import { motion, useReducedMotion } from "motion/react";
import { ChevronLeft, ChevronRight, RefreshCw, Send } from "lucide-react";
import * as actions from "@/actions/outreach-v2";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogHeader,
} from "@/components/ui/dialog";
import { fullBody } from "@/lib/outreach-v2/policy";
import { Evidence } from "./outreach-evidence";
import { EmptyState, SplitView, ListRow, Status } from "./outreach-ui";
import {
  draftValues,
  draftIsDirty,
  type Draft,
  type DraftEdit,
  type DraftEdits,
} from "./outreach-workspace-types";

export function DraftEditor({
  message: m,
  edit,
  onEdit,
  onSaved,
  onError,
}: {
  message: Draft;
  edit?: DraftEdit;
  onEdit: (edit: DraftEdit | undefined) => void;
  onSaved: () => Promise<void>;
  onError: (error: string) => void;
}) {
  const [pending, start] = useTransition();
  const reduced = useReducedMotion();
  const values = edit ?? draftValues(m),
    dirty = draftIsDirty(m, edit);
  const invitation = m.channel === "linkedin" && m.messageKind === "initial";
  const limit = Math.min(300, m.senderSnapshot?.invitationLimit ?? 200);
  const patch = (value: Partial<DraftEdit>) => onEdit({ ...values, ...value });
  return (
    <motion.section
      initial={reduced ? false : { opacity: 0.6, x: 10 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ type: "spring", stiffness: 420, damping: 32 }}
      className="min-w-0 p-5 sm:p-6"
      aria-label={`Draft for ${m.person.fullName}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-medium text-ink">{m.person.fullName}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {m.person.title} · {m.person.company}
          </p>
        </div>
        <Status success={!dirty && m.approvedRevision === m.revision}>
          {dirty
            ? "Unsaved changes"
            : m.approvedRevision === m.revision
              ? "Approved"
              : "Needs review"}
        </Status>
      </div>
      <p className="mt-4 break-all text-xs text-muted-foreground">
        Sending as{" "}
        {m.senderSnapshot?.address ?? "Choose a sender by regenerating"}
      </p>
      {edit && edit.revision !== m.revision && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          A newer revision is available. Your edits are preserved. Copy any text
          you need, then{" "}
          <button className="underline" onClick={() => onEdit(undefined)}>
            load the saved revision
          </button>{" "}
          before editing again.
        </p>
      )}
      <fieldset disabled={pending} className="mt-5 space-y-4">
        <label className="block space-y-2 text-sm">
          <span className="font-medium">To</span>
          <Input
            value={values.toAddress}
            readOnly={m.channel === "linkedin" || m.messageKind !== "initial"}
            maxLength={300}
            onChange={(e) => patch({ toAddress: e.target.value })}
          />
        </label>
        {m.channel === "email" && (
          <label className="block space-y-2 text-sm">
            <span className="font-medium">Subject</span>
            <Input
              value={values.subject}
              readOnly={m.messageKind === "reply"}
              maxLength={250}
              onChange={(e) => patch({ subject: e.target.value })}
            />
          </label>
        )}
        <label className="block space-y-2 text-sm">
          <span className="font-medium">
            {invitation ? "Connection note" : "Message"}
          </span>
          <Textarea
            className="min-h-56 resize-y bg-background text-base leading-relaxed"
            value={values.body}
            maxLength={5000}
            onChange={(e) => patch({ body: e.target.value })}
            aria-invalid={invitation && values.body.length > limit}
            aria-describedby={invitation ? `counter-${m.id}` : undefined}
          />
        </label>
        {invitation && (
          <p
            id={`counter-${m.id}`}
            className={`text-right text-xs ${values.body.length > limit ? "text-destructive" : "text-muted-foreground"}`}
          >
            {values.body.length} / {limit} characters
          </p>
        )}
        {m.channel === "email" && (
          <label className="block space-y-2 text-sm">
            <span className="font-medium">Signature</span>
            <Textarea
              rows={2}
              value={values.signature}
              maxLength={2000}
              onChange={(e) => patch({ signature: e.target.value })}
            />
          </label>
        )}
      </fieldset>
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <Button
          variant="ghost"
          disabled={pending || dirty}
          onClick={() =>
            start(async () => {
              try {
                await actions.draftOutreachMessages(
                  m.person.campaignId,
                  [m.person.id],
                  "Regenerate with a fresh, specific opening",
                  m.messageKind as "initial" | "follow_up" | "reply",
                );
                await onSaved();
              } catch (e) {
                onError(
                  e instanceof Error ? e.message : "Could not regenerate.",
                );
              }
            })
          }
        >
          <RefreshCw size={14} />
          Regenerate
        </Button>
        <Button
          disabled={
            pending ||
            !dirty ||
            edit?.revision !== m.revision ||
            (invitation && values.body.length > limit)
          }
          onClick={() =>
            start(async () => {
              try {
                await actions.saveOutreachDraft(m.id, values.revision, values);
                await onSaved();
                onEdit(undefined);
              } catch (e) {
                onError(
                  e instanceof Error ? e.message : "Could not save draft.",
                );
              }
            })
          }
        >
          {pending ? "Saving…" : "Save changes"}
        </Button>
      </div>
      <details className="mt-6 border-t pt-4">
        <summary className="cursor-pointer text-sm font-medium">
          Personalization evidence
        </summary>
        <div className="mt-4">
          <Evidence person={m.person} />
        </div>
      </details>
    </motion.section>
  );
}

export function DraftList({
  drafts,
  activeId,
  onActive,
  selected,
  onToggle,
  edits,
  onEdit,
  onSaved,
  onError,
}: {
  drafts: Draft[];
  activeId: string | null;
  onActive: (id: string | null) => void;
  selected: Set<string>;
  onToggle: (id: string) => void;
  edits: DraftEdits;
  onEdit: (id: string, edit: DraftEdit | undefined) => void;
  onSaved: () => Promise<void>;
  onError: (error: string) => void;
}) {
  const active = drafts.find((m) => m.id === activeId) ?? drafts[0];
  const index = drafts.findIndex((m) => m.id === active?.id);
  if (!active)
    return (
      <EmptyState title="A thoughtful introduction starts here">
        Select people in the People tab to generate your first drafts. They’ll
        appear here as they’re ready.
      </EmptyState>
    );
  return (
    <SplitView
      active={activeId !== null}
      onBack={() => onActive(null)}
      label="drafts"
      list={
        <ul className="divide-y">
          {drafts.map((m) => (
            <li key={m.id} className="flex items-start">
              <input
                className="ml-4 mt-5 size-4 shrink-0 accent-primary"
                type="checkbox"
                aria-label={`Select draft for ${m.person.fullName}`}
                checked={selected.has(m.id)}
                onChange={() => onToggle(m.id)}
              />
              <ListRow
                name={m.person.fullName}
                detail={edits[m.id]?.subject || m.subject || m.body}
                active={active.id === m.id}
                onClick={() => onActive(m.id)}
                trailing={
                  <Status
                    success={
                      !draftIsDirty(m, edits[m.id]) &&
                      m.approvedRevision === m.revision
                    }
                  >
                    {draftIsDirty(m, edits[m.id])
                      ? "Unsaved"
                      : m.approvedRevision === m.revision
                        ? "Approved"
                        : "Needs review"}
                  </Status>
                }
              />
            </li>
          ))}
        </ul>
      }
    >
      <div className="flex items-center justify-between border-b px-5 py-3 text-xs text-muted-foreground">
        <span>
          {index + 1} of {drafts.length} drafts
        </span>
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Previous draft"
            disabled={index < 1}
            onClick={() => onActive(drafts[index - 1].id)}
          >
            <ChevronLeft size={16} />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Next draft"
            disabled={index + 1 >= drafts.length}
            onClick={() => onActive(drafts[index + 1].id)}
          >
            <ChevronRight size={16} />
          </Button>
        </div>
      </div>
      <DraftEditor
        key={active.id}
        message={active}
        edit={edits[active.id]}
        onEdit={(edit) => onEdit(active.id, edit)}
        onSaved={onSaved}
        onError={onError}
      />
    </SplitView>
  );
}

export function SendReview({
  open,
  onOpenChange,
  chosen,
  disabled,
  pending,
  onSend,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  chosen: Draft[];
  disabled: boolean;
  pending: boolean;
  onSend: () => void;
}) {
  const [previewId, setPreviewId] = useState<string | null>(null);
  const active = chosen.find((m) => m.id === previewId) ?? chosen[0];
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!pending) onOpenChange(value);
      }}
    >
      <DialogContent
        className="flex max-h-[90dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl"
        showCloseButton={!pending}
      >
        <DialogHeader className="p-6 pr-12">
          <DialogTitle className="text-2xl">Review your send</DialogTitle>
          <DialogDescription>
            {chosen.length} approved{" "}
            {chosen.length === 1 ? "message" : "messages"} ·{" "}
            {active?.senderSnapshot?.address}
            <br />
            {active?.senderSnapshot?.transport?.replaceAll("_", " ")} · Email
            queues are paced at up to 50 per day.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto border-y">
          <SplitView
            active={previewId !== null}
            onBack={() => setPreviewId(null)}
            label="recipients"
            list={
              <div>
                {chosen.map((m) => (
                  <ListRow
                    key={m.id}
                    name={m.person.fullName}
                    detail={m.toAddress}
                    active={m.id === active?.id}
                    onClick={() => setPreviewId(m.id)}
                  />
                ))}
              </div>
            }
          >
            {active && (
              <article className="space-y-4 p-6">
                <p className="break-all text-sm">
                  <span className="text-muted-foreground">To </span>
                  {active.toAddress}
                </p>
                <h3 className="font-medium">
                  {active.subject || "LinkedIn invitation"}
                </h3>
                <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                  {fullBody(active.body, active.signature, active.channel)}
                </p>
              </article>
            )}
          </SplitView>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 p-5">
          <p className="max-w-sm text-xs text-muted-foreground">
            Only the approved content shown here will be sent. You can pause the
            queue at any time.
          </p>
          <Button
            disabled={pending || disabled || !chosen.length}
            onClick={onSend}
          >
            <Send size={15} />
            {pending
              ? "Queueing…"
              : `Queue ${chosen.length} ${chosen.length === 1 ? "message" : "messages"}`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
