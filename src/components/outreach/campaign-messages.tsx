"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, Loader2 } from "lucide-react";
import {
  checkReplies,
  confirmLinkedInSent,
  copyLinkedIn,
  draftFollowUp,
  draftMessages,
  markWentOut,
  sendMessages,
} from "@/actions/outreach-messages";
import { MessageEditorRow } from "@/components/outreach/message-editor-row";
import { OutcomeControls } from "@/components/outreach/outcome-controls";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RelativeTime } from "@/components/ui/relative-time";
import { friendlyError } from "@/lib/errors";
import {
  SENDABLE_STATUSES,
  copyBlockedReason,
  draftedLine,
  linkedInOpenUrl,
  messageGroups,
  sendSummary,
  type MessageGroups,
  type ReadyItem,
  type SendLine,
  type SentItem,
  type ViewPerson,
} from "@/lib/outreach-message-view";
import { computeCampaignMetrics, formatReplyRate } from "@/lib/outreach-metrics";
import { BULK_SEND_LIMIT, MAX_DRAFTS_PER_RUN, type OutreachChannel } from "@/lib/outreach-types";
import { toast } from "@/lib/toast";
import { TOAST_COPY } from "@/lib/toast-copy";
import { cn } from "@/lib/utils";

type View = "send" | "sent";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const where = (p: ViewPerson) => [p.title, p.company].filter(Boolean).join(" · ");

/** A copy of `set` with `ids` added (`on`) or removed. */
function toggled(set: Set<string>, ids: string[], on: boolean) {
  const next = new Set(set);
  for (const id of ids) {
    if (on) next.add(id);
    else next.delete(id);
  }
  return next;
}

/**
 * The Messages tab: write, send and follow a campaign’s messages in one place.
 *
 * "To send" is what the user still has to do (write a draft, send it, paste it into LinkedIn);
 * "Sent" is what is out and how it is going. The lists come from `messageGroups`, which is
 * also what keeps Send, Copy and Write follow-up away from anyone who has already answered.
 * Sending email is the one thing here that can’t be taken back, so every path to it is
 * explicit (nothing is pre-selected), single-flight, and refuses text that isn’t saved yet.
 */
