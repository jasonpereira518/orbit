"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useTransition,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowUp,
  History,
  Loader2,
  NotebookPen,
  Plus,
  Trash2,
} from "lucide-react";
import { toast } from "@/lib/toast";
import { MISSING_AI_API_KEY_MESSAGE, toUserFacingError } from "@/lib/errors";
import {
  askNetwork,
  createChatThread,
  deleteChatThread,
  getChatThread,
  listChatThreads,
} from "@/actions/chat";
import { createReminder } from "@/actions/reminders";
import { BulkNotesPanel } from "@/components/chat/bulk-notes-panel";
import { ComposerMirror, useCoarsePointer } from "@/components/chat/composer-mirror";
import { DictationButton } from "@/components/chat/dictation-button";
import { ChatMarkdown } from "@/components/chat/chat-markdown";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import type { ChatRecommendation } from "@/db/schema";
import { streamChat } from "@/lib/chat-stream-client";
import { ANCHOR_INTERFERENCE, shiftAnchor, spliceSpan } from "@/lib/dictation";
import { useDictation } from "@/lib/use-dictation";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";

type ChatResult = Extract<
  Awaited<ReturnType<typeof askNetwork>>,
  { ok: true }
>;

type ThreadSummary = {
  id: string;
  title: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

type UserMessage = {
  id: string;
  role: "user";
  content: string;
};

type AssistantMessage = {
  id: string;
  role: "assistant";
  answer: string;
  recommendations: ChatRecommendation[];
  /** True while the answer is still arriving from `/api/chat`. */
  streaming?: boolean;
};

type ThreadMessage = UserMessage | AssistantMessage;

const SUGGESTION_CHIPS = [
  "Who do I know at AWS?",
  "Who have I not followed up with recently?",
  "Who are the best recruiters for my search?",
  "Who should I reconnect with this week?",
];

function newId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function formatThreadLabel(thread: ThreadSummary) {
  return thread.title?.trim() || "New chat";
}

export function ChatPanel() {
  const router = useRouter();
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [threadTitle, setThreadTitle] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [notesOpen, setNotesOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [loadingThread, setLoadingThread] = useState(false);
  const [lastUserQuery, setLastUserQuery] = useState("");
  const [pending, start] = useTransition();
  // Streaming is deliberately NOT a transition: updates inside `startTransition` are
  // deferred, which would hold every streamed token back until the whole answer landed.
  const [streaming, setStreaming] = useState(false);
  const busy = pending || streaming;
  // The "searching" bubble makes sense until the first token; after that the answer
  // itself is the progress indicator.
  const awaitingFirstToken =
    busy && !messages.some((m) => m.role === "assistant" && m.streaming);
  const listRef = useRef<HTMLDivElement>(null);
  const threadEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const stickToBottomRef = useRef(true);

  // ── Dictation ───────────────────────────────────────────────────────────────────────
  // Dictated words occupy a span anchored at wherever the caret was when you started, so
  // they land mid-sentence if that is where you were, and the user's own typing around
  // them is never clobbered.
  const [dictationNote, setDictationNote] = useState("");
  const [hasInterim, setHasInterim] = useState(false);
  /** Where the un-committed tail sits inside the field, for the ghost overlay. */
  const [interimRange, setInterimRange] = useState<[number, number] | null>(null);
  // The mirror is only safe while none of its failure modes are reachable: a selection
  // would render as an empty highlight, IME preedit never reaches `.value`, and coarse
  // pointers bring predictive text and text-size-adjust.
  const [selectionCollapsed, setSelectionCollapsed] = useState(true);
  const [composing, setComposing] = useState(false);
  const coarsePointer = useCoarsePointer();
  const reducedMotion = usePrefersReducedMotion();
  /** Where the dictated span begins, or null when no session owns any text. */
  const anchorRef = useRef<number | null>(null);
  /** What currently occupies that span, so the next result can replace exactly it. */
  const spanRef = useRef("");
  /** The value as of the last change, to tell the user's edits from our own. */
  const lastValueRef = useRef("");
  const pendingCaretRef = useRef<number | null>(null);
  /**
   * Breaks the declaration cycle: `resetQuestion` must be able to cancel dictation, but
   * the hook's callbacks need `resetQuestion`'s siblings.
   */
  const cancelDictationRef = useRef<() => void>(() => {});

  /**
   * Every PROGRAMMATIC change to the composer goes through here.
   *
   * `rec.stop()` flushes a final result asynchronously, so a plain `setQuestion("")` on
   * send races it and the dictated text reappears in a just-cleared box. Cancelling first
   * invalidates the session, and the hook's own session guard drops the straggler.
   * The user's own typing stays on plain `setQuestion` via `onComposerChange`.
   */
  const resetQuestion = useCallback((value: string) => {
    cancelDictationRef.current();
    anchorRef.current = null;
    spanRef.current = "";
    lastValueRef.current = value;
    setQuestion(value);
  }, []);

  const dictation = useDictation({
    onSessionStart: () => {
      const el = textareaRef.current;
      const value = el?.value ?? "";
      const caret = el?.selectionStart ?? value.length;
      // A dictated clause needs separating from whatever it follows.
      const needsSpace = caret > 0 && !/\s$/.test(value.slice(0, caret));
      const nextValue = needsSpace
        ? value.slice(0, caret) + " " + value.slice(caret)
        : value;
      anchorRef.current = caret + (needsSpace ? 1 : 0);
      spanRef.current = "";
      lastValueRef.current = nextValue;
      if (needsSpace) {
        setQuestion(nextValue);
        // Re-rendering the field with a new value parks the caret at the end; put it back
        // at the anchor so the first dictated words appear under it.
        pendingCaretRef.current = anchorRef.current;
      }
      setDictationNote("Listening");
    },
    onTranscript: (span, { hasInterim: interim, interimStart }) => {
      const el = textareaRef.current;
      const anchor = anchorRef.current;
      if (!el || anchor === null) return;

      // Read the DOM, not `question`: results arrive outside React's batching at up to
      // five a second, and the state in this closure can be a render stale.
      const value = el.value;
      const result = spliceSpan(value, anchor, spanRef.current, span);
      if (!result) {
        // The anchor no longer describes the span — stop rather than corrupt the text.
        anchorRef.current = null;
        cancelDictationRef.current();
        return;
      }

      const spanEnd = anchor + spanRef.current.length;
      const caretRidesTail =
        el.selectionStart === el.selectionEnd && el.selectionStart === spanEnd;

      spanRef.current = span;
      lastValueRef.current = result.value;
      setHasInterim(interim);
      setInterimRange(
        interim ? [anchor + interimStart, anchor + span.length] : null,
      );
      setQuestion(result.value);
      if (caretRidesTail) pendingCaretRef.current = result.spanEnd;
    },
    onSessionEnd: (reason) => {
      anchorRef.current = null;
      spanRef.current = "";
      setHasInterim(false);
      setInterimRange(null);
      setDictationNote(
        reason === "error" ? "Dictation unavailable" : "Dictation stopped",
      );
    },
    onEffect: (effect) => {
      // A stable id per reason: clicking a denied mic repeatedly should re-surface the
      // same message, not stack identical copies.
      if (effect === "toast-denied") {
        toast.error(
          "Orbit needs microphone access to dictate. Enable it in your browser's site settings.",
          { id: "dictation-denied" },
        );
      } else if (effect === "toast-no-microphone") {
        toast.error("No microphone found.", { id: "dictation-no-mic" });
      } else if (effect === "toast-network") {
        toast.error("Dictation needs a connection right now.", {
          id: "dictation-network",
        });
      }
    },
  });
  useEffect(() => {
    cancelDictationRef.current = dictation.cancel;
  }, [dictation.cancel]);

  /**
   * Caret restoration, before paint. The rAF idiom used elsewhere in this file visibly
   * lags when results land five times a second.
   */
  useLayoutEffect(() => {
    const caret = pendingCaretRef.current;
    if (caret === null) return;
    pendingCaretRef.current = null;
    textareaRef.current?.setSelectionRange(caret, caret);
  });

  /** Backstop for any future clear that forgets to go through `resetQuestion`. */
  useEffect(() => {
    if (busy || loadingThread) dictation.cancel();
  }, [busy, loadingThread, dictation]);

  const refreshThreads = useCallback(async () => {
    try {
      const rows = await listChatThreads();
      setThreads(rows);
    } catch {
      // History is non-blocking on first paint
    }
  }, []);

  useEffect(() => {
    void refreshThreads();
  }, [refreshThreads]);

  const isNearBottom = useCallback(() => {
    const el = listRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);

  const scrollToBottom = useCallback((smooth = true) => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTo({
      top: el.scrollHeight,
      behavior: smooth ? "smooth" : "auto",
    });
  }, []);

  useEffect(() => {
    if (!stickToBottomRef.current && !isNearBottom()) return;
    // Defer so DOM has laid out new messages
    requestAnimationFrame(() => scrollToBottom(true));
  }, [messages, busy, isNearBottom, scrollToBottom]);

  function onListScroll() {
    stickToBottomRef.current = isNearBottom();
  }

  const ensureThread = useCallback(async () => {
    if (threadId) return threadId;
    const created = await createChatThread();
    setThreadId(created.id);
    setThreadTitle(created.title);
    setThreads((prev) => [
      {
        id: created.id,
        title: created.title,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
      },
      ...prev.filter((t) => t.id !== created.id),
    ]);
    return created.id;
  }, [threadId]);

  const loadThread = useCallback(async (id: string) => {
    setLoadingThread(true);
    try {
      const { thread, messages: rows } = await getChatThread(id);
      setThreadId(thread.id);
      setThreadTitle(thread.title);
      stickToBottomRef.current = true;
      setMessages(
        rows.map((row) =>
          row.role === "user"
            ? {
                id: row.id,
                role: "user" as const,
                content: row.content,
              }
            : {
                id: row.id,
                role: "assistant" as const,
                answer: row.content,
                recommendations: row.recommendations || [],
              }
        )
      );
      const lastUser = [...rows].reverse().find((row) => row.role === "user");
      setLastUserQuery(lastUser?.content ?? "");
      resetQuestion("");
      requestAnimationFrame(() => scrollToBottom(false));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load chat");
    } finally {
      setLoadingThread(false);
    }
  }, [resetQuestion, scrollToBottom]);

  const startNewChat = useCallback(() => {
    start(async () => {
      try {
        const created = await createChatThread();
        setThreadId(created.id);
        setThreadTitle(created.title);
        setMessages([]);
        resetQuestion("");
        setLastUserQuery("");
        setThreads((prev) => [
          {
            id: created.id,
            title: created.title,
            createdAt: created.createdAt,
            updatedAt: created.updatedAt,
          },
          ...prev.filter((t) => t.id !== created.id),
        ]);
        requestAnimationFrame(() => textareaRef.current?.focus());
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not start chat");
      }
    });
  }, [resetQuestion]);

  const removeThread = useCallback(
    (id: string) => {
      start(async () => {
        try {
          await deleteChatThread(id);
          setThreads((prev) => prev.filter((t) => t.id !== id));
          if (threadId === id) {
            setThreadId(null);
            setThreadTitle(null);
            setMessages([]);
            resetQuestion("");
          }
          toast.success("Chat deleted");
        } catch (err) {
          toast.error(err instanceof Error ? err.message : "Delete failed");
        }
      });
    },
    [resetQuestion, threadId]
  );

  const sendQuestion = useCallback(
    (raw: string) => {
      const q = raw.trim();
      if (!q || busy || loadingThread) return;

      setLastUserQuery(q);
      const userMsg: UserMessage = {
        id: newId(),
        role: "user",
        content: q,
      };
      stickToBottomRef.current = true;
      setMessages((prev) => [...prev, userMsg]);
      resetQuestion("");
      requestAnimationFrame(() => scrollToBottom(true));

      const assistantId = newId();
      setStreaming(true);
      void (async () => {
        let activeId: string;
        try {
          activeId = await ensureThread();
        } catch (err) {
          toast.error(toUserFacingError(err, MISSING_AI_API_KEY_MESSAGE).message);
          setMessages((prev) => prev.filter((m) => m.id !== userMsg.id));
          resetQuestion(q);
          setStreaming(false);
          return;
        }

        let placed = false;
        const patch = (fn: (m: AssistantMessage) => AssistantMessage) =>
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId && m.role === "assistant" ? fn(m) : m))
          );
        const ensurePlaceholder = () => {
          if (placed) return;
          placed = true;
          setMessages((prev) => [
            ...prev,
            { id: assistantId, role: "assistant", answer: "", recommendations: [], streaming: true },
          ]);
        };

        await streamChat(
          { question: q, threadId: activeId },
          {
            onAnswer: (delta) => {
              ensurePlaceholder();
              patch((m) => ({ ...m, answer: m.answer + delta }));
            },
            onRecommendations: (items) => {
              ensurePlaceholder();
              patch((m) => ({ ...m, recommendations: items }));
            },
            onDone: (info) => {
              ensurePlaceholder();
              patch((m) => ({ ...m, id: info.messageId || assistantId, streaming: false }));
              if (info.title) setThreadTitle(info.title);
              setThreads((prev) => {
                const next = prev.filter((t) => t.id !== activeId);
                return [
                  {
                    id: activeId,
                    title: info.title ?? null,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                  },
                  ...next,
                ];
              });
            },
            onError: (message) => {
              toast.error(message);
              setMessages((prev) => prev.filter((m) => m.id !== userMsg.id && m.id !== assistantId));
              resetQuestion(q);
            },
          }
        );
        setStreaming(false);
      })();
    },
    [busy, loadingThread, ensureThread, resetQuestion, scrollToBottom]
  );

  function fillMostRecentUserMessage() {
    const fromThread = [...messages]
      .reverse()
      .find((m): m is UserMessage => m.role === "user");
    const content = fromThread?.content || lastUserQuery;
    if (!content) return false;
    resetQuestion(content);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      const len = content.length;
      el.focus();
      el.setSelectionRange(len, len);
    });
    return true;
  }

  /**
   * The user's own typing. An edit before the dictated span slides the anchor along; an
   * edit after it changes nothing; an edit through it ends the session, because carrying
   * on would overwrite what they just wrote.
   */
  function onComposerChange(e: ChangeEvent<HTMLTextAreaElement>) {
    const next = e.target.value;
    if (anchorRef.current !== null) {
      const shifted = shiftAnchor(
        lastValueRef.current,
        next,
        anchorRef.current,
        spanRef.current.length,
      );
      if (shifted === ANCHOR_INTERFERENCE) {
        anchorRef.current = null;
        dictation.cancel();
      } else {
        anchorRef.current = shifted;
      }
    }
    lastValueRef.current = next;
    setQuestion(next);
  }

  /**
   * Every condition the mirror needs, checked together. The moment one fails it unmounts
   * and the plain field shows — the two layers look identical, so nothing jumps.
   */
  const showMirror =
    dictation.state === "listening" &&
    hasInterim &&
    interimRange !== null &&
    selectionCollapsed &&
    !composing &&
    !coarsePointer;

  function onComposerKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Escape" && dictation.listening) {
      e.preventDefault();
      dictation.stop();
      return;
    }
    if (e.key === "ArrowUp" && !e.shiftKey && !question.trim()) {
      if (fillMostRecentUserMessage()) {
        e.preventDefault();
      }
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendQuestion(question);
    }
  }

  const headerTitle = threadTitle?.trim() || "New chat";

  return (
    <>
      {/*
        Explicit viewport height so the card is always bounded.
        Internal message list is the only scroller (flex 1 1 0 + overflow-y-auto).
        Mobile offsets: top header + page title + padding + bottom nav.
        Desktop offsets: page title + vertical padding.
      */}
      {/* Sized by the flex column it sits in, NOT a viewport calc. The old
          `h-[calc(100dvh-16.5rem)]` hardcoded an assumption about how much chrome was above
          it, so the API-key notice pushed the card past the bottom of the screen and clipped
          the suggestion chips. The whole ancestor chain is bounded (app-shell `h-dvh` →
          `min-h-0 flex-1` → page `flex min-h-0 flex-1`), and ChatPanelSkeleton already sized
          itself this way — so this also removes the height jump when the panel swaps in. */}
      <div className="flex min-h-0 w-full flex-1 flex-col overflow-hidden rounded-2xl border border-border/70 bg-card">
        <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2.5 sm:px-4">
          <DropdownMenu open={historyOpen} onOpenChange={setHistoryOpen}>
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="shrink-0 text-muted-foreground"
                  aria-label="Chat history"
                />
              }
            >
              <History className="size-4" />
              <span className="hidden sm:inline">History</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-72">
              <DropdownMenuLabel>Recent chats</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {threads.length === 0 ? (
                <div className="px-2 py-3 text-xs text-muted-foreground">
                  No saved chats yet.
                </div>
              ) : (
                threads.map((thread) => (
                  <DropdownMenuItem
                    key={thread.id}
                    className="group items-start gap-2 py-2"
                    onClick={() => {
                      void loadThread(thread.id);
                      setHistoryOpen(false);
                    }}
                  >
                    <div className="min-w-0 flex-1">
                      <p
                        className={cn(
                          "truncate text-sm",
                          thread.id === threadId && "font-medium text-primary"
                        )}
                      >
                        {formatThreadLabel(thread)}
                      </p>
                    </div>
                    <button
                      type="button"
                      className="mt-0.5 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100 group-focus-within:opacity-100"
                      aria-label="Delete chat"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        removeThread(thread.id);
                      }}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </DropdownMenuItem>
                ))
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-ink">
              {headerTitle}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              Questions about people in your network
            </p>
          </div>

          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="shrink-0 text-muted-foreground"
            onClick={startNewChat}
            disabled={busy}
          >
            <Plus className="size-4" />
            <span className="hidden sm:inline">New chat</span>
          </Button>

          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() => setNotesOpen(true)}
          >
            <NotebookPen className="size-4" />
            <span className="hidden sm:inline">Notes</span>
          </Button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div
            ref={listRef}
            onScroll={onListScroll}
            className="min-h-0 flex-1 basis-0 overflow-y-auto overscroll-y-contain px-3 py-4 touch-pan-y sm:px-4"
          >
            <div
              className={cn(
                "mx-auto flex max-w-3xl flex-col gap-4 pb-2",
                // An empty thread centres its prompt in the whole area rather than
                // hugging the top; once messages exist the column goes back to
                // top-aligned so the thread reads normally.
                messages.length === 0 && !busy && !loadingThread && "h-full",
              )}
            >
              {loadingThread ? (
                <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  Loading chat…
                </div>
              ) : (
                <>
                  {messages.length === 0 && !busy && (
                    <div className="flex flex-1 flex-col items-center justify-center gap-3 py-16 text-center">
                      <p className="font-[family-name:var(--font-display)] text-xl text-ink sm:text-2xl">
                        Ask your network
                      </p>
                      <p className="max-w-md text-sm text-muted-foreground">
                        Who can help, who to follow up with, or who knows what —
                        try a suggestion below.
                      </p>
                    </div>
                  )}

                  {messages.map((msg) =>
                    msg.role === "user" ? (
                      <div key={msg.id} className="flex justify-end">
                        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-sm text-primary-foreground">
                          {msg.content}
                        </div>
                      </div>
                    ) : (
                      <div key={msg.id} className="flex justify-start">
                        <div className="max-w-[92%] space-y-3">
                          <div className="rounded-2xl rounded-bl-md border border-border/70 bg-muted/40 px-4 py-3 text-sm leading-relaxed text-foreground">
                            <ChatMarkdown>{msg.answer}</ChatMarkdown>
                          </div>
                          {msg.recommendations.length > 0 && (
                            <div className="space-y-2">
                              {msg.recommendations.map((r) => (
                                <RecommendationCard
                                  key={`${msg.id}-${r.recruiter_id || r.contact_id}`}
                                  rec={r}
                                />
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    )
                  )}

                  {awaitingFirstToken && (
                    <div className="flex justify-start">
                      <div className="flex items-center gap-2 rounded-2xl rounded-bl-md border border-border/70 bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
                        <Loader2 className="size-3.5 animate-spin" />
                        Searching your network…
                      </div>
                    </div>
                  )}
                  <div ref={threadEndRef} className="h-px w-full shrink-0" />
                </>
              )}
            </div>
          </div>

          <div className="shrink-0 border-t border-border/60 bg-card p-3 sm:p-4">
            <div className="mx-auto max-w-3xl space-y-2.5">
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Textarea
                    ref={textareaRef}
                    rows={2}
                    placeholder="Ask about your network…"
                    value={question}
                    onChange={onComposerChange}
                    onKeyDown={onComposerKeyDown}
                    onSelect={(e) => {
                      const el = e.currentTarget;
                      setSelectionCollapsed(el.selectionStart === el.selectionEnd);
                    }}
                    onCompositionStart={() => setComposing(true)}
                    onCompositionEnd={() => setComposing(false)}
                    data-dictating={dictation.listening || undefined}
                    className={cn(
                      // `field-sizing-content` has no ceiling of its own, and this sits in
                      // a fixed-height card: a long dictation would squeeze the thread away.
                      "min-h-[44px] max-h-40 w-full resize-none overflow-y-auto",
                      // Quieter than the shared primitive's `ring-3 ring-ring/50`. The
                      // border colour carries the focus indicator so it stays perceptible
                      // (WCAG 2.4.7) and the ring is a soft halo rather than a slab.
                      // Scoped here on purpose — the primitive dresses every input in the app.
                      "focus-visible:ring-[2px] focus-visible:ring-ring/20",
                      dictation.listening &&
                        "border-primary/40 bg-primary/[0.035] dark:bg-primary/[0.06]",
                      // The mirror paints the glyphs while it is up. The caret is left
                      // visible so the field still reads as focused and editable.
                      showMirror && "text-transparent caret-ink selection:text-foreground",
                    )}
                    style={
                      dictation.listening ? { scrollbarGutter: "stable" } : undefined
                    }
                    disabled={busy || loadingThread}
                  />
                  {showMirror && interimRange && (
                    <ComposerMirror
                      value={question}
                      interimStart={interimRange[0]}
                      interimEnd={interimRange[1]}
                      textareaRef={textareaRef}
                    />
                  )}
                </div>
                <DictationButton
                  state={dictation.state}
                  level={dictation.level}
                  disabled={busy || loadingThread}
                  onToggle={(source) => {
                    dictation.toggle();
                    // Pointer users want to carry straight on into the field; keyboard
                    // users would lose the control they just pressed.
                    if (source === "pointer") textareaRef.current?.focus();
                  }}
                />
                <Button
                  type="button"
                  size="icon"
                  disabled={
                    busy ||
                    loadingThread ||
                    (!question.trim() && !lastUserQuery)
                  }
                  className="h-11 w-11 shrink-0 bg-primary text-primary-foreground hover:bg-primary/90"
                  onClick={() => {
                    if (!question.trim()) {
                      fillMostRecentUserMessage();
                      return;
                    }
                    sendQuestion(question);
                  }}
                  aria-label={question.trim() ? "Send" : "Recall last message"}
                >
                  {busy ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <ArrowUp className="size-4" />
                  )}
                </Button>
              </div>
              {/* State only — never the transcript, which would re-announce every
                  150ms as the recogniser revises it. */}
              <div className="sr-only" aria-live="polite">
                {dictationNote}
              </div>
              {/* The visible twin. `aria-hidden` because the live region above already
                  announces this — without it, screen readers say it twice. */}
              {dictation.listening && (
                <div
                  aria-hidden
                  className="flex items-center gap-1.5 text-[11px] text-primary"
                >
                  <span className="relative flex size-1.5">
                    {!reducedMotion && (
                      <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-70" />
                    )}
                    <span className="relative inline-flex size-1.5 rounded-full bg-primary" />
                  </span>
                  {dictation.state === "requesting"
                    ? "Starting…"
                    : "Listening — click the mic or press Escape to stop"}
                </div>
              )}
              <div className="flex flex-wrap gap-1.5">
                {SUGGESTION_CHIPS.map((chip) => (
                  <button
                    key={chip}
                    type="button"
                    disabled={busy || loadingThread}
                    className="rounded-full border border-border/70 px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                    onClick={() => sendQuestion(chip)}
                  >
                    {chip}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      <Sheet open={notesOpen} onOpenChange={setNotesOpen}>
        <SheetContent
          side="right"
          className="w-full gap-0 overflow-y-auto sm:max-w-md"
        >
          <SheetHeader className="border-b border-border/60">
            <SheetTitle>Update from notes</SheetTitle>
            <SheetDescription>
              Paste notes to create or update many contacts.
            </SheetDescription>
          </SheetHeader>
          <div className="p-4">
            <BulkNotesPanel
              compact
              onSaved={(res) => {
                setNotesOpen(false);
                router.refresh();
                const peopleCount = res.created + res.updated;
                toast.success(
                  `Saved ${peopleCount} ${peopleCount === 1 ? "person" : "people"} and ${res.remindersCreated} ${res.remindersCreated === 1 ? "reminder" : "reminders"}`,
                  {
                    action: {
                      label: "See what was created",
                      onClick: () => router.push(`/capture/${res.batchId}`),
                    },
                  }
                );
              }}
            />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

function RecommendationCard({
  rec,
}: {
  rec: ChatResult["recommendations"][number];
}) {
  const [pending, start] = useTransition();
  const href = rec.recruiter_id
    ? `/recruiters/${rec.recruiter_id}`
    : rec.contact_id
      ? `/contacts/${rec.contact_id}`
      : "#";
  const canRemind = Boolean(rec.contact_id);

  return (
    <div className="rounded-xl border border-border/70 bg-background p-3.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <Link
            href={href}
            className="text-sm font-medium text-primary hover:underline"
          >
            {rec.name}
          </Link>
          {rec.recruiter_id && (
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Recruiter
            </p>
          )}
          <p className="mt-0.5 text-xs text-muted-foreground">{rec.reason}</p>
          <p className="mt-1.5 text-xs">
            <span className="font-medium">Next: </span>
            {rec.suggested_action}
          </p>
        </div>
        {canRemind && (
          <Button
            size="xs"
            variant="outline"
            disabled={pending}
            onClick={() =>
              start(async () => {
                await createReminder({
                  contactId: rec.contact_id!,
                  title: `Reach out to ${rec.name}`,
                  description: rec.suggested_action,
                  dueDate: new Date(
                    Date.now() + 3 * 24 * 60 * 60 * 1000
                  ).toISOString(),
                });
                toast.success("Reminder created");
              })
            }
          >
            Reminder
          </Button>
        )}
      </div>
      {rec.draft_message && (
        <div className="mt-2.5 rounded-lg bg-muted/50 p-2.5 text-xs">
          <Badge variant="secondary" className="mb-1.5 text-[10px]">
            Draft
          </Badge>
          <p className="whitespace-pre-wrap text-muted-foreground">
            {rec.draft_message}
          </p>
        </div>
      )}
    </div>
  );
}
