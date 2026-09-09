"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
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
import { ComposerHighlights } from "@/components/chat/composer-highlights";
import {
  COMPOSER_TEXT_BOX,
  ComposerMirror,
  useCoarsePointer,
} from "@/components/chat/composer-mirror";
import {
  ComposerToolsMenu,
  type ComposerInsert,
} from "@/components/chat/composer-tools-menu";
import { MentionText } from "@/components/chat/mention-text";
import {
  MentionAutocomplete,
  type MentionOption,
} from "@/components/chat/mention-autocomplete";
import { useMentionAutocomplete } from "@/components/chat/use-mention-autocomplete";
import {
  SuggestionCards,
  SuggestionCardsSkeleton,
} from "@/components/chat/suggestion-cards";
import { useChatSuggestions } from "@/components/chat/use-chat-suggestions";
import { DictationButton } from "@/components/chat/dictation-button";
import { ComposerSendButton } from "@/components/chat/composer-send-button";
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
import {
  activeMentions,
  mentionAfterCaret,
  mentionBeforeCaret,
  mentionDeletionRange,
  mentionToken,
  snapCaretOutOfMention,
  uniqueMentionName,
} from "@/lib/chat-mentions";
import { ANCHOR_INTERFERENCE, shiftAnchor, spliceSpan } from "@/lib/dictation";
import { useDictation } from "@/lib/use-dictation";

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
  /**
   * Who was attached when this was sent, so the bubble marks exactly those names.
   *
   * Now persisted, so it survives a reload. `MentionText` still has its shape heuristic
   * for messages written before the column existed, but it is a fallback rather than the
   * normal path — it over-reaches on "@Marcus Webb Who else", where a capitalised word
   * after a name looks like part of it.
   */
  mentionNames?: string[];
};

/**
 * A person the user attached with `+`, and the token that stands for them in the box.
 *
 * The token is the contract: `activeMentions` re-derives the attachment list from the text
 * on every change, so deleting the words removes the person and nothing has to watch for it.
 */
type ContextPerson = { id: string; name: string };

type AssistantMessage = {
  id: string;
  role: "assistant";
  answer: string;
  recommendations: ChatRecommendation[];
  /** True while the answer is still arriving from `/api/chat`. */
  streaming?: boolean;
};

