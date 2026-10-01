"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { MessageCircle } from "lucide-react";
import { toast } from "@/lib/toast";
import { previewChatConversations } from "@/actions/chat-imports";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ChatConversationReview,
  choiceToDecision,
  defaultChoice,
  formatSpan,
  type MemberChoice,
  type ReviewConversation,
} from "@/components/imports/chat-conversation-review";
import { BusyHint, ImportFilePicker } from "@/components/imports/import-utils";
import { formatCostMicros } from "@/lib/ai-pricing";
import { parseIMessageExport } from "@/lib/conversations/imessage";
import { readChatFiles } from "@/lib/conversations/read-files";
import { conversationKey } from "@/lib/conversations/sessions";
import { conversationToRows, type ChatConversationRow, type ParticipantDecision } from "@/lib/conversations/to-rows";
import type { ChatSource, Conversation } from "@/lib/conversations/types";
import { parseWhatsAppExport } from "@/lib/conversations/whatsapp";
import { clearChatHandoff, useChatHandoff } from "@/lib/imports/chat-handoff";
import { awaitImportJob, startImportJob, useImportJob } from "@/lib/import-job-runner";
import { UserFacingError, friendlyError } from "@/lib/errors";
import { TOAST_COPY } from "@/lib/toast-copy";

type PreviewResult = Awaited<ReturnType<typeof previewChatConversations>>;
type ChatPreview = Exclude<PreviewResult, { error: string }>;
type PreviewConversation = ChatPreview["conversations"][number];
type PreviewInput = Parameters<typeof previewChatConversations>[0][number];

/** One parsed export, keyed the way the server and the staged rows key it. */
type Loaded = { key: string; fileName: string; conversation: Conversation };

const SOURCE_LABEL: Record<ChatSource, string> = { whatsapp: "WhatsApp", imessage: "iMessage" };
/** The order the runner takes the sources in; it runs one job at a time. */
const SOURCE_ORDER: ChatSource[] = ["whatsapp", "imessage"];

/** Rule: day-first when this browser's own date format puts the day before the month. */
function localeDayFirst(): boolean {
  const parts = new Intl.DateTimeFormat().formatToParts(new Date(2024, 0, 31));
  const day = parts.findIndex((p) => p.type === "day");
  const month = parts.findIndex((p) => p.type === "month");
  return day !== -1 && month !== -1 && day < month;
}

function parse(fileName: string, text: string, source: ChatSource, dayFirst: boolean): Conversation {
  return source === "whatsapp"
    ? parseWhatsAppExport(text, fileName, { localeDayFirst: dayFirst })
    : parseIMessageExport(text, fileName);
}

/** What the server sees: counts, names and handles — never message text. */
function toPreviewInput({ key, conversation: c }: Loaded): PreviewInput {
  return {
    key,
    source: c.source,
    title: c.title,
    isGroup: c.isGroup,
    participants: c.participants.map((p) => ({
      key: p.key,
      displayName: p.displayName,
      phoneE164: p.phoneE164,
      email: p.email,
    })),
    messageCount: c.messages.length,
    chars: c.messages.reduce((n, m) => n + m.text.length, 0),
    firstAt: c.messages[0].at,
    lastAt: c.messages[c.messages.length - 1].at,
  };
}