export function CampaignMessages({
  campaign,
  channel,
  rows,
  sendCapability,
  canUseAi,
  canSeeReplies,
}: {
  campaign: { id: string };
  channel: OutreachChannel;
  /** The campaign’s people (not the removed ones) with their messages. */
  rows: ViewPerson[];
  /** Who an email goes out as and what is left today; null for a LinkedIn campaign. */
  sendCapability: SendLine | null;
  canUseAi: boolean;
  /** Whether a connected mailbox can be read for replies (email campaigns). */
  canSeeReplies: boolean;
}) {
  const [view, setView] = useState<View>("send");
  const sendTabRef = useRef<HTMLButtonElement>(null);
  const groups = messageGroups(rows, channel);

  const tabs: { value: View; label: string; count: number }[] = [
    { value: "send", label: "To send", count: groups.needsDraft.length + groups.ready.length },
    { value: "sent", label: "Sent", count: groups.sent.length },
  ];

  return (
    <div className="space-y-5">
      <div role="group" aria-label="Messages" className="inline-flex rounded-lg border border-border/60 bg-muted/30 p-1">
        {tabs.map(({ value, label, count }) => (
          <button
            key={value}
            ref={value === "send" ? sendTabRef : undefined}
            type="button"
            aria-pressed={view === value}
            onClick={() => setView(value)}
            className={cn(
              "inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors",
              view === value ? "bg-background text-ink shadow-sm" : "text-muted-foreground hover:text-ink"
            )}
          >
            {label}
            <span className="text-muted-foreground">{count}</span>
          </button>
        ))}
      </div>

      {/* Kept mounted while Sent is open, so edits typed here aren’t lost by looking at Sent. */}
      <div hidden={view !== "send"}>
        <ToSend
          campaignId={campaign.id}
          channel={channel}
          groups={groups}
          sendCapability={sendCapability}
          canUseAi={canUseAi}
        />
      </div>
      {view === "sent" && (
        <SentView
          campaignId={campaign.id}
          channel={channel}
          rows={rows}
          items={groups.sent}
          canUseAi={canUseAi}
          canSeeReplies={canSeeReplies}
          onFollowUpWritten={() => {
            // The button that was pressed is about to go with the Sent view; keep focus on the tabs.
            setView("send");
            sendTabRef.current?.focus();
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ To send ----- */

function ToSend({
  campaignId,
  channel,
  groups,
  sendCapability,
  canUseAi,
}: {
  campaignId: string;
  channel: OutreachChannel;
  groups: MessageGroups;
  sendCapability: SendLine | null;
  canUseAi: boolean;
}) {
  const [selectedDrafts, setSelectedDrafts] = useState<Set<string>>(() => new Set());
  const [selectedSends, setSelectedSends] = useState<Set<string>>(() => new Set());
  const [dirty, setDirty] = useState<Set<string>>(() => new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [drafting, setDrafting] = useState(false);
  const [sending, setSending] = useState(false);
  // State alone is a render behind a fast second click; the ref closes that gap.
  const draftingRef = useRef(false);
  const sendingRef = useRef(false);
  const [status, setStatus] = useState("");
  const [statusWarn, setStatusWarn] = useState(false);
  const [problem, setProblem] = useState("");
  // What the confirm dialog is about to send. Frozen when it opens, so the count in its title is
  // the count that goes, and kept (not cleared) on close so the dialog can finish fading out.
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [batch, setBatch] = useState<{ ids: string[]; from: string }>({ ids: [], from: "" });

  const markDirty = useCallback((messageId: string, isDirty: boolean) => {
    setDirty((prev) => (prev.has(messageId) === isDirty ? prev : toggled(prev, [messageId], isDirty)));
  }, []);
  const setRowError = useCallback((messageId: string, text: string | null) => {
    setErrors((prev) => {
      if (!text) {
        if (!(messageId in prev)) return prev;
        const next = { ...prev };
        delete next[messageId];
        return next;
      }
      return { ...prev, [messageId]: text };
    });
  }, []);

  // Only what is still on the screen counts: a row that went out since is not "selected".
  const draftIds = groups.needsDraft.filter((p) => selectedDrafts.has(p.id)).map((p) => p.id);
  const sendable =
    channel === "email"
      ? groups.ready.filter((r) => r.message.channel === "email" && SENDABLE_STATUSES.includes(r.message.status))
      : [];
  const sendIds = sendable.filter((r) => selectedSends.has(r.message.id)).map((r) => r.message.id);
  const unsaved = sendable.filter((r) => selectedSends.has(r.message.id) && dirty.has(r.message.id));

  async function writeDrafts() {
    if (draftingRef.current || !draftIds.length || draftIds.length > MAX_DRAFTS_PER_RUN) return;
    draftingRef.current = true;
    setDrafting(true);
    setStatus("");
    setStatusWarn(false);
    setProblem("");
    const batch = draftIds;
    try {
      const res = await draftMessages(campaignId, batch);
      if (!res.ok) setProblem(res.error);
      else if (!res.value.drafted) setProblem("Couldn’t write those drafts — try again?");
      else {
        const line = draftedLine(res.value.drafted);
        setStatus(res.value.skipped ? `${line}, ${res.value.skipped} skipped` : line);
        toast.success(line);
        setSelectedDrafts((prev) => toggled(prev, batch, false));
      }
    } catch (err) {
      setProblem(friendlyError(err, "Couldn’t write those drafts — try again?"));
    } finally {
      draftingRef.current = false;
      setDrafting(false);
    }
  }

  // "Send selected" only asks. Nothing goes until the dialog’s own Send.
  function askToSend() {
    if (sendingRef.current || !sendCapability?.ok || !sendIds.length || sendIds.length > BULK_SEND_LIMIT || unsaved.length) {
      return;
    }
    setBatch({ ids: sendIds, from: sendCapability.fromEmail });
    setConfirmOpen(true);
  }

  async function confirmSend() {
    if (sendingRef.current || !batch.ids.length) return;
    sendingRef.current = true;
    setSending(true);
    setStatus("");
    setStatusWarn(false);
    setProblem("");
    const ids = batch.ids;
    try {
      const res = await sendMessages(campaignId, ids);
      if (!res.ok) {
        setProblem(res.error);
        return;
      }
      const result = res.value;
      setErrors((prev) => {
        const next = { ...prev };
        for (const id of ids) delete next[id];
        for (const f of result.failed) next[f.messageId] = f.error;
        return next;
      });
      const summary = sendSummary(result);
      if (summary.tone === "success") toast.success(summary.text);
      else toast.warning(summary.text);
      // Said in the toast and kept on the page, "n not sent yet — send again" included.
      setStatus(summary.text);
      setStatusWarn(summary.tone === "warn");
      // Clear the selection of what went. Which ones a run out of time left behind isn’t
      // reported, so then the whole batch stays: what went leaves the list on its own, and
      // what is left is still ticked for "send again".
      if (!result.notSent) setSelectedSends((prev) => toggled(prev, ids, false));
    } catch (err) {
      setProblem(friendlyError(err, TOAST_COPY.sendFailed));
    } finally {
      // Only now, with the answer in: until then a second click does nothing, and the dialog
      // stays up saying Sending…
      sendingRef.current = false;
      setSending(false);
      setConfirmOpen(false);
    }
  }

  const nothing = !groups.needsDraft.length && !groups.ready.length;
  const peopleTab = `/outreach/${campaignId}?tab=people`;

  return (
    <div className="space-y-6">
      {groups.needsInfo.length > 0 && (
        <p className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
          {groups.needsInfo.length === 1 ? "1 person needs" : `${groups.needsInfo.length} people need`}{" "}
          {channel === "linkedin" ? "a LinkedIn link" : "an email address"} before they can be written to. Add it on the{" "}
          <Link href={peopleTab} className="text-primary underline-offset-2 hover:underline">
            People tab
          </Link>
          .
        </p>
      )}

      {/* Always mounted, so what a draft or a send did is announced and stays in view. */}
      <div aria-live="polite" className="space-y-1 empty:hidden">
        {status && (
          <p className={cn("text-sm", statusWarn ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground")}>
            {status}
          </p>
        )}
        {problem && <p className="text-sm text-destructive">{problem}</p>}
      </div>

      {nothing && (
        <p className="rounded-2xl border border-dashed border-border/70 p-8 text-center text-sm text-muted-foreground">
          Nothing to write or send right now. Find people on the{" "}
          <Link href={peopleTab} className="text-primary underline-offset-2 hover:underline">
            People tab
          </Link>
          , or look at what is already Sent.
        </p>
      )}

      {groups.needsDraft.length > 0 && (
        <section aria-label="People who need a draft" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-medium text-ink">
              Needs a draft <span className="text-muted-foreground">· {groups.needsDraft.length}</span>
            </h2>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                disabled={drafting}
                onClick={() =>
                  setSelectedDrafts(
                    draftIds.length
                      ? new Set()
                      : new Set(groups.needsDraft.slice(0, MAX_DRAFTS_PER_RUN).map((p) => p.id))
                  )
                }
              >
                {draftIds.length
                  ? "Clear selection"
                  : groups.needsDraft.length <= MAX_DRAFTS_PER_RUN
                    ? "Select all"
                    : `Select first ${MAX_DRAFTS_PER_RUN}`}
              </Button>
              <Button
                size="sm"
                onClick={writeDrafts}
                disabled={drafting || !canUseAi || !draftIds.length || draftIds.length > MAX_DRAFTS_PER_RUN}
              >
                {drafting && <Loader2 className="animate-spin" aria-hidden />}
                {drafting ? "Writing drafts…" : draftIds.length ? `Write drafts (${draftIds.length})` : "Write drafts"}
              </Button>
            </div>
          </div>
          {draftIds.length > MAX_DRAFTS_PER_RUN && (
            <p className="text-xs text-muted-foreground">
              Write up to {MAX_DRAFTS_PER_RUN} at a time — untick {draftIds.length - MAX_DRAFTS_PER_RUN}.
            </p>
          )}
          {!canUseAi && (
            <p className="text-xs text-muted-foreground">
              Drafts use your AI key.{" "}
              <Link href="/settings?section=ai" className="text-primary underline-offset-2 hover:underline">
                Add one in Settings
              </Link>
              .
            </p>
          )}
          <ul className="space-y-2">
            {groups.needsDraft.map((person) => (
              <li key={person.id} className="flex items-center gap-3 rounded-2xl border border-border/70 bg-card px-4 py-3">
                <Checkbox
                  checked={selectedDrafts.has(person.id)}
                  onCheckedChange={(v) => setSelectedDrafts((prev) => toggled(prev, [person.id], Boolean(v)))}
                  disabled={drafting}
                  aria-label={`Select ${person.fullName}`}
                />
                <div className="min-w-0">
                  <span className="font-medium text-ink">{person.fullName}</span>
                  {where(person) && <span className="ml-2 text-sm text-muted-foreground">{where(person)}</span>}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {groups.ready.length > 0 && (
        <section aria-label="Messages ready to send" className="space-y-3">
          {channel === "email" && <CapabilityLine line={sendCapability} />}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-medium text-ink">
              {channel === "email" ? "Ready to send" : "Ready to copy"}{" "}
              <span className="text-muted-foreground">· {groups.ready.length}</span>
            </h2>
            {channel === "email" && (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={sending || !sendable.length}
                  onClick={() =>
                    setSelectedSends(
                      sendIds.length ? new Set() : new Set(sendable.slice(0, BULK_SEND_LIMIT).map((r) => r.message.id))
                    )
                  }
                >
                  {sendIds.length
                    ? "Clear selection"
                    : sendable.length <= BULK_SEND_LIMIT
                      ? "Select all"
                      : `Select first ${BULK_SEND_LIMIT}`}
                </Button>
                <Button
                  size="sm"
                  onClick={askToSend}
                  disabled={
                    sending ||
                    !sendCapability?.ok ||
                    !sendIds.length ||
                    sendIds.length > BULK_SEND_LIMIT ||
                    unsaved.length > 0
                  }
                >
                  {sending && <Loader2 className="animate-spin" aria-hidden />}
                  {sending ? "Sending…" : sendIds.length ? `Send selected (${sendIds.length})` : "Send selected"}
                </Button>
              </div>
            )}
          </div>
          {sendCapability?.ok && sendIds.length > sendCapability.remainingToday && sendIds.length <= BULK_SEND_LIMIT && (
            <p className="text-xs text-muted-foreground">
              Only {sendCapability.remainingToday} more can go today — the rest stay as drafts.
            </p>
          )}
          {sendIds.length > BULK_SEND_LIMIT && (
            <p className="text-xs text-muted-foreground">
              Send up to {BULK_SEND_LIMIT} at a time — untick {sendIds.length - BULK_SEND_LIMIT}.
            </p>
          )}
          {unsaved.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Save your changes to {unsaved.map((r) => r.person.fullName).join(", ")} first — what is saved is what gets sent.
            </p>
          )}
          <ul className="space-y-3">
            {groups.ready.map((item) => (
              <ReadyRow
                key={item.message.id}
                item={item}
                campaignId={campaignId}
                channel={channel}
                canUseAi={canUseAi}
                selectable={sendable.includes(item)}
                selected={selectedSends.has(item.message.id)}
                onSelect={(on) => setSelectedSends((prev) => toggled(prev, [item.message.id], on))}
                locked={sending}
                isDirty={dirty.has(item.message.id)}
                error={errors[item.message.id] ?? (item.message.status === "failed" ? item.message.errorMessage : null)}
                onDirtyChange={markDirty}
                onError={setRowError}
              />
            ))}
          </ul>
        </section>
      )}
      {channel === "email" && (
        <Dialog
          open={confirmOpen}
          onOpenChange={(open) => {
            // Not while it is sending: closing would hide a send that is still running.
            if (!sending) setConfirmOpen(open);
          }}
        >
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>
                Send {plural(batch.ids.length, "email")} from {batch.from}?
              </DialogTitle>
              <DialogDescription>
                Each one goes out from your own mailbox, one after another. A sent email can’t be taken back.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={sending}>
                Cancel
              </Button>
              <Button onClick={confirmSend} disabled={sending}>
                {sending && <Loader2 className="animate-spin" aria-hidden />}
                {sending ? "Sending…" : "Send"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

const SETTINGS_EMAIL = "/settings#settings-email";
const BLOCKED_LEAD: Record<string, string> = {
  not_connected: "No email is connected.",
  no_send_scope: "Orbit can’t send from your email yet.",
  needs_reauth: "Your email connection expired.",
};

/** Who the email goes out as and how many sends are left today, or what to fix. */
function CapabilityLine({ line }: { line: SendLine | null }) {
  if (line?.ok) {
    return (
      <p className="text-sm text-muted-foreground">
        From {line.fromEmail} · {line.remainingToday} of {line.dailyCap} left today
      </p>
    );
  }
  if (line?.reason === "cap_reached") {
    return (
      <p className="text-sm text-muted-foreground">
        You’ve reached today’s email limit — it resets over the next 24 hours
      </p>
    );
  }
  return (
    <p className="text-sm text-muted-foreground">
      {BLOCKED_LEAD[line?.reason ?? "not_connected"]}{" "}
      <Link href={SETTINGS_EMAIL} className="text-primary underline-offset-2 hover:underline">
        Connect your email
      </Link>
    </p>
  );
}

function ReadyRow({
  item,
  campaignId,
  channel,
  canUseAi,
  selectable,
  selected,
  onSelect,
  locked,
  isDirty,
  error,
  onDirtyChange,
  onError,
}: {
  item: ReadyItem;
  campaignId: string;
  channel: OutreachChannel;
  canUseAi: boolean;
  selectable: boolean;
  selected: boolean;
  onSelect: (on: boolean) => void;
  /** A send is in flight: nothing on the row changes under it. */
  locked: boolean;
  isDirty: boolean;
  error: string | null;
  onDirtyChange: (messageId: string, dirty: boolean) => void;
  onError: (messageId: string, text: string | null) => void;
}) {
  const { person, message } = item;
  const isFollowUp = (message.stepIndex ?? 0) > 0;
  const rightChannel = message.channel === channel;

  return (
    <li className="rounded-2xl border border-border/70 bg-card p-4">
      <div className="flex items-start gap-3">
        {selectable && (
          <Checkbox
            checked={selected}
            onCheckedChange={(v) => onSelect(Boolean(v))}
            disabled={locked}
            aria-label={`Select ${person.fullName}`}
            className="mt-1"
          />
        )}
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-ink">{person.fullName}</span>
            {where(person) && <span className="text-sm text-muted-foreground">{where(person)}</span>}
            {isFollowUp && <Badge variant="outline">Follow-up</Badge>}
            {message.status === "failed" && <Badge variant="destructive">Didn’t send</Badge>}
          </div>
          {channel === "email" && person.email && <p className="text-xs text-muted-foreground">To {person.email}</p>}
          <MessageEditorRow
            campaignId={campaignId}
            prospectId={person.id}
            messageId={message.id}
            channel={channel}
            status={message.status}
            stepIndex={message.stepIndex ?? 0}
            subject={message.subject}
            body={message.body}
            canRewrite={canUseAi}
            onDirtyChange={onDirtyChange}
          />
          {!rightChannel && (
            <p className="text-xs text-muted-foreground">
              This was written for {message.channel}. Rewrite it for {channel} before it can go.
            </p>
          )}
          {channel === "linkedin" && rightChannel && (
            <LinkedInActions item={item} isDirty={isDirty} onError={onError} />
          )}
          <p role="status" className="text-xs text-destructive empty:hidden">
            {error}
          </p>
        </div>
      </div>
    </li>
  );
}

/**
 * Orbit never sends or automates anything on LinkedIn: it copies the note, opens the profile,
 * and waits for the user to say they sent it.
 */
function LinkedInActions({
  item,
  isDirty,
  onError,
}: {
  item: ReadyItem;
  isDirty: boolean;
  onError: (messageId: string, text: string | null) => void;
}) {
  const { person, message } = item;
  const [busy, setBusy] = useState<"copy" | "confirm" | null>(null);
  const copied = message.status === "copied";
  // What the server would accept as the profile to open, and why Copy might not be available.
  const openUrl = linkedInOpenUrl(person.linkedinUrl);
  const blocked = copyBlockedReason(message, isDirty, person.linkedinUrl);

  // The note and the profile go first, inside the click: a popup opened after an await is
  // blocked by the browser. The saved body is already here (unsaved edits and a note over the
  // limit are both blocked above), and the link was checked the way the server checks it.
  // Only then is the copy recorded, so a refusal from the server shows on the row.
  async function copyAndOpen() {
    if (busy || blocked || !openUrl) return;
    setBusy("copy");
    onError(message.id, null);
    try {
      navigator.clipboard
        .writeText(message.body)
        .then(() => toast.success(TOAST_COPY.copied))
        .catch(() => onError(message.id, TOAST_COPY.copyFailed));
    } catch {
      onError(message.id, TOAST_COPY.copyFailed);
    }
    window.open(openUrl, "_blank", "noopener");
    try {
      const res = await copyLinkedIn(message.id);
      if (!res.ok) onError(message.id, res.error);
    } catch (err) {
      onError(message.id, friendlyError(err, "Couldn’t save that the note was copied — try again?"));
    } finally {
      setBusy(null);
    }
  }

  // Stays pressable after a failure: the server finishes a confirm that died halfway when it
  // is asked again.
  async function confirmSent() {
    if (busy) return;
    setBusy("confirm");
    onError(message.id, null);
    try {
      const res = await confirmLinkedInSent(message.id);
      if (!res.ok) onError(message.id, res.error);
      else toast.success("Marked as sent");
    } catch (err) {
      onError(message.id, friendlyError(err, "Couldn’t mark that as sent — press I sent it again"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {copied && (
          <Button size="sm" onClick={confirmSent} disabled={busy !== null}>
            {busy === "confirm" && <Loader2 className="animate-spin" aria-hidden />}
            I sent it
          </Button>
        )}
        <Button
          size="sm"
          variant={copied ? "outline" : "default"}
          onClick={copyAndOpen}
          disabled={busy !== null || blocked !== null}
        >
          {busy === "copy" && <Loader2 className="animate-spin" aria-hidden />}
          {copied ? "Copy & open again" : "Copy & open"}
        </Button>
        {copied && openUrl && (
          <a
            href={openUrl}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="inline-flex items-center gap-1 text-xs text-primary underline-offset-2 hover:underline"
          >
            Open their profile
            <span className="sr-only"> ({person.fullName}, opens in a new tab)</span>
            <ExternalLink className="size-3" aria-hidden />
          </a>
        )}
      </div>
      {copied && (
        <p className="text-xs text-muted-foreground">
          Copied. Paste it on LinkedIn, send it there, then press I sent it.
        </p>
      )}
      {blocked && <p className="text-xs text-muted-foreground">{blocked}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ Sent ----- */

function SentView({
  campaignId,
  channel,
  rows,
  items,
  canUseAi,
  canSeeReplies,
  onFollowUpWritten,
}: {
  campaignId: string;
  channel: OutreachChannel;
  rows: ViewPerson[];
  items: SentItem[];
  canUseAi: boolean;
  canSeeReplies: boolean;
  onFollowUpWritten: () => void;
}) {
  const metrics = computeCampaignMetrics(rows);
  // Something out that could still be answered, and that a mailbox can be asked about.
  const awaitingReply =
    channel === "email" && rows.some((p) => p.messages.some((m) => m.channel === "email" && m.status === "sent" && !m.outcome));
  const startedRef = useRef(false);
  const [checking, setChecking] = useState(awaitingReply);
  const [checkNote, setCheckNote] = useState("");
  const [followUpBusy, setFollowUpBusy] = useState<string | null>(null);
  const [wentOutBusy, setWentOutBusy] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});

  // Once, as the Sent view opens. The server throttles to one pass per ten minutes, and a
  // throttled or failed pass says nothing: it is a courtesy, not something to report on.
  useEffect(() => {
    if (startedRef.current || !awaitingReply) return;
    startedRef.current = true;
    checkReplies(campaignId)
      .then((res) => {
        if (res.ok && res.value.replied) {
          setCheckNote(`${plural(res.value.replied, "new reply", "new replies")} found`);
        }
      })
      .catch(() => {})
      .finally(() => setChecking(false));
  }, [awaitingReply, campaignId]);

  async function checkNow() {
    if (checking) return;
    setChecking(true);
    setCheckNote("");
    try {
      const res = await checkReplies(campaignId);
      if (!res.ok) setCheckNote(res.error);
      else if (res.value.throttled) setCheckNote("Checked a few minutes ago — try again soon");
      else if (res.value.replied) setCheckNote(`${plural(res.value.replied, "new reply", "new replies")} found`);
      else setCheckNote(`Checked ${plural(res.value.checked, "person", "people")} — no new replies`);
    } catch (err) {
      setCheckNote(friendlyError(err, "Couldn’t check for replies — try again?"));
    } finally {
      setChecking(false);
    }
  }

  async function writeFollowUp(personId: string, firstMessageId: string) {
    if (followUpBusy) return;
    setFollowUpBusy(personId);
    setRowErrors((prev) => ({ ...prev, [personId]: "" }));
    try {
      const res = await draftFollowUp(firstMessageId);
      if (!res.ok) setRowErrors((prev) => ({ ...prev, [personId]: res.error }));
      else {
        toast.success("Follow-up written — find it under To send");
        onFollowUpWritten();
      }
    } catch (err) {
      setRowErrors((prev) => ({ ...prev, [personId]: friendlyError(err, TOAST_COPY.draftFollowUpFailed) }));
    } finally {
      setFollowUpBusy(null);
    }
  }

  // Only the user can say: they checked their Sent folder. Nothing is sent again either way.
  async function wentOut(personId: string, messageId: string) {
    if (wentOutBusy) return;
    setWentOutBusy(personId);
    setRowErrors((prev) => ({ ...prev, [personId]: "" }));
    try {
      const res = await markWentOut(messageId);
      if (!res.ok) setRowErrors((prev) => ({ ...prev, [personId]: res.error }));
    } catch (err) {
      setRowErrors((prev) => ({ ...prev, [personId]: friendlyError(err, "Couldn’t save that — try again?") }));
    } finally {
      setWentOutBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-3 gap-3">
        {[
          { label: "Sent", value: String(metrics.sentCount) },
          { label: "Replied", value: String(metrics.replyCount) },
          { label: "Reply rate", value: formatReplyRate(metrics.replyRate) },
        ].map((kpi) => (
          <div key={kpi.label} className="rounded-xl border border-border/70 bg-card px-4 py-3">
            <dt className="text-xs text-muted-foreground">{kpi.label}</dt>
            <dd className="mt-1 font-[family-name:var(--font-display)] text-2xl text-foreground">{kpi.value}</dd>
          </div>
        ))}
      </dl>

      {channel === "email" && (
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" variant="outline" onClick={checkNow} disabled={checking}>
              {checking && <Loader2 className="animate-spin" aria-hidden />}
              {checking ? "Checking…" : "Check for replies"}
            </Button>
            <p role="status" className="text-sm text-muted-foreground empty:hidden">
              {checkNote}
            </p>
          </div>
          {!canSeeReplies && items.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Orbit can’t see replies — reconnect your email with read access to have them noticed{" "}
              <Link href={SETTINGS_EMAIL} className="text-primary underline-offset-2 hover:underline">
                Email settings
              </Link>
            </p>
          )}
        </div>
      )}

      {items.length ? (
        <ul className="space-y-3">
          {items.map((item) => (
            <li key={item.person.id} className="rounded-2xl border border-border/70 bg-card p-4">
              <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                <div className="min-w-0">
                  <span className="font-medium text-ink">{item.person.fullName}</span>
                  {where(item.person) && <p className="text-sm text-muted-foreground">{where(item.person)}</p>}
                  {item.sentAt && (
                    <p className="text-xs text-muted-foreground">
                      Sent <RelativeTime date={item.sentAt} />
                    </p>
                  )}
                </div>
                <Badge variant={item.tone === "warn" ? "destructive" : item.tone === "good" ? "secondary" : "outline"}>
                  {item.label}
                </Badge>
              </div>
              {item.label === "Unsure" && (
                <p className="mt-2 text-sm text-muted-foreground">
                  {item.problem || "It may or may not have gone out — check your Sent folder before writing to them again."}
                </p>
              )}
              {item.unsureId && (
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-2"
                  onClick={() => wentOut(item.person.id, item.unsureId!)}
                  disabled={wentOutBusy !== null}
                >
                  {wentOutBusy === item.person.id && <Loader2 className="animate-spin" aria-hidden />}
                  It went out
                  <span className="sr-only"> to {item.person.fullName}</span>
                </Button>
              )}
              {(item.followUpOf || item.outcomeTarget) && (
                <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border/50 pt-3">
                  {item.followUpOf && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => writeFollowUp(item.person.id, item.followUpOf!)}
                      disabled={followUpBusy !== null || !canUseAi || checking}
                      title={
                        !canUseAi
                          ? "Add an AI key to write follow-ups"
                          : checking
                            ? "Checking for replies first"
                            : undefined
                      }
                    >
                      {followUpBusy === item.person.id && <Loader2 className="animate-spin" aria-hidden />}
                      Write follow-up
                      <span className="sr-only"> for {item.person.fullName}</span>
                    </Button>
                  )}
                  {item.outcomeTarget && (
                    <OutcomeControls messageId={item.outcomeTarget.id} currentOutcome={item.outcomeTarget.outcome} />
                  )}
                </div>
              )}
              <p role="status" className="mt-2 text-xs text-destructive empty:hidden">
                {rowErrors[item.person.id]}
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-2xl border border-dashed border-border/70 p-8 text-center text-sm text-muted-foreground">
          Nothing sent yet. Messages show up here once they go out.
        </p>
      )}
    </div>
  );
}