type ThreadMessage = UserMessage | AssistantMessage;

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
  /** People attached with `+`, kept in step with the tokens actually in the box. */
  const [attached, setAttached] = useState<ContextPerson[]>([]);
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
  /** Where the dictated span begins, or null when no session owns any text. */
  const anchorRef = useRef<number | null>(null);
  /** What currently occupies that span, so the next result can replace exactly it. */
  const spanRef = useRef("");
  /** The value as of the last change, to tell the user's edits from our own. */
  const lastValueRef = useRef("");
  const pendingCaretRef = useRef<number | null>(null);
  /**
   * Where the caret was last time, so a snap out of a mention knows which way it was
   * going. Without the direction, arrowing left out of a token bounces off its own
   * trailing edge and the caret looks stuck.
   */
  const lastCaretRef = useRef<number | null>(null);
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
    // Deliberately does NOT touch `attached`. A failed send clears the box and then puts
    // the text back, and pruning on the way through left the restored `@Marcus Webb` grey
    // and unattached — the retry would have sent no context at all. The registry is inert
    // while its token is absent, so keeping it costs nothing; it is cleared where a reset
    // really does mean a different conversation (`clearComposer`).
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

  /**
   * The text decides who is attached, not the other way round.
   *
   * `attached` is only a registry of what has been picked; this is the live set, derived
   * from the box on every render. So deleting `@Marcus Webb` drops Marcus with no effect
   * watching for it, whether the deletion came from typing, dictating or a programmatic
   * clear. A stale registry entry is inert — it fails to appear here — and is swept by
   * `clearComposer`.
   */
  const context = useMemo(() => activeMentions(question, attached), [question, attached]);
  /** Only attached people are painted green: the mark means "this is context", not "@". */
  const attachedNames = useMemo(() => context.map((p) => p.name), [context]);

  // Mirrors the empty state's own condition, so the prompt above ("try a suggestion below")
  // and the row it points at appear and disappear together.
  const showSuggestions = messages.length === 0 && !loadingThread;
  const suggestions = useChatSuggestions(showSuggestions);

  /**
   * Empty the box and forget what was attached to it.
   *
   * For the resets that mean "a different conversation" — a new chat, a thread loaded from
   * history, the current thread deleted. Sending is not one of them: the send path clears
   * the box but may have to put the question back.
   */
  const clearComposer = useCallback(() => {
    resetQuestion("");
    setAttached([]);
  }, [resetQuestion]);

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
                mentionNames: row.attachedContacts?.length
                  ? row.attachedContacts.map((c) => c.name)
                  : undefined,
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
      clearComposer();
      requestAnimationFrame(() => scrollToBottom(false));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load chat");
    } finally {
      setLoadingThread(false);
    }
  }, [clearComposer, scrollToBottom]);

  const startNewChat = useCallback(() => {
    start(async () => {
      try {
        const created = await createChatThread();
        setThreadId(created.id);
        setThreadTitle(created.title);
        setMessages([]);
        clearComposer();
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
  }, [clearComposer]);

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
            clearComposer();
          }
          toast.success("Chat deleted");
        } catch (err) {
          toast.error(err instanceof Error ? err.message : "Delete failed");
        }
      });
    },
    [clearComposer, threadId]
  );

  const sendQuestion = useCallback(
    (raw: string, opts?: { contextContactIds?: readonly string[] }) => {
      const q = raw.trim();
      if (!q || busy || loadingThread) return;

      setLastUserQuery(q);
      // Resolved from the text, not from `attached` directly: a token the user deleted
      // must not still ship that person's history to the model.
      const sending = activeMentions(q, attached);
      // A suggestion card names a person without an `@` token, so its id arrives here
      // rather than being re-derived from the text. Without it the card's question is
      // answered from a notes blob: `loadKnowledgeSnippets` keeps only LinkedIn messages,
      // so the interaction the card is *about* never reaches the model.
      const contextContactIds = [
        ...new Set([...sending.map((p) => p.id), ...(opts?.contextContactIds ?? [])]),
      ];
      const userMsg: UserMessage = {
        id: newId(),
        role: "user",
        content: q,
        mentionNames: sending.length ? sending.map((p) => p.name) : undefined,
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
          {
            question: q,
            threadId: activeId,
            contextContactIds,
          },
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
    [attached, busy, loadingThread, ensureThread, resetQuestion, scrollToBottom]
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
    // The caret has already moved by the time this fires, so `selectionStart` is where the
    // user is — which is what decides whether they are inside an `@`. `onSelect` alone is
    // not enough: it does not fire for every keystroke.
    const caret = e.target.selectionStart ?? next.length;
    lastCaretRef.current = caret;
    mention.refresh(next, caret);
  }

  /**
   * Splice text from the `+` menu in at the caret.
   *
   * Goes through the same anchor bookkeeping as typing: it is a user edit as far as an
   * in-flight dictation is concerned, so `onComposerChange`'s logic has to see it or the
   * dictated span would drift out of alignment with the field.
   */
  const spliceComposer = useCallback(
    (from: number, to: number, text: string) => {
      const el = textareaRef.current;
      const value = el?.value ?? "";
      // Padding is for inserting; a deletion passes "" and must not gain a space for it.
      const pad = text.length > 0;
      const needsLeading = pad && from > 0 && !/\s$/.test(value.slice(0, from));
      const needsTrailing = pad && !/^\s/.test(value.slice(to));
      const insert = `${needsLeading ? " " : ""}${text}${needsTrailing ? " " : ""}`;
      const next = value.slice(0, from) + insert + value.slice(to);
      const caret = from + insert.length;

      if (anchorRef.current !== null) {
        const shifted = shiftAnchor(
          lastValueRef.current,
          next,
          anchorRef.current,
          spanRef.current.length,
        );
        if (shifted === ANCHOR_INTERFERENCE) {
          anchorRef.current = null;
          cancelDictationRef.current();
        } else {
          anchorRef.current = shifted;
        }
      }
      lastValueRef.current = next;
      pendingCaretRef.current = caret;
      setQuestion(next);
      requestAnimationFrame(() => textareaRef.current?.focus());
    },
    [],
  );

  /** The caret case: `+` menu picks, which have no range of their own to replace. */
  const insertAtCaret = useCallback(
    (text: string) => {
      const el = textareaRef.current;
      const value = el?.value ?? "";
      const from = el?.selectionStart ?? value.length;
      const to = el?.selectionEnd ?? from;
      spliceComposer(from, to, text);
    },
    [spliceComposer],
  );

  /**
   * Register a person and hand back the token that stands for them.
   *
   * Shared by the `+` menu and the `@` type-ahead so the two cannot mint different tokens
   * for the same contact — which would leave one of them grey and unattached.
   */
  const tokenForPerson = useCallback(
    (contactId: string, nameCandidates: string[]) => {
      const already = attached.find((p) => p.id === contactId);
      // Re-picking someone reuses their token; a namesake gets a longer one, or the two
      // would share a token and `activeMentions` could only ever resolve it to one of them.
      const name =
        already?.name ?? uniqueMentionName(nameCandidates, attached.map((p) => p.name));
      if (!already) setAttached((prev) => [...prev, { id: contactId, name }]);
      return mentionToken(name);
    },
    [attached],
  );

  /**
   * A pick from the `+` menu.
   *
   * A meeting is only ever words. A person is words plus a claim — the `@Name` token goes
   * in the box and the contact id rides along to the send path, which is what puts their
   * role and timeline in front of the model.
   */
  const onToolInsert = useCallback(
    (item: ComposerInsert) => {
      if (item.kind === "text") {
        insertAtCaret(item.text);
        return;
      }
      if (item.kind === "event") {
        const token = tokenForPerson(item.contactId, item.nameCandidates);
        insertAtCaret(`${item.before}${token}${item.after}`);
        return;
      }
      insertAtCaret(tokenForPerson(item.contactId, item.nameCandidates));
    },
    [insertAtCaret, tokenForPerson],
  );

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

  // Off while the recogniser owns the box — an accepted row splices text the dictated span
  // is anchored against — and off mid-IME, where `.value` is not yet what the user sees.
  const mention = useMentionAutocomplete(
    !dictation.listening && !composing && !busy && !loadingThread,
  );
  const mentionListboxId = useId();
  const mentionOptionId = (index: number) => `${mentionListboxId}-${index}`;

  /**
   * Take a row from the `@` menu, replacing the half-typed token rather than the caret.
   *
   * A person becomes their `@Name` token and is attached; an event becomes prose, because
   * an event is not someone the model can be handed a timeline for. Either way the `@` and
   * everything typed after it goes — the fragment was scaffolding, not text the user meant.
   */
  const acceptMention = useCallback(
    (option: MentionOption) => {
      const el = textareaRef.current;
      if (!el || mention.start === null) return;
      const to = el.selectionStart ?? el.value.length;
      // Both kinds mint a token; an event just wraps it in a sentence. That is what makes
      // a picked meeting as well-grounded as a picked person — the same attachment, the
      // same green mark, the same atomic delete.
      const token = tokenForPerson(option.contactId, option.nameCandidates);
      const text = option.kind === "person" ? token : `${option.before}${token}${option.after}`;
      spliceComposer(mention.start, to, text);
      // Dismiss rather than reset: the completed token still parses as a query, so a plain
      // reset would reopen the menu on the name that was just accepted.
      mention.dismiss();
    },
    [mention, spliceComposer, tokenForPerson],
  );

  function onComposerKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // First refusal, before Enter sends and before ArrowUp recalls: while the type-ahead is
    // up those keys belong to it, and the caret never leaves the textarea to say so.
    if (mention.open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        mention.move(e.key === "ArrowDown" ? 1 : -1);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        const option = mention.active();
        if (option) {
          e.preventDefault();
          acceptMention(option);
          return;
        }
      }
      if (e.key === "Escape") {
        e.preventDefault();
        mention.dismiss();
        return;
      }
    }

    // An attached `@Name` reads as one object, so it deletes as one. Only when the caret is
    // flush against it and nothing is selected — a Backspace anywhere else is ordinary, and
    // a name that is not attached is just words.
    if (e.key === "Backspace" || e.key === "Delete") {
      const el = e.currentTarget;
      if (el.selectionStart === el.selectionEnd) {
        const caret = el.selectionStart;
        const whole =
          e.key === "Backspace"
            ? mentionBeforeCaret(el.value, caret, attachedNames)
            : mentionAfterCaret(el.value, caret, attachedNames);
        if (whole) {
          e.preventDefault();
          const { from, to } = mentionDeletionRange(el.value, whole);
          spliceComposer(from, to, "");
          return;
        }
      }
    }
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
                          <MentionText text={msg.content} names={msg.mentionNames} />
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
            {/* `relative`: the `@` type-ahead anchors to this box's top edge, which is the
                top of the composer pill. */}
            <div className="relative mx-auto max-w-3xl space-y-2.5">
              {mention.open && (
                <MentionAutocomplete
                  options={mention.options}
                  activeIndex={mention.activeIndex}
                  loading={mention.loading}
                  listboxId={mentionListboxId}
                  optionId={mentionOptionId}
                  onPick={acceptMention}
                />
              )}
              {/* One pill holding every control, rather than a field with satellites.
                  `items-end` keeps the buttons on the last line as the field grows. */}
              <div
                className={cn(
                  "flex items-end gap-1 rounded-[1.75rem] border border-input bg-transparent px-1.5 py-1.5 transition-colors",
                  "dark:bg-input/30",
                  // Focus lives on the pill now: the field inside has no border or ring of
                  // its own, so without this there would be no focus indicator at all.
                  "focus-within:border-ring focus-within:ring-[2px] focus-within:ring-ring/20",
                  dictation.listening &&
                    "border-primary/40 bg-primary/[0.035] dark:bg-primary/[0.06]",
                )}
              >
                <ComposerToolsMenu
                  disabled={busy || loadingThread}
                  onInsert={onToolInsert}
                />
                {/* No vertical padding here: the mirror is `inset-0` of this box, so any
                    padding on it would offset the field from its ghost layer. The field and
                    the mirror each carry their own py instead. */}
                <div className="relative flex-1">
                  {/* The green marks. They show through because the field's own background
                      is transparent — the pill owns it — and they stay behind the glyphs
                      because of the z ladder, not this DOM order. */}
                  <ComposerHighlights
                    value={question}
                    names={attachedNames}
                    textareaRef={textareaRef}
                  />
                  <Textarea
                    ref={textareaRef}
                    rows={1}
                    placeholder="Ask about your network…"
                    value={question}
                    onChange={onComposerChange}
                    onKeyDown={onComposerKeyDown}
                    onSelect={(e) => {
                      const el = e.currentTarget;
                      const collapsed = el.selectionStart === el.selectionEnd;
                      setSelectionCollapsed(collapsed);
                      if (!collapsed) {
                        lastCaretRef.current = null;
                        mention.reset();
                        return;
                      }
                      // The caret may not come to rest inside a token. Re-setting the
                      // range fires `select` again, which terminates because an edge is a
                      // legal position and snaps to null.
                      const prev = lastCaretRef.current;
                      const prefer =
                        prev === null || prev === el.selectionStart
                          ? "nearest"
                          : el.selectionStart < prev
                            ? "left"
                            : "right";
                      const snapped = composing
                        ? null
                        : snapCaretOutOfMention(
                            el.value,
                            el.selectionStart,
                            prefer,
                            attachedNames,
                          );
                      const caret = snapped ?? el.selectionStart;
                      if (snapped !== null) el.setSelectionRange(snapped, snapped);
                      lastCaretRef.current = caret;
                      // Arrowing into an existing `@Marcus` should offer it again.
                      mention.refresh(el.value, caret);
                    }}
                    onCompositionStart={() => setComposing(true)}
                    onCompositionEnd={() => setComposing(false)}
                    onBlur={() => mention.reset()}
                    role="combobox"
                    aria-autocomplete="list"
                    aria-expanded={mention.open}
                    aria-controls={mention.open ? mentionListboxId : undefined}
                    aria-activedescendant={
                      mention.open ? mentionOptionId(mention.activeIndex) : undefined
                    }
                    data-dictating={dictation.listening || undefined}
                    className={cn(
                      // Bare field: the pill around it owns the border, background, focus
                      // ring and padding. `field-sizing-content` has no ceiling of its own
                      // and this sits in a fixed-height card, so the cap stays.
                      // `min-h-9` matches the 36px control buttons exactly, and py-2 centres
                      // a single 20px line inside it — so with `items-end` the text sits on
                      // the same axis as the mic and send. Growing past one line just adds
                      // height downwards and the buttons stay on the last line.
                      // `relative z-[1]` is load-bearing: it lifts the field above the
                      // mention marks, which are positioned and would otherwise paint over
                      // the glyphs whatever the DOM order.
                      "relative z-[1] min-h-9 max-h-40 w-full resize-none overflow-y-auto",
                      COMPOSER_TEXT_BOX,
                      "rounded-none border-0 bg-transparent shadow-none",
                      "focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent",
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
                <ComposerSendButton
                  mode={question.trim() ? "send" : "recall"}
                  busy={busy}
                  disabled={
                    busy ||
                    loadingThread ||
                    (!question.trim() && !lastUserQuery)
                  }
                  onClick={() => {
                    if (!question.trim()) {
                      fillMostRecentUserMessage();
                      return;
                    }
                    sendQuestion(question);
                  }}
                />
              </div>
              {/* State only — never the transcript, which would re-announce every
                  150ms as the recogniser revises it. */}
              <div className="sr-only" aria-live="polite">
                {dictationNote}
              </div>
              {/* The visible twin lives on the mic itself (`dictation-button.tsx`), not
                  here: as a row it pushed the suggestions down every time dictation
                  started, and the cue belongs to the control it describes. */}
              {/* Only while the thread is empty. The footer is `shrink-0` above a message
                  list with no floor, so a permanent row would take that height out of the
                  answers for the whole conversation. The skeleton is the same size as the
                  cards, so nothing moves when they land. */}
              {showSuggestions &&
                (suggestions === null ? (
                  <SuggestionCardsSkeleton />
                ) : (
                  <SuggestionCards
                    items={suggestions}
                    disabled={busy || loadingThread}
                    onPick={(s) =>
                      sendQuestion(s.question, {
                        // A mention card carries two people; everything else nought or one.
                        contextContactIds: s.contactIds.length ? s.contactIds : undefined,
                      })
                    }
                  />
                ))}
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