function plural(n: number, word: string) {
  return `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * Rule: WhatsApp exports name the owner by their own name, so a WhatsApp chat the preview
 * could not place the owner in asks. A one-sender chat does not: its only sender is the
 * other person far more often than an owner talking to no one.
 */
function needsSelfPick(l: Loaded, p: PreviewConversation | undefined): boolean {
  return (
    l.conversation.source === "whatsapp" &&
    p?.suggestedSelfKey === null &&
    l.conversation.participants.filter((x) => !x.isSelf).length > 1
  );
}

/**
 * Sender labels to offer as "you", most likely first: the owner is in every chat they
 * exported, so the label seen in the most conversations leads, then the most messages.
 */
function selfLabelOptions(unknown: Loaded[]): string[] {
  const chats = new Map<string, number>();
  const messages = new Map<string, number>();
  for (const { conversation: c } of unknown) {
    for (const p of c.participants) {
      if (!p.isSelf) chats.set(p.key, (chats.get(p.key) ?? 0) + 1);
    }
    for (const m of c.messages) messages.set(m.senderKey, (messages.get(m.senderKey) ?? 0) + 1);
  }
  return [...chats.keys()].sort(
    (a, b) =>
      (chats.get(b) ?? 0) - (chats.get(a) ?? 0) ||
      (messages.get(b) ?? 0) - (messages.get(a) ?? 0) ||
      a.localeCompare(b),
  );
}

export function ChatMessagesImport() {
  const job = useImportJob();
  const [pending, start] = useTransition();

  const [loaded, setLoaded] = useState<Loaded[]>([]);
  const [ignored, setIgnored] = useState<string[]>([]);
  const [preview, setPreview] = useState<ChatPreview | null>(null);
  const [selfLabel, setSelfLabel] = useState<string | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [choices, setChoices] = useState<Record<string, Record<string, MemberChoice>>>({});

  const chatJob = job?.kind === "chat" && job.status === "running" ? job : null;
  const importProgress = chatJob?.progress ?? null;
  const busy = pending || job?.status === "running";

  // Files dropped elsewhere on the page: read exactly as if picked here. Held (not dropped)
  // while an import or a read is in flight, and cleared the moment they are taken.
  const handedOff = useChatHandoff();
  useEffect(() => {
    if (!handedOff.length || busy) return;
    clearChatHandoff();
    loadFiles(handedOff);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadFiles is a fresh closure each render; the handoff and idle state are the triggers
  }, [handedOff, busy]);

  const previewByKey = useMemo(
    () => new Map<string, PreviewConversation>((preview?.conversations ?? []).map((c) => [c.key, c])),
    [preview],
  );

  const unknownSelf = useMemo(
    () => loaded.filter((l) => needsSelfPick(l, previewByKey.get(l.key))),
    [loaded, previewByKey],
  );
  const selfOptions = useMemo(() => selfLabelOptions(unknownSelf), [unknownSelf]);

  function selfKeyFor(l: Loaded): string | null {
    const suggested = previewByKey.get(l.key)?.suggestedSelfKey ?? null;
    if (suggested != null) return suggested;
    // Rule: the picked label applies to every conversation that contains it.
    if (l.conversation.source === "whatsapp" && selfLabel && l.conversation.participants.some((p) => p.key === selfLabel)) {
      return selfLabel;
    }
    return null;
  }

  const review: ReviewConversation[] = loaded.map((l) => {
    const c = l.conversation;
    const selfKey = selfKeyFor(l);
    const fromPreview = new Map((previewByKey.get(l.key)?.participants ?? []).map((p) => [p.key, p]));
    return {
      key: l.key,
      title: c.title,
      isGroup: c.isGroup,
      messageCount: c.messages.length,
      firstAt: c.messages[0].at,
      lastAt: c.messages[c.messages.length - 1].at,
      included: !excluded.has(l.key),
      members: c.participants
        .filter((p) => !p.isSelf && p.key !== selfKey)
        .map((p) => {
          const pp = fromPreview.get(p.key) ?? { autoContactId: null, autoContactName: null, candidates: [] };
          return {
            key: p.key,
            displayName: p.displayName,
            autoContactId: pp.autoContactId,
            autoContactName: pp.autoContactName,
            candidates: pp.candidates,
            choice: choices[l.key]?.[p.key] ?? defaultChoice(c.isGroup, pp),
          };
        }),
    };
  });

  const includedMessages = review.filter((c) => c.included).reduce((n, c) => n + c.messageCount, 0);

  function reset() {
    setLoaded([]);
    setIgnored([]);
    setPreview(null);
    setSelfLabel(null);
    setExcluded(new Set());
    setChoices({});
  }

  function loadFiles(files: File[]) {
    start(async () => {
      try {
        const read = await readChatFiles(files);
        const dayFirst = localeDayFirst();
        const skipped = [...read.ignored];
        const byKey = new Map<string, Loaded>();
        for (const f of read.files) {
          const conversation = parse(f.fileName, f.text, f.source, dayFirst);
          if (conversation.messages.length === 0) {
            skipped.push(f.fileName);
            continue;
          }
          const key = conversationKey(conversation);
          // The same chat picked twice: keep the fuller export.
          const prior = byKey.get(key);
          if (!prior || prior.conversation.messages.length < conversation.messages.length) {
            byKey.set(key, { key, fileName: f.fileName, conversation });
          }
        }
        const next = [...byKey.values()];
        setIgnored(skipped);
        if (next.length === 0) {
          setLoaded([]);
          setPreview(null);
          toast.error("No WhatsApp or iMessage chats in those files — export them again and retry");
          return;
        }
        const res = await previewChatConversations(next.map(toPreviewInput));
        // Refusals arrive as data — see `previewChatConversations`.
        if ("error" in res) throw new UserFacingError(res.error);
        const unknown = next.filter((l) => needsSelfPick(l, res.conversations.find((c) => c.key === l.key)));
        setLoaded(next);
        setPreview(res);
        setSelfLabel(selfLabelOptions(unknown)[0] ?? null);
        setExcluded(new Set());
        setChoices({});
        toast.success(`Loaded ${plural(next.length, "chat")}`);
      } catch (err) {
        reset();
        toast.error(friendlyError(err, "Couldn’t read those files — are they chat exports?"));
      }
    });
  }

  function startImport() {
    if (busy) return;
    const rowsBySource = new Map<ChatSource, { rows: ChatConversationRow[]; files: string[] }>();
    for (const l of loaded) {
      if (excluded.has(l.key)) continue;
      const conv = review.find((r) => r.key === l.key);
      const decisions: Record<string, ParticipantDecision> = {};
      for (const m of conv?.members ?? []) decisions[m.key] = choiceToDecision(m.choice);
      const rows = conversationToRows(l.conversation, selfKeyFor(l), decisions);
      if (!rows.length) continue;
      const bucket = rowsBySource.get(l.conversation.source) ?? { rows: [], files: [] };
      bucket.rows.push(...rows);
      bucket.files.push(l.fileName);
      rowsBySource.set(l.conversation.source, bucket);
    }
    const jobs = SOURCE_ORDER.flatMap((source) => {
      const bucket = rowsBySource.get(source);
      if (!bucket) return [];
      const fileName =
        bucket.files.length === 1 ? bucket.files[0] : `${bucket.files.length} ${SOURCE_LABEL[source]} chats`;
      const selfNames =
        source === "whatsapp" && selfLabel && !/^(you|me)$/i.test(selfLabel) ? [selfLabel.slice(0, 200)] : [];
      return [{ kind: "chat" as const, source, fileName: fileName.slice(0, 255), selfNames, rows: bucket.rows }];
    });
    if (jobs.length === 0) {
      toast.error("Nothing to import yet — include a chat or link someone in it");
      return;
    }
    const step = (i: number) => (jobs.length > 1 ? { step: { index: i + 1, total: jobs.length } } : {});

    let firstJobId: string;
    try {
      firstJobId = startImportJob(jobs[0], step(0));
    } catch (err) {
      toast.error(friendlyError(err, TOAST_COPY.importFailed));
      return;
    }
    reset();
    if (jobs.length < 2) return;
    // The runner takes one job at a time: iMessage starts once WhatsApp has finished, and
    // not at all if it failed or was cancelled (that job's own toast says why).
    void (async () => {
      let jobId = firstJobId;
      for (let i = 1; i < jobs.length; i++) {
        const done = await awaitImportJob(jobId);
        if (done.status !== "completed") return;
        jobId = startImportJob(jobs[i], step(i));
      }
    })().catch((err) => toast.error(friendlyError(err, TOAST_COPY.importFailed)));
  }

  return (
    <section className="space-y-4 rounded-2xl border border-border/70 border-t-2 border-t-import-messages/70 bg-card p-6">
      <div className="flex items-start gap-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-import-messages/10 text-import-messages">
          <MessageCircle className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="min-w-0 text-lg font-medium text-ink">Chat messages</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Export a chat from WhatsApp (Export chat → Without media) or with
            imessage-exporter, then add the files here. Media is never uploaded.
          </p>
        </div>
      </div>

      <ImportFilePicker
        accept=".txt,.zip,text/plain,application/zip"
        multiple
        disabled={busy}
        buttonLabel="Choose files"
        emptyLabel="No files chosen"
        fileName={loaded.length ? loaded.map((l) => l.fileName).join(", ") : null}
        onFiles={loadFiles}
      />

      {pending ? <BusyHint>Reading chats…</BusyHint> : null}

      {loaded.length > 0 ? (
        <ul className="space-y-1 text-xs text-muted-foreground">
          {loaded.map((l) => (
            <li key={l.key} className="flex flex-wrap gap-x-2">
              <span className="min-w-0 truncate text-ink">{l.fileName}</span>
              <span>
                {plural(l.conversation.messages.length, "message")} ·{" "}
                {formatSpan(l.conversation.messages[0].at, l.conversation.messages[l.conversation.messages.length - 1].at)}
              </span>
              {l.conversation.dateOrderGuessed ? (
                <span className="text-amber-600 dark:text-amber-400">Dates guessed — check them</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {ignored.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Skipped {ignored.join(", ")} — not a WhatsApp or iMessage chat export
        </p>
      ) : null}

      {preview && unknownSelf.length > 0 && selfOptions.length > 0 ? (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border/60 px-3 py-2.5 text-sm">
          <span className="text-muted-foreground">Which sender is you?</span>
          <Select
            value={selfLabel}
            onValueChange={(v) => setSelfLabel(v ?? null)}
            items={selfOptions.map((label) => ({ value: label, label }))}
            disabled={busy}
          >
            <SelectTrigger aria-label="Which sender is you" className="h-8 max-w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false} className="p-1">
              {selfOptions.map((label) => (
                <SelectItem key={label} value={label} className="py-1.5 pl-2">
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      {preview && review.length > 0 ? (
        <div className="space-y-2">
          <ChatConversationReview
            conversations={review}
            disabled={busy}
            onIncludedChange={(key, included) =>
              setExcluded((prev) => {
                const next = new Set(prev);
                if (included) next.delete(key);
                else next.add(key);
                return next;
              })
            }
            onChoiceChange={(convKey, memberKey, choice) =>
              setChoices((prev) => ({ ...prev, [convKey]: { ...prev[convKey], [memberKey]: choice } }))
            }
          />
          <p className="text-xs text-muted-foreground">
            {preview.estimate
              ? `Analyzing ~${includedMessages.toLocaleString()} messages ≈ ${formatCostMicros(preview.estimate.micros)} on your AI key`
              : "Add an AI key in Settings to analyze these — the conversations are saved either way"}
          </p>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button
          disabled={!preview || busy || includedMessages === 0}
          className="bg-primary text-primary-foreground hover:bg-primary/90"
          onClick={startImport}
        >
          {importProgress
            ? `Importing… ${importProgress.done}/${importProgress.total}`
            : `Import ${plural(review.filter((c) => c.included).length, "chat")}`}
        </Button>
      </div>
    </section>
  );
}
