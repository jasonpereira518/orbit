"use client";

import { useViewerPlan } from "@/components/viewer-plan";
import { emitTourEvent } from "@/lib/tour/tour-events";
import { tourAnchor } from "@/lib/tour/tour-anchors";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type KeyboardEvent,
} from "react";
import Link from "next/link";
import {
  ArrowDown,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  Globe,
  History,
  Loader2,
  Mail,
  NotebookPen,
  Paperclip,
  Telescope,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "@/lib/toast";
import { ChatThreadProvider } from "@/components/chat/chat-thread-context";
import { DraftEditor } from "@/components/chat/draft-editor";
import { GmailSendDialog } from "@/components/chat/gmail-send-dialog";
import { WritingInstructionsField } from "@/components/chat/writing-instructions-field";
import { ChatMemoriesField } from "@/components/chat/chat-memories-field";
import { clearSendResume, peekSendResumeFor } from "@/lib/chat-send-resume";
import { describeOAuthReason, friendlyError } from "@/lib/errors";
import {
  createChatThread,
  deleteChatThread,
  getChatThread,
  listChatThreads,
  pinChatThread,
  renameChatThread,
  saveChatDraft,
  searchChatThreads,
  steerChatTurn,
  stopChatTurn,
  switchChatVersion,
  updateChatThreadContext,
  type ChatThreadPage,
} from "@/actions/chat";
import { CAPTURE_FILE_ACCEPT } from "@/lib/capture/ingest-client";
import { useCaptureIngest } from "@/lib/capture/use-capture-ingest";
import { readRailOpen, writeRailOpen } from "@/lib/chat-rail-pref";
import { readChatDeep, readChatWeb, writeChatDeep, writeChatWeb } from "@/lib/chat-mode-pref";
import { ScanControls } from "@/components/scan/scan-controls";
import {
  COMPOSER_TEXT_BOX,
  ComposerMirror,
  useCoarsePointer,
} from "@/components/composer/composer-mirror";
import {
  FIELD_BARE,
  MentionComposer,
  type MentionComposerHandle,
} from "@/components/composer/mention-composer";
import {
  ComposerToolsMenu,
  type ComposerInsert,
} from "@/components/chat/composer-tools-menu";
import { MentionText } from "@/components/chat/mention-text";
import {
  SuggestionCards,
  SuggestionCardsSkeleton,
} from "@/components/chat/suggestion-cards";
import { useChatSuggestions } from "@/components/chat/use-chat-suggestions";
import { DictationButton } from "@/components/chat/dictation-button";
import { OrbitVoiceEntry } from "@/components/chat/voice-entry";
import { CHAT_QUESTION_MAX_CHARS } from "@/lib/chat-question";
import { chatAsMarkdown, chatExportFileName, downloadMarkdown } from "@/lib/chat-export";
import { CHAT_ATTACH_ACCEPT, readAttachment } from "@/lib/chat-attach-client";
import { CHAT_ATTACHMENTS_MAX, type ChatAttachment } from "@/lib/chat-attachments";
import { notifyAnswerLanded } from "@/lib/chat-answer-notify";
import { afterTurn, enqueue, setSteering, steeredId, type QueuedMessage } from "@/lib/chat-queue";
import { ChatMarkdown } from "@/components/chat/chat-markdown";
import { ChatActivity } from "@/components/chat/chat-activity";
import { OrbitMark } from "@/components/chat/orbit-mark";
import { AnswerActions } from "@/components/chat/answer-actions";
import { ReminderButton } from "@/components/chat/reminder-button";
import { ChatHistoryRail } from "@/components/chat/chat-history-rail";
import { Skeleton } from "@/components/ui/skeleton";
import { headerTitleAfterAnswer, threadsAfterAnswer } from "@/lib/chat-answer-landed";
import { createThreadPrefetcher } from "@/lib/chat-thread-prefetch";
import type { ChatStep } from "@/lib/chat-stream-protocol";
import type { EvidenceSource } from "@/lib/chat-evidence";
import type { StoredProposedAction } from "@/lib/chat-proposed-actions";
import { ProposedActionsList } from "@/components/chat/proposed-actions";
import type { ChatPerson } from "@/components/chat/chat-markdown";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
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
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";
import type { ChatRecommendation } from "@/db/schema";
import { streamChat, type DoneInfo } from "@/lib/chat-stream-client";
import { directivesAsText, peopleIdsIn, type ChatBlocks } from "@/lib/chat-directives";
import {
  createStreamSmoother,
  prefersReducedMotionNow,
  type StreamSmoother,
} from "@/lib/stream-smoother";
import { activeMentions } from "@/lib/chat-mentions";
import { addMentionPick } from "@/lib/mentions/mention-picks";
import { ANCHOR_INTERFERENCE, shiftAnchor, spliceSpan } from "@/lib/dictation";
import { TOAST_COPY } from "@/lib/toast-copy";
import { draftContactFollowUp } from "@/actions/contacts";
import { useDictation } from "@/lib/use-dictation";
import {
  clearTurnInFlight,
  inFlightThreadId,
  DEEP_RESUME_WINDOW_MS,
  markTurnInFlight,
  pendingTurn,
  RESUME_POLL_MS,
} from "@/lib/chat-turn-resume";

export type ThreadSummary = {
  id: string;
  title: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  /** Set when the person pinned it. */
  pinnedAt?: Date | string | null;
};

/**
 * A page of the history list read from the server, in place of the list on screen — except
 * for the thread that is open. The server list carries titled threads only, so a chat just
 * started (untitled until its first answer lands) is only in the panel's own list, and the
 * rail promises the open thread stays visible however empty it is.
 */
function withOpenThread(
  server: readonly ThreadSummary[],
  onScreen: readonly ThreadSummary[],
  openId: string | null
): ThreadSummary[] {
  if (!openId || server.some((t) => t.id === openId)) return [...server];
  const open = onScreen.find((t) => t.id === openId);
  return open ? [open, ...server] : [...server];
}

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
  /** The names of files attached to this question. */
  fileNames?: string[];
};

/** A file in the composer: being read, read and ready to send, or unreadable. */
type FileChip = {
  id: string;
  name: string;
  status: "reading" | "ready" | "failed";
  attachment?: ChatAttachment;
  error?: string;
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
  /**
   * The stages the server reported for this answer, newest state per stage.
   *
   * Kept per message rather than in one panel-level slot so scrolling back through a thread
   * still shows what each individual answer did, and so a new question cannot overwrite the
   * record of the previous one.
   */
  steps?: ChatStep[];
  /** Next questions derived from what retrieval found. Never model-generated. */
  followUps?: string[];
  /**
   * The contacts retrieval grounded this answer in. Gives a recommendation card its role and
   * company, and tells the prose which names are safe to link. Not persisted, so a reloaded
   * thread falls back to what the recommendation itself carries.
   */
  retrieved?: DoneInfo["retrieved"];
  /** Every source this answer cited, keyed by its `[eN]` id — see `@/lib/chat-evidence`. */
  evidence?: Record<string, EvidenceSource>;
  /** Actions this answer proposed — see `@/lib/chat-proposed-actions`. */
  proposedActions?: StoredProposedAction[];
  /** Thumbs already on this answer, when it came back from a saved thread. */
  feedback?: "up" | "down" | null;
  /**
   * True once the server has a row for this answer.
   *
   * A stopped or failed turn keeps its text on screen but was never persisted, so it has
   * nothing to rate — and saying so is better than offering a button that would fail.
   */
  persisted?: boolean;
  /** The user cut this answer short. */
  stopped?: boolean;
  /** The stream failed partway, with this message; what arrived before it stays on screen. */
  failed?: string;
  /**
   * What this answer's `::people` / `::list` blocks show, from the stream. Absent on a
   * reloaded answer, whose lists are stored expanded and whose people are `recommendations`.
   */
  blocks?: ChatBlocks;
  /**
   * Drafts on this answer that have already been emailed, by contact id → send time. Read
   * from the timeline when a thread loads, so a card cannot offer to send again what has gone.
   */
  sentTo?: Record<string, string>;
};

type ThreadMessage = UserMessage | AssistantMessage;

/** One version of the last turn — see `getChatThread`'s `versions` and `@/lib/chat-versions`. */
type VersionRow = { version: number; userMessageId: string; assistantMessageId: string };
/** One shared empty list, so a non-last AssistantBubble's `versions` prop keeps its identity. */
const EMPTY_VERSIONS: VersionRow[] = [];

function newId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function formatSentAt(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
}

function formatThreadLabel(thread: ThreadSummary) {
  return thread.title?.trim() || "New chat";
}

/**
 * `/chat?q=…` — where the command palette sends a question typed on a page that has no ask
 * bar. Read as the initial value: this panel is `ssr: false` (see `ChatPanelLazy`), so no
 * server render exists for a window-derived value to disagree with. Prefilled, never sent:
 * having just landed on a new page, the person should see the question before it goes.
 */
function initialQuestionFromUrl() {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get("q")?.trim() ?? "";
}

/**
 * `/chat?contact=<id>&name=…` — the contact page's "Ask": that person attached, their token
 * waiting in the box. Same `addMentionPick` as the composer's `+`, so the token and the pick
 * cannot disagree. Prefilled, never sent, like `?q=`.
 */
function initialAttachFromUrl(): { picks: ContextPerson[]; token: string } | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const id = params.get("contact")?.trim() ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  return addMentionPick([], id, [params.get("name")?.trim()]);
}

type LoadedThread = Awaited<ReturnType<typeof getChatThread>>;

/**
 * Wait for an answer the server is still writing on a thread that was left mid-turn, then put
 * it on screen. Gives up quietly once `pendingTurn` does (the window passes), showing the
 * thread as it stands. `stillOn` says whether this thread is still the one being shown.
 */
async function awaitPendingAnswer(id: string, stillOn: () => boolean): Promise<LoadedThread | null> {
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, RESUME_POLL_MS));
    if (!stillOn()) return null;
    // A failed read (the thread deleted elsewhere, say) ends the wait; reopening retries.
    const current = await getChatThread(id).catch(() => null);
    if (!current || !stillOn()) return null;
    if (!pendingTurn(id, current.messages)) return current;
  }
}

export function ChatPanel({
  initialThreads = null,
}: {
  /**
   * The history list's first page as the page read it on the server, so the rail paints with
   * it rather than fetching after mount. `null` when the page could not read it: the panel
   * then loads it itself, as it always did, and shows a placeholder list until that settles.
   */
  initialThreads?: ChatThreadPage | null;
} = {}) {
  const { planConfig } = useViewerPlan();
  const [threads, setThreads] = useState<ThreadSummary[]>(() => initialThreads?.threads ?? []);
  /**
   * Whether the history list has been read at least once. Until then an empty list means
   * "not known yet", not "none" — the rail shows a placeholder, never "no saved chats".
   */
  const [threadsLoaded, setThreadsLoaded] = useState(initialThreads !== null);
  /** Where the next (older) page of history starts; null when everything has been read. */
  const [olderCursor, setOlderCursor] = useState<string | null>(
    () => initialThreads?.nextCursor ?? null
  );
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [threadId, setThreadId] = useState<string | null>(null);
  /**
   * A NEW server list — the page re-rendered (`FreshOnArrival` refreshing a copy that came
   * out of the router cache, or any other `router.refresh()`) — replaces the one on screen.
   * This is what lets the mount below skip its own read: a page old enough to be stale is
   * refreshed on arrival, and its fresh list lands here. Adjusted during render (React's
   * "storing information from previous renders"), so there is no frame showing the old list.
   */
  const [adoptedInitial, setAdoptedInitial] = useState(initialThreads);
  if (initialThreads !== adoptedInitial) {
    setAdoptedInitial(initialThreads);
    if (initialThreads) {
      setThreads((prev) => withOpenThread(initialThreads.threads, prev, threadId));
      setOlderCursor(initialThreads.nextCursor);
      setThreadsLoaded(true);
    }
  }
  const [threadTitle, setThreadTitle] = useState<string | null>(null);
  /** Every version of the current thread's LAST turn, oldest first. One entry is the normal case. */
  const [versions, setVersions] = useState<VersionRow[]>([]);
  /** The slot `versions` belongs to — needed to call `switchChatVersion`. */
  const [versionSlot, setVersionSlot] = useState<string | null>(null);
  /** Which user bubble is mid-edit, if any. Only the LAST one is ever editable. */
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [urlAttach] = useState(initialAttachFromUrl);
  const [question, setQuestion] = useState(() => (urlAttach ? `${urlAttach.token} ` : initialQuestionFromUrl()));
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  /** The list on screen, readable from async work (a thread revalidation checks it is untouched). */
  const messagesRef = useRef(messages);
  useLayoutEffect(() => {
    messagesRef.current = messages;
  });
  const [contextOpen, setContextOpen] = useState(false);
  const [contextSaving, setContextSaving] = useState(false);
  /**
   * Photo/webcam/phone-QR OCR for the context box, reusing the same media-to-text pipeline
   * as Capture's Messy Notes tab (`ScanControls` + `useCaptureIngest`) — server-side OCR
   * only, never the contact-extraction step, since nothing here ever calls Extract.
   */
  const contextIngest = useCaptureIngest({ sourceKind: "messy" });
  // Destructured for stable `useCallback` deps: `contextIngest` itself is a fresh object
  // every render, but `setNotes` (a `useState` setter) and `reset` (its own `useCallback`)
  // are not.
  const { setNotes: setContextNotes, reset: resetContext } = contextIngest;
  const [historyOpen, setHistoryOpen] = useState(false);
  // Read in the initializer, which is safe because this panel is `ssr: false` — there is no
  // server render for a stored value to disagree with (same reasoning as the `?q=` seed).
  const [railOpen, setRailOpen] = useState(readRailOpen);
  const toggleRail = useCallback(() => {
    setRailOpen((open) => {
      const next = !open;
      writeRailOpen(next);
      return next;
    });
  }, []);
  const [loadingThread, setLoadingThread] = useState(false);
  const [lastUserQuery, setLastUserQuery] = useState("");
  /**
   * People attached with `+` or `@` — a registry of what has been picked, never the live
   * set.
   *
   * Which of them the text still refers to is re-derived from the box on every render, by
   * `MentionComposer` for the green marks and by `sendQuestion` for what actually reaches
   * the model. Both ask `activeMentions`, so deleting `@Marcus Webb` drops Marcus with
   * nothing watching for it, and a stale entry here is inert because it appears in neither.
   * `clearComposer` sweeps them.
   */
  const [attached, setAttached] = useState<ContextPerson[]>(() => urlAttach?.picks ?? []);
  const [pending, start] = useTransition();
  // Streaming is deliberately NOT a transition: updates inside `startTransition` are
  // deferred, which would hold every streamed token back until the whole answer landed.
  const [streaming, setStreaming] = useState(false);
  // Lets the user cut a long answer short. `streamChat` has always accepted a signal and
  // the route already honours `request.signal`; nothing was passing one.
  const abortRef = useRef<AbortController | null>(null);
  /** The new-question turn streaming now, so Stop can tell the server it was on purpose. */
  const turnRef = useRef<{ threadId: string; turnId: string } | null>(null);
  // The reveal buffer for the answer being streamed, so an unmount can stop it drawing.
  const smootherRef = useRef<StreamSmoother | null>(null);
  useEffect(() => () => smootherRef.current?.cancel(), []);
  // Whether the reader is at the bottom of the thread. Drives the jump-to-latest button; kept as
  // state (not just the ref) because it changes what is rendered.
  const [atBottom, setAtBottom] = useState(true);
  /** A thread reopened while its answer is still being written on the server. */
  const [resuming, setResuming] = useState(false);
  /** Ends that wait at once — what Stop does to a reopened thread's answer. */
  const resumeStopRef = useRef<(() => void) | null>(null);
  const busy = pending || streaming || resuming;
  // Typed while an answer was being written: sent in order as each answer lands, or handed
  // to the running answer as a steer. See `@/lib/chat-queue`.
  const [queued, setQueued] = useState<QueuedMessage[]>([]);
  // Whether the last turn ended in an answer. A stopped or failed turn holds the queue
  // rather than firing the next message into a conversation that just went wrong.
  const landedRef = useRef(false);
  // The composer's two switches, remembered per browser. Refs mirror them so the send
  // callbacks read the current value without being rebuilt on every toggle.
  const [deep, setDeep] = useState(readChatDeep);
  const [web, setWeb] = useState(readChatWeb);
  const modeRef = useRef({ deep, web });
  useEffect(() => {
    modeRef.current = { deep, web };
  }, [deep, web]);
  // Files attached to the question being written. See `@/lib/chat-attach-client`.
  const [fileChips, setFileChips] = useState<FileChip[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fileReadsRef = useRef(new Map<string, AbortController>());
  // The "searching" bubble makes sense until the first token; after that the answer
  // itself is the progress indicator.
  const awaitingFirstToken =
    busy && !messages.some((m) => m.role === "assistant" && m.streaming);
  const reduceMotion = usePrefersReducedMotion();
  const listRef = useRef<HTMLDivElement>(null);
  const threadEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const voiceSurfaceRef = useRef<HTMLDivElement>(null);
  /** The `+` menu is outside the field, so it reaches the splice through here. */
  const composerRef = useRef<MentionComposerHandle | null>(null);
  const stickToBottomRef = useRef(true);
  /** The context box's text when the current dictation session started. */
  const contextDictationBaseRef = useRef("");
  const contextTextareaRef = useRef<HTMLTextAreaElement>(null);

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
  const lastValueRef = useRef(question);
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
          "Orbit needs microphone access to dictate — allow it in your browser’s site settings",
          { id: "dictation-denied" },
        );
      } else if (effect === "toast-no-microphone") {
        toast.error("No microphone found", { id: "dictation-no-mic" });
      } else if (effect === "toast-network") {
        toast.error("Dictation needs a connection right now", {
          id: "dictation-network",
        });
      }
    },
  });
  useEffect(() => {
    cancelDictationRef.current = dictation.cancel;
  }, [dictation.cancel]);

  /**
   * Dictation for the context box — the simple case `useDictation`'s own doc comment
   * anticipates. No caret anchoring: the box is a plain, one-at-a-time `<Textarea>` in a
   * sheet with nothing else focused while it's open, so a session can just replace
   * "everything after what was there when it started" on every transcript.
   */
  const contextDictation = useDictation({
    onSessionStart: () => {
      contextDictationBaseRef.current = contextIngest.notes;
    },
    onTranscript: (span) => {
      const base = contextDictationBaseRef.current;
      contextIngest.setNotes(base && span ? `${base} ${span}` : base || span);
    },
    onEffect: (effect) => {
      if (effect === "toast-denied") {
        toast.error(
          "Orbit needs microphone access to dictate — allow it in your browser’s site settings",
          { id: "dictation-denied" },
        );
      } else if (effect === "toast-no-microphone") {
        toast.error("No microphone found", { id: "dictation-no-mic" });
      } else if (effect === "toast-network") {
        toast.error("Dictation needs a connection right now", {
          id: "dictation-network",
        });
      }
    },
  });

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
    setQueued([]);
    for (const read of fileReadsRef.current.values()) read.abort();
    fileReadsRef.current.clear();
    setFileChips([]);
  }, [resetQuestion]);

  /** Start reading files into the composer, up to the limit. Each gets a chip at once. */
  const fileCount = fileChips.length;
  const addFiles = useCallback(
    (files: readonly File[]) => {
      if (!files.length) return;
      const room = Math.max(0, CHAT_ATTACHMENTS_MAX - fileCount);
      if (files.length > room) toast.message(`You can attach up to ${CHAT_ATTACHMENTS_MAX} files to a question`);
      const fresh = files.slice(0, room).map((file) => ({
        file,
        chip: { id: crypto.randomUUID(), name: file.name || "Pasted image", status: "reading" } satisfies FileChip,
      }));
      if (!fresh.length) return;
      setFileChips((prev) => [...prev, ...fresh.map((f) => f.chip)]);
      for (const { chip, file } of fresh) {
        const controller = new AbortController();
        fileReadsRef.current.set(chip.id, controller);
        void readAttachment(file, controller.signal).then((res) => {
          fileReadsRef.current.delete(chip.id);
          if (!res.ok && res.aborted) return;
          setFileChips((prev) =>
            prev.map((c) =>
              c.id !== chip.id
                ? c
                : res.ok
                  ? { ...c, status: "ready", attachment: res.attachment }
                  : { ...c, status: "failed", error: res.error }
            )
          );
        });
      }
    },
    [fileCount]
  );

  const removeFile = useCallback((id: string) => {
    fileReadsRef.current.get(id)?.abort();
    fileReadsRef.current.delete(id);
    setFileChips((prev) => prev.filter((c) => c.id !== id));
  }, []);

  /** The open thread, readable from async work (the history list and the prefetcher check it). */
  const threadIdRef = useRef(threadId);
  useLayoutEffect(() => {
    threadIdRef.current = threadId;
  });

  const refreshThreads = useCallback(async () => {
    try {
      const page = await listChatThreads();
      setThreads((prev) => withOpenThread(page.threads, prev, threadIdRef.current));
      setOlderCursor(page.nextCursor);
    } catch {
      // History is non-blocking on first paint
    } finally {
      // Settled either way: a failed read falls back to the empty list it always showed,
      // rather than a placeholder that never resolves.
      setThreadsLoaded(true);
    }
  }, []);

  // Read on mount only when the page could not hand a list down. It used to read again even
  // when it had, because that list could come out of the router's cache of this page
  // (`staleTimes.dynamic`) and show history as it was on the last visit. The page renders a
  // `RenderStamp`, so a copy that old is refreshed on arrival, and the refreshed list is
  // adopted above — the second read of every visit was a duplicate of the page's own.
  const hadInitialThreads = useRef(initialThreads !== null);
  useEffect(() => {
    if (hadInitialThreads.current) return;
    void refreshThreads();
  }, [refreshThreads]);

  /** The next page of history, appended below what is on screen. */
  const loadOlderThreads = useCallback(async () => {
    if (!olderCursor || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const page = await listChatThreads(olderCursor);
      setThreads((prev) => {
        const have = new Set(prev.map((t) => t.id));
        return [...prev, ...page.threads.filter((t) => !have.has(t.id))];
      });
      setOlderCursor(page.nextCursor);
    } catch (err) {
      toast.error(friendlyError(err, "Couldn’t load older chats — try again?"));
    } finally {
      setLoadingOlder(false);
    }
  }, [olderCursor, loadingOlder]);

  // The other half of `initialQuestionFromUrl` and `initialAttachFromUrl`: take `q`, `contact`
  // and `name` back out of the address bar, so a
  // reload or a shared link does not re-seed a question that was already dealt with.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!["q", "contact", "name"].some((key) => params.has(key))) return;
    for (const key of ["q", "contact", "name"]) params.delete(key);
    const rest = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${rest ? `?${rest}` : ""}`);
    textareaRef.current?.focus();
  }, []);

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
    // The empty state reads top-down, like a page. Pinning it to the bottom on mount —
    // on a phone, where the no-key notice leaves the pane ~150px tall — scrolled its
    // heading out of view and cut its first line in half under the chat header.
    if (messages.length === 0 && !busy) return;
    if (!stickToBottomRef.current && !isNearBottom()) return;
    // Defer so DOM has laid out new messages. While an answer streams this runs on every frame,
    // and a *smooth* scroll re-issued every frame keeps interrupting the last one — the view
    // judders instead of tracking. Instant while streaming, smooth only when a whole message lands.
    requestAnimationFrame(() => scrollToBottom(!streaming));
  }, [messages, busy, streaming, isNearBottom, scrollToBottom]);

  function onListScroll() {
    const near = isNearBottom();
    stickToBottomRef.current = near;
    // Scroll fires at high frequency; only re-render when the answer actually changes.
    setAtBottom((prev) => (prev === near ? prev : near));
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

  /**
   * History rows read ahead of the click — see `@/lib/chat-thread-prefetch` for the rules
   * that keep a prefetched thread from ever being the wrong one or a stale one.
   */
  const [threadPrefetch] = useState(() => createThreadPrefetcher(getChatThread));
  useEffect(() => () => threadPrefetch.dispose(), [threadPrefetch]);
  // The thread being left may have gained messages, versions or a title while it was open,
  // and the one arrived at is now the live copy — neither should be served from a prefetch.
  const prevThreadIdRef = useRef<string | null>(null);
  useEffect(() => {
    threadPrefetch.forget(prevThreadIdRef.current);
    threadPrefetch.forget(threadId);
    prevThreadIdRef.current = threadId;
  }, [threadId, threadPrefetch]);
  const prefetchHandlers = useMemo(
    () => ({
      // Never the open thread: it is the one thing on screen that can change under an entry.
      hover: (id: string) => {
        if (id !== threadIdRef.current) threadPrefetch.hover(id);
      },
      leave: () => threadPrefetch.leave(),
      now: (id: string) => {
        if (id !== threadIdRef.current) threadPrefetch.prefetch(id);
      },
    }),
    [threadPrefetch]
  );

  /**
   * Which `loadThread` call is the latest. A load that a newer one has overtaken applies
   * nothing: with a prefetched thread arriving instantly beside an ordinary one still in
   * flight, the order results land in no longer follows the order of the clicks.
   */
  const loadSeqRef = useRef(0);

  /**
   * Put a loaded thread on screen and return the message list it set. `opening` is the first
   * paint of a thread (composer cleared, edit closed, pinned to the bottom); a revalidation
   * swaps the rows in place and leaves all of that as the person has it.
   */
  const applyThread = useCallback((loaded: LoadedThread, { opening }: { opening: boolean }) => {
    const { thread, messages: rows, sent, versions: loadedVersions, versionSlot: loadedSlot } = loaded;
    setThreadId(thread.id);
    setThreadTitle(thread.title);
    setContextNotes(thread.contextNote ?? "");
    setVersions(loadedVersions);
    setVersionSlot(loadedSlot);
    if (opening) {
      setEditingUserId(null);
      stickToBottomRef.current = true;
    }
    const next: ThreadMessage[] = rows.map((row) =>
      row.role === "user"
        ? {
            id: row.id,
            role: "user" as const,
            content: row.content,
            mentionNames: row.attachedContacts?.length
              ? row.attachedContacts.map((c) => c.name)
              : undefined,
            fileNames: row.attachments?.length ? row.attachments.map((a) => a.name) : undefined,
          }
        : {
            id: row.id,
            role: "assistant" as const,
            answer: row.content,
            recommendations: row.recommendations || [],
            // Answers written before this column existed have none, and simply show no
            // summary rather than a fabricated one.
            steps: row.activity ?? undefined,
            evidence: row.evidence ?? undefined,
            proposedActions: row.proposedActions ?? undefined,
            // Stored since v196; older answers have none and show no chips.
            followUps: row.followUps?.length ? row.followUps : undefined,
            feedback: row.feedback ?? null,
            // It came out of the database, so by definition there is a row to rate.
            persisted: true,
            sentTo: sent[row.id],
          }
    );
    messagesRef.current = next;
    setMessages(next);
    const lastUser = [...rows].reverse().find((row) => row.role === "user");
    setLastUserQuery(lastUser?.content ?? "");
    if (opening) {
      clearComposer();
      requestAnimationFrame(() => scrollToBottom(false));
    }
    return next;
  }, [clearComposer, scrollToBottom, setContextNotes]);

  /**
   * Open a saved thread. `prefetched: true` — only from a history click — lets it use a read
   * that started on hover; every other caller (a reload after a version switch or a stream,
   * the `?thread=` return) always reads fresh.
   */
  const loadThread = useCallback(async (id: string, opts?: { prefetched?: boolean }) => {
    const seq = ++loadSeqRef.current;
    const taken = opts?.prefetched ? threadPrefetch.take(id) : null;
    const ready = taken && "value" in taken && taken.value.thread.id === id ? taken.value : null;
    // A prefetch older than THREAD_PREFETCH_FRESH_MS shows at once, then is re-read below.
    const revalidate = ready && taken && "fresh" in taken && !taken.fresh;
    // An already-landed prefetch swaps straight in: no spinner frame in between.
    if (!ready) setLoadingThread(true);
    try {
      let loaded: LoadedThread;
      if (ready) {
        loaded = ready;
      } else if (taken && "promise" in taken && taken.promise) {
        // Still in flight: wait for it, but a failure — or a result for any other thread —
        // falls back to the ordinary read.
        const early = await taken.promise.catch(() => null);
        loaded = early && early.thread.id === id ? early : await getChatThread(id);
      } else {
        loaded = await getChatThread(id);
      }
      if (seq !== loadSeqRef.current) return;
      const shown = applyThread(loaded, { opening: true });
      // Left mid-answer and back: the server kept writing it, so wait for it to land. Stop
      // works on it as on any answer: it marks the turn, and aborts this tab's send if the
      // send is still open (a client-side navigation keeps it).
      const live = pendingTurn(id, loaded.messages);
      if (live) {
        const turn = { threadId: id, turnId: live.turnId };
        turnRef.current = turn;
        abortRef.current = live.controller ?? null;
        let stopped = false;
        const stop = () => {
          stopped = true;
          setResuming(false);
          // Same as a Stop before any of the answer arrived: say it was stopped, not saved.
          setMessages((prev) => [
            ...prev,
            { id: newId(), role: "assistant", answer: "", recommendations: [], stopped: true },
          ]);
        };
        resumeStopRef.current = stop;
        setResuming(true);
        void awaitPendingAnswer(id, () => !stopped && seq === loadSeqRef.current && threadIdRef.current === id)
          .then((landed) => {
            if (landed) landedRef.current = true;
            if (landed) notifyAnswerLanded({ threadId: id, messageId: null, title: landed.thread.title });
            if (landed) applyThread(landed, { opening: false });
          })
          .finally(() => {
            if (resumeStopRef.current === stop) resumeStopRef.current = null;
            if (turnRef.current === turn) turnRef.current = null;
            if (abortRef.current === live.controller) abortRef.current = null;
            if (seq === loadSeqRef.current) setResuming(false);
          });
        return;
      }
      if (revalidate) {
        const pending = ("promise" in taken && taken.promise) || getChatThread(id);
        void pending.then(
          (current) => {
            // Only onto the same untouched thread: another load, a send or an edit since the
            // stale copy went up wins over this read, and an unchanged thread is left as is.
            if (seq !== loadSeqRef.current || current.thread.id !== id) return;
            if (messagesRef.current !== shown) return;
            if (JSON.stringify(current) === JSON.stringify(loaded)) return;
            applyThread(current, { opening: false });
          },
          () => {}
        );
      }
    } catch (err) {
      if (seq === loadSeqRef.current) {
        toast.error(friendlyError(err, "Couldn’t load that chat — try again?"));
      }
    } finally {
      // An overtaken load leaves the spinner to the one that overtook it.
      if (seq === loadSeqRef.current) setLoadingThread(false);
    }
  }, [applyThread, threadPrefetch]);

  const saveContext = useCallback(async () => {
    setContextSaving(true);
    try {
      const id = await ensureThread();
      await updateChatThreadContext(id, contextIngest.notes);
      setContextOpen(false);
      toast.success(contextIngest.notes.trim() ? "Context saved" : "Context cleared");
    } catch (err) {
      toast.error(friendlyError(err, "Couldn’t save that context — try again?"));
    } finally {
      setContextSaving(false);
    }
  }, [ensureThread, contextIngest.notes]);

  // Coming back from the Gmail connect redirect lands on `/chat?thread=<id>&gmail=connected`:
  // reopen that conversation (the draft's own edits are restored by its card) and say what
  // happened. The params come out only once the thread has loaded — a server action that is
  // still in flight when the URL is rewritten can be dropped, so nothing here does both at once.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const thread = params.get("thread");
    const gmail = params.get("gmail");
    if (!thread && !gmail) {
      // Back on the page while this tab's last question is still being answered: open it.
      const live = inFlightThreadId();
      if (live) queueMicrotask(() => void loadThread(live));
      return;
    }
    if (gmail === "connected") {
      toast.success("Gmail connected — you can send now");
    } else if (gmail === "error") {
      const oauth = describeOAuthReason(params.get("reason"), "Gmail", params.get("purpose"), planConfig);
      if (oauth.cancelled) toast.message(oauth.message);
      else toast.error(oauth.message);
    }
    const strip = () => {
      const next = new URLSearchParams(window.location.search);
      for (const key of ["thread", "gmail", "google", "purpose", "reason"]) next.delete(key);
      const rest = next.toString();
      window.history.replaceState(null, "", `${window.location.pathname}${rest ? `?${rest}` : ""}`);
    };
    // A thread id from the address bar is only ever passed to `getChatThread`, which scopes it
    // to the signed-in user; anything that is not an id is dropped without a request.
    const isId = thread ? /^[0-9a-f-]{36}$/i.test(thread) : false;
    // A microtask, so the load's first state update is not made inside the effect body itself.
    if (isId) queueMicrotask(() => void loadThread(thread!).finally(strip));
    else strip();
    // Once, on arrival. `loadThread` is stable enough for that: it closes over refs and setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startNewChat = useCallback(() => {
    start(async () => {
      try {
        const created = await createChatThread();
        setThreadId(created.id);
        setThreadTitle(created.title);
        setMessages([]);
        clearComposer();
        setLastUserQuery("");
        resetContext();
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
        toast.error(friendlyError(err, "Couldn’t start a chat — try again?"));
      }
    });
  }, [clearComposer, resetContext]);

  const removeThread = useCallback(
    (id: string) => {
      // Deletes are locked while an answer streams; if one of the open thread gets through anyway,
      // end the answer FIRST. Left running it fails on the deleted thread (reported, question put
      // back) or lands and re-adds the row.
      if (threadId === id) abortRef.current?.abort();
      start(async () => {
        try {
          await deleteChatThread(id);
          threadPrefetch.forget(id);
          setThreads((prev) => prev.filter((t) => t.id !== id));
          if (threadId === id) {
            setThreadId(null);
            setThreadTitle(null);
            setMessages([]);
            clearComposer();
            resetContext();
          }
          toast.success("Chat deleted");
        } catch (err) {
          toast.error(friendlyError(err, TOAST_COPY.deleteFailed));
        }
      });
    },
    [clearComposer, threadId, resetContext, threadPrefetch]
  );

  const sendQuestion = useCallback(
    (raw: string, opts?: { contextContactIds?: readonly string[]; attachments?: ChatAttachment[] }) => {
      const q = raw.trim();
      if (!q || busy || loadingThread) return;
      // A queued message brings its own files; a typed one takes what is in the composer.
      // Still reading: wait, rather than send the question without the file it is about.
      const fromComposer = !opts?.attachments;
      if (fromComposer && fileChips.some((c) => c.status === "reading")) {
        toast.message("Still reading your file — one moment");
        return;
      }
      const sentChips = fromComposer ? fileChips : [];
      const attachments =
        opts?.attachments ?? fileChips.flatMap((c) => (c.status === "ready" && c.attachment ? [c.attachment] : []));
      if (fromComposer) setFileChips([]);

      landedRef.current = false;
      setLastUserQuery(q);
      // A fresh turn starts a fresh slot; the switcher belongs to whichever turn is last.
      setVersions([]);
      setVersionSlot(null);
      setEditingUserId(null);
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
        fileNames: attachments.length ? attachments.map((a) => a.name) : undefined,
      };
      // A send that fails puts the question back; its files go back with it.
      const restoreFiles = () => setFileChips((prev) => (prev.length ? prev : sentChips));
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
          // Creating a thread only inserts a row — it never needs an AI key, so the key
          // message was the wrong fallback here.
          toast.error(friendlyError(err, TOAST_COPY.chatStartFailed));
          setMessages((prev) => prev.filter((m) => m.id !== userMsg.id));
          // Not over a follow-up typed in the meantime.
          if (!lastValueRef.current.trim()) {
            resetQuestion(q);
            restoreFiles();
          }
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

        // The answer is revealed a frame at a time rather than a network chunk at a time. Every
        // path that ends the answer (recommendations, done, stop) flushes it first, so what is on
        // screen is complete whenever the stream is.
        const smoother = createStreamSmoother(
          (chunk) => {
            ensurePlaceholder();
            patch((m) => ({ ...m, answer: m.answer + chunk }));
          },
          { reduced: prefersReducedMotionNow() }
        );
        smootherRef.current = smoother;

        const controller = new AbortController();
        abortRef.current = controller;
        const turnId = crypto.randomUUID();
        const { deep: asDeep, web: withWeb } = modeRef.current;
        markTurnInFlight(activeId, {
          startedAt: Date.now(),
          turnId,
          controller,
          windowMs: asDeep ? DEEP_RESUME_WINDOW_MS : undefined,
        });
        turnRef.current = { threadId: activeId, turnId };
        await streamChat(
          {
            question: q,
            threadId: activeId,
            contextContactIds,
            turnId,
            attachments: attachments.length ? attachments : undefined,
            mode: asDeep ? "deep" : undefined,
            web: withWeb ? undefined : false,
          },
          {
            onAnswer: (delta) => smoother.push(delta),
            onRecommendations: (items) => {
              // Recommendations follow the last word of the prose; show that word first.
              smoother.flush();
              ensurePlaceholder();
              patch((m) => ({ ...m, recommendations: items }));
            },
            onEvidence: (items) => {
              ensurePlaceholder();
              patch((m) => ({ ...m, evidence: items }));
            },
            onActions: (items) => {
              ensurePlaceholder();
              patch((m) => ({ ...m, proposedActions: items }));
            },
            onBlocks: (blocks) => {
              ensurePlaceholder();
              patch((m) => ({ ...m, blocks }));
            },
            onStep: (step) => {
              // The first step arrives before any prose, which is the point: it replaces the
              // old blank wait. Steps are keyed by id, so a stage finishing updates its own
              // line in place instead of appending a second copy of itself.
              ensurePlaceholder();
              // The turn took a steer: it is in the trail now, so it leaves the queue.
              const steered = steeredId(step.id);
              if (steered) setQueued((prev) => prev.filter((item) => item.id !== steered));
              patch((m) => {
                const steps = m.steps ?? [];
                const at = steps.findIndex((s) => s.id === step.id);
                if (at === -1) return { ...m, steps: [...steps, step] };
                const next = steps.slice();
                next[at] = step;
                return { ...m, steps: next };
              });
            },
            onDone: (info) => {
              landedRef.current = true;
              smoother.flush();
              ensurePlaceholder();
              emitTourEvent("chat.answered");
              patch((m) => ({
                ...m,
                id: info.messageId || assistantId,
                streaming: false,
                followUps: info.followUps ?? [],
                retrieved: info.retrieved,
                // Only a real message id means there is a row to rate.
                persisted: Boolean(info.messageId),
              }));
              if (info.notice) toast.message(info.notice);
              notifyAnswerLanded({ threadId: activeId, messageId: info.messageId, title: info.title });
              // The header names the thread ON SCREEN; the list update is about the answered
              // thread wherever the person is (see @/lib/chat-answer-landed).
              const headerTitle = headerTitleAfterAnswer(activeId, threadIdRef.current, info.title);
              if (headerTitle) setThreadTitle(headerTitle);
              const landedAt = new Date();
              setThreads((prev) => threadsAfterAnswer(prev, activeId, info.title, landedAt));
            },
            onError: (message) => {
              // A stop is the user's own doing, not a failure: keep whatever arrived and
              // say plainly that it was cut short rather than deleting it and apologising.
              if (controller.signal.aborted) return;
              if (placed) {
                // Work already reached the screen — the trail, maybe half an answer. Keep it,
                // say what went wrong beneath it, and put the question back to try again,
                // rather than wiping everything the person just watched happen.
                smoother.flush();
                patch((m) => ({ ...m, streaming: false, failed: message }));
              } else {
                // Nothing arrived; there is nothing to keep or reveal into.
                smoother.cancel();
                toast.error(message);
                setMessages((prev) => prev.filter((m) => m.id !== userMsg.id && m.id !== assistantId));
              }
              // Not over a follow-up typed in the meantime.
              if (!lastValueRef.current.trim()) {
                resetQuestion(q);
                restoreFiles();
              }
            },
          },
          controller.signal
        );
        // However the stream ended, show everything that arrived. A no-op after done or an error.
        smoother.flush();
        smootherRef.current = null;
        if (controller.signal.aborted) {
          // Stopping during retrieval means no answer bubble was ever placed, which used to
          // leave the question sitting alone with nothing to say what happened. The user
          // message may already be saved server-side by then; `stopStreaming` tells the server
          // this was a Stop, which drops the unanswered question, so mark the turn stopped and
          // say it was not saved.
          if (!placed) ensurePlaceholder();
          patch((m) => ({ ...m, streaming: false, stopped: true }));
        }
        clearTurnInFlight(activeId, turnId);
        if (turnRef.current?.turnId === turnId) turnRef.current = null;
        abortRef.current = null;
        // A steer the turn never confirmed waits its turn like any other queued message.
        setQueued(afterTurn);
        setStreaming(false);
      })();
    },
    [attached, busy, loadingThread, ensureThread, resetQuestion, scrollToBottom, fileChips]
  );

  // The next queued message goes out once the answer before it has landed. An effect rather
  // than a call from the turn's own tail: `sendQuestion` there still closes over `busy`.
  useEffect(() => {
    if (busy || loadingThread || !landedRef.current) return;
    const next = queued[0];
    if (!next) return;
    setQueued((prev) => prev.filter((item) => item.id !== next.id));
    sendQuestion(next.text, { contextContactIds: next.contextContactIds, attachments: next.attachments ?? [] });
  }, [busy, loadingThread, queued, sendQuestion]);

  /**
   * Hand a queued message to the answer being written. Only a live stream can be steered:
   * its confirmation arrives as a step on that stream. If the server refuses it (too long,
   * the turn's steers used up) it simply stays queued.
   */
  const steerQueued = useCallback(
    (item: QueuedMessage) => {
      const turn = turnRef.current;
      // A steer is words only; a message with files waits its turn and goes out whole.
      if (!streaming || !turn || item.attachments?.length) return;
      const back = () => setQueued((prev) => setSteering(prev, item.id, false));
      setQueued((prev) => setSteering(prev, item.id, true));
      void steerChatTurn(turn.threadId, turn.turnId, item.id, item.text)
        .then((res) => {
          if (!res.ok) back();
        })
        .catch(back);
    },
    [streaming]
  );

  /** Enter while an answer is being written: queue it, and with `steer`, send it in now. */
  const queueQuestion = useCallback(
    (raw: string, steer: boolean) => {
      const text = raw.trim();
      if (fileChips.some((c) => c.status === "reading")) {
        toast.message("Still reading your file — one moment");
        return;
      }
      const files = fileChips.flatMap((c) => (c.status === "ready" && c.attachment ? [c.attachment] : []));
      const item: QueuedMessage = {
        id: crypto.randomUUID(),
        text,
        contextContactIds: activeMentions(text, attached).map((p) => p.id),
        attachments: files.length ? files : undefined,
      };
      const next = enqueue(queued, item);
      // Full, or nothing typed: the text stays in the box.
      if (next === queued) return;
      setQueued(next);
      resetQuestion("");
      setFileChips([]);
      if (steer) steerQueued(item);
    },
    [attached, queued, resetQuestion, steerQueued, fileChips]
  );

  /**
   * Another version of the LAST turn: a plain regenerate (no `newQuestion`) re-asks the same
   * question; an edit sends different text. Either way the current last user+assistant bubbles
   * are replaced in place — not appended, the way a fresh question is — and the version list
   * is re-read from the server once the answer lands, which is also what a stopped or failed
   * regenerate needs: nothing here assumes success, so on any failure the thread simply keeps
   * showing what it already had.
   */
  const sendVersioned = useCallback(
    (assistantMessageId: string, newQuestion?: string) => {
      if (!threadId || busy || loadingThread) return;
      const target = messages.find(
        (m): m is AssistantMessage => m.role === "assistant" && m.id === assistantMessageId
      );
      const targetIndex = messages.findIndex((m) => m.id === assistantMessageId);
      const priorUser = targetIndex > 0 ? messages[targetIndex - 1] : undefined;
      if (!target || !priorUser || priorUser.role !== "user") return;

      const displayQuestion = newQuestion?.trim() || priorUser.content;
      setEditingUserId(null);
      setLastUserQuery(displayQuestion);

      const userMsg: UserMessage = {
        id: newId(),
        role: "user",
        content: displayQuestion,
        mentionNames: newQuestion ? undefined : priorUser.mentionNames,
      };
      const assistantId = newId();
      stickToBottomRef.current = true;
      // Replace, not append: this turn is being redone, not repeated.
      setMessages((prev) => [...prev.slice(0, targetIndex - 1), userMsg]);
      requestAnimationFrame(() => scrollToBottom(true));

      setStreaming(true);
      void (async () => {
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

        const smoother = createStreamSmoother(
          (chunk) => {
            ensurePlaceholder();
            patch((m) => ({ ...m, answer: m.answer + chunk }));
          },
          { reduced: prefersReducedMotionNow() }
        );
        smootherRef.current = smoother;

        const controller = new AbortController();
        abortRef.current = controller;
        let landed = false;
        await streamChat(
          {
            question: displayQuestion,
            threadId,
            versionOf: { assistantMessageId, question: newQuestion },
            mode: modeRef.current.deep ? "deep" : undefined,
            web: modeRef.current.web ? undefined : false,
          },
          {
            onAnswer: (delta) => smoother.push(delta),
            onRecommendations: (items) => {
              smoother.flush();
              ensurePlaceholder();
              patch((m) => ({ ...m, recommendations: items }));
            },
            onStep: (step) => {
              ensurePlaceholder();
              patch((m) => {
                const steps = m.steps ?? [];
                const at = steps.findIndex((s) => s.id === step.id);
                if (at === -1) return { ...m, steps: [...steps, step] };
                const next = steps.slice();
                next[at] = step;
                return { ...m, steps: next };
              });
            },
            onDone: () => {
              landed = true;
            },
            onError: (message) => {
              if (controller.signal.aborted) return;
              smoother.cancel();
              toast.error(message);
            },
          },
          controller.signal
        );
        smoother.flush();
        smootherRef.current = null;
        abortRef.current = null;
        setStreaming(false);
        // Authoritative either way: on success this shows the new version active and its
        // place in the switcher; on a stop or failure it shows the version that was never
        // replaced, because the server never flipped anything — reloading just proves it.
        if (landed || controller.signal.aborted) {
          await loadThread(threadId);
        }
      })();
    },
    [threadId, busy, loadingThread, messages, scrollToBottom, loadThread]
  );

  /**
   * Cut the answer short.
   *
   * The partial text stays on screen, but the server never reaches `persistAssistantTurn`,
   * so nothing is saved — the bubble says so rather than letting a reload silently lose it.
   * The abort alone looks like a dropped connection to the server, which keeps the question
   * (audit L-25), so a Stop also says it was on purpose. A regenerate has no turn here: the
   * server discards an abandoned version on any abort.
   */
  const stopStreaming = useCallback(() => {
    const turn = turnRef.current;
    turnRef.current = null;
    abortRef.current?.abort();
    resumeStopRef.current?.();
    if (turn) void stopChatTurn(turn.threadId, turn.turnId).catch(() => {});
  }, []);

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
   * Every edit the composer makes, typed or spliced.
   *
   * One funnel because dictation has to see all of them: an edit before the dictated span
   * slides the anchor along, an edit after it changes nothing, and an edit through it ends
   * the session, because carrying on would overwrite what the user just wrote. The `@` menu
   * and the `+` menu splice through here for the same reason — a splice is a user edit as
   * far as an in-flight dictation is concerned.
   */
  const onComposerValueChange = useCallback((next: string) => {
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
    setQuestion(next);
  }, []);

  /**
   * Register a person and hand back the token that stands for them.
   *
   * The `+` menu's copy of what `MentionComposer` does for an accepted `@` row. Both go
   * through `addMentionPick`, so the two cannot mint different tokens for the same contact
   * — which would leave one of them grey and unattached.
   */
  const tokenForPerson = useCallback(
    (contactId: string, nameCandidates: string[]) => {
      const { picks, token } = addMentionPick(attached, contactId, nameCandidates);
      setAttached(picks);
      return token;
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
      const insert = composerRef.current?.insertAtCaret;
      if (!insert) return;
      if (item.kind === "text") {
        insert(item.text);
        return;
      }
      if (item.kind === "event") {
        const token = tokenForPerson(item.contactId, item.nameCandidates);
        insert(`${item.before}${token}${item.after}`);
        return;
      }
      insert(tokenForPerson(item.contactId, item.nameCandidates));
    },
    [tokenForPerson],
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

  /**
   * The keys `MentionComposer` did not claim.
   *
   * It takes the type-ahead's own keys and the atomic `@Name` delete first, and only what
   * is left reaches here — so Enter still sends, but not while a row is highlighted.
   */
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
      // Mid-answer, Enter queues and Cmd/Ctrl+Enter steers the answer being written.
      if (busy) queueQuestion(question, e.metaKey || e.ctrlKey);
      else sendQuestion(question);
    }
  }

  /**
   * Attach, Deep research and Web search. Built once and placed twice: inside the pill from
   * `sm` up, and in a row above it on a phone, where six controls in the pill left the text
   * field about eighty pixels wide. Tailwind picks which is shown, so it is right on the first
   * paint; the hidden copy is `display: none` and out of the accessibility tree.
   */
  const composerExtras = {
    attach: (
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="size-9 shrink-0 rounded-full text-muted-foreground"
        aria-label="Attach a file"
        title="Attach a photo, PDF or text file. Reading a photo or PDF uses AI credits."
        disabled={loadingThread || fileChips.length >= CHAT_ATTACHMENTS_MAX}
        onClick={() => fileInputRef.current?.click()}
      >
        <Paperclip className="size-4" />
      </Button>
    ),
    deep: (
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-pressed={deep}
        aria-label="Deep research"
        title={
          deep
            ? "Deep research is on: a thorough answer that can take a few minutes and uses more AI credits"
            : "Deep research: a thorough answer that can take a few minutes and uses more AI credits"
        }
        disabled={loadingThread}
        onClick={() => {
          setDeep(!deep);
          writeChatDeep(!deep);
        }}
        className={cn(
          "size-9 shrink-0 rounded-full",
          deep ? "bg-primary/15 text-primary ring-1 ring-inset ring-primary/30 hover:bg-primary/20 hover:text-primary" : "text-muted-foreground"
        )}
      >
        <Telescope className="size-4" />
      </Button>
    ),
    web: (
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-pressed={web}
        aria-label="Web search"
        title={web ? "Web search is on: answers may look things up on the public web" : "Web search is off: answers use only your own records"}
        disabled={loadingThread}
        onClick={() => {
          setWeb(!web);
          writeChatWeb(!web);
        }}
        className={cn(
          "size-9 shrink-0 rounded-full",
          web ? "bg-primary/15 text-primary ring-1 ring-inset ring-primary/30 hover:bg-primary/20 hover:text-primary" : "text-muted-foreground"
        )}
      >
        <Globe className="size-4" />
      </Button>
    ),
  };

  const headerTitle = threadTitle?.trim() || "New chat";

  /** Rename a saved chat. The list changes once the server has it, so a refusal leaves no lie. */
  const renameThread = useCallback((id: string, title: string) => {
    void renameChatThread(id, title)
      .then((res) => {
        if (!res.ok) throw new Error("rename refused");
        setThreads((prev) => prev.map((t) => (t.id === id ? { ...t, title: res.title } : t)));
        if (threadIdRef.current === id) setThreadTitle(res.title);
      })
      .catch(() => toast.error("Couldn’t rename that chat — try again?"));
  }, []);

  const pinThread = useCallback((id: string, pinned: boolean) => {
    void pinChatThread(id, pinned)
      .then((res) => {
        if (res.ok) setThreads((prev) => prev.map((t) => (t.id === id ? { ...t, pinnedAt: res.pinnedAt } : t)));
        else if (res.reason === "limit") toast.message("You can pin up to 20 chats — unpin one first");
        else throw new Error("pin refused");
      })
      .catch(() => toast.error("Couldn’t pin that chat — try again?"));
  }, []);

  /** The conversation on screen as Markdown. Built on demand: it is only needed on a click. */
  const exportMarkdown = () =>
    chatAsMarkdown(
      headerTitle,
      messages.map((m) =>
        m.role === "user"
          ? { role: "user" as const, text: m.content }
          : {
              role: "assistant" as const,
              text: directivesAsText(
                m.answer,
                (id) => m.recommendations.find((r) => r.contact_id === id)?.name ?? m.blocks?.people[id]?.name,
                m.blocks?.lists
              ),
            }
      )
    );

  // Bubble handlers that never change identity, so the `memo` on UserBubble/AssistantBubble
  // holds while streaming (a setMessages per frame) and composer keystrokes re-render the
  // panel. Each takes the message id and reads the latest committed render's state and
  // functions through a ref — the same values the old per-render closures captured.
  const bubbleLive = useRef({ messages, threadId, versionSlot, lastUserQuery, sendQuestion, sendVersioned, loadThread });
  useLayoutEffect(() => {
    bubbleLive.current = { messages, threadId, versionSlot, lastUserQuery, sendQuestion, sendVersioned, loadThread };
  });
  const bubbleHandlers = useMemo(
    () => ({
      startEdit: (id: string) => setEditingUserId(id),
      cancelEdit: () => setEditingUserId(null),
      submitEdit: (userMessageId: string, text: string) => {
        const { messages: current, sendVersioned: send } = bubbleLive.current;
        const i = current.findIndex((m) => m.id === userMessageId);
        if (i < 0) return;
        const nextAssistant = current[i + 1];
        if (nextAssistant?.role === "assistant") send(nextAssistant.id, text);
      },
      regenerate: (assistantMessageId: string) => bubbleLive.current.sendVersioned(assistantMessageId),
      askAgain: () => bubbleLive.current.sendQuestion(bubbleLive.current.lastUserQuery),
      followUp: (q: string) => bubbleLive.current.sendQuestion(q),
      actionSettled: (messageId: string, actionId: string, next: StoredProposedAction) =>
        setMessages((prev) =>
          prev.map((m) =>
            m.id === messageId && m.role === "assistant"
              ? { ...m, proposedActions: (m.proposedActions ?? []).map((a) => (a.id === actionId ? next : a)) }
              : m
          )
        ),
      switchVersion: async (version: number) => {
        const { threadId: tid, versionSlot: slot, loadThread: load } = bubbleLive.current;
        if (!tid || !slot) return;
        try {
          await switchChatVersion(tid, slot, version);
          await load(tid);
        } catch (err) {
          toast.error(friendlyError(err, "Couldn’t switch versions — try again?"));
        }
      },
    }),
    []
  );
  const selectThread = useCallback(
    (id: string) => void loadThread(id, { prefetched: true }),
    [loadThread]
  );

  return (
    <ChatThreadProvider value={threadId}>
      {/*
        Always bounded; the internal message list is the only scroller (flex 1 1 0 +
        overflow-y-auto). On phones the chat page bounds itself and this card fills
        what is left (so the no-key notice comes out of the card, not out from under
        the nav). From md up it keeps an explicit viewport height: page title +
        vertical padding.
      */}
      {/* Sized by the flex column it sits in, NOT a viewport calc. The old
          `h-[calc(100dvh-16.5rem)]` hardcoded an assumption about how much chrome was above
          it, so the API-key notice pushed the card past the bottom of the screen and clipped
          the suggestion chips. The whole ancestor chain is bounded (app-shell `h-dvh` →
          `min-h-0 flex-1` → page `flex min-h-0 flex-1`), and ChatPanelSkeleton already sized
          itself this way — so this also removes the height jump when the panel swaps in. */}
      <div ref={voiceSurfaceRef} className="flex min-h-0 w-full flex-1 flex-row overflow-hidden rounded-2xl border border-border/70 bg-card">
        {/* From md up the history is a rail beside the conversation. Below that the header
            keeps its dropdown (`md:hidden` on both of its controls), because on a phone the
            conversation should have the full width. */}
        <ChatHistoryRail
          id="chat-history-rail"
          open={railOpen}
          onToggle={toggleRail}
          threads={threads}
          loading={!threadsLoaded}
          hasMore={olderCursor !== null}
          loadingMore={loadingOlder}
          onLoadMore={loadOlderThreads}
          activeId={threadId}
          busy={busy}
          onSelect={selectThread}
          onIntent={prefetchHandlers.hover}
          onIntentEnd={prefetchHandlers.leave}
          onIntentNow={prefetchHandlers.now}
          onNew={startNewChat}
          onDelete={removeThread}
          onRename={renameThread}
          onPin={pinThread}
          onSearch={searchChatThreads}
        />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2.5 sm:px-4">
          <DropdownMenu open={historyOpen} onOpenChange={setHistoryOpen}>
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="shrink-0 text-muted-foreground md:hidden"
                  aria-label="Chat history"
                />
              }
            >
              <History className="size-4" />
              <span className="max-sm:sr-only">History</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-72">
              <DropdownMenuLabel>Recent chats</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {!threadsLoaded && threads.length === 0 ? (
                // Not read yet — a placeholder list, never "no saved chats" for someone who has some.
                <div aria-busy="true" aria-label="Loading recent chats">
                  {["w-3/4", "w-1/2", "w-2/3"].map((width) => (
                    <div key={width} className="flex h-9 items-center px-2">
                      <Skeleton className={cn("h-3.5", width)} />
                    </div>
                  ))}
                </div>
              ) : threads.length === 0 ? (
                <div className="px-2 py-3 text-xs text-muted-foreground">
                  No saved chats yet.
                </div>
              ) : (
                threads.map((thread) => (
                  <DropdownMenuItem
                    key={thread.id}
                    className="group items-start gap-2 py-2"
                    disabled={busy}
                    onPointerEnter={() => prefetchHandlers.hover(thread.id)}
                    onPointerLeave={prefetchHandlers.leave}
                    onFocus={() => prefetchHandlers.now(thread.id)}
                    onClick={() => {
                      void loadThread(thread.id, { prefetched: true });
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
                      className="relative mt-0.5 grid size-6 shrink-0 place-items-center rounded tap-target text-muted-foreground pointer-fine:opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100 group-focus-within:opacity-100 disabled:invisible"
                      aria-label="Delete chat"
                      disabled={busy}
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
              {olderCursor !== null && threads.length > 0 && (
                <DropdownMenuItem
                  // Stays open: the older chats land in this same list.
                  closeOnClick={false}
                  disabled={loadingOlder}
                  className="justify-center py-2 text-xs text-muted-foreground"
                  onClick={() => void loadOlderThreads()}
                >
                  {loadingOlder ? "Loading…" : "Show older chats"}
                </DropdownMenuItem>
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
            className="shrink-0 text-muted-foreground md:hidden"
            onClick={startNewChat}
            disabled={busy}
          >
            <Plus className="size-4" />
            <span className="max-sm:sr-only">New chat</span>
          </Button>

          {messages.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="shrink-0 text-muted-foreground"
                    aria-label="Export chat"
                  />
                }
              >
                <Download className="size-4" />
                <span className="max-sm:sr-only">Export</span>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(exportMarkdown())
                      .then(() => toast.success(TOAST_COPY.copied))
                      .catch(() => toast.error(TOAST_COPY.copyFailed));
                  }}
                >
                  Copy chat
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => downloadMarkdown(chatExportFileName(headerTitle), exportMarkdown())}>
                  Download as Markdown
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() => setContextOpen(true)}
          >
            <NotebookPen className="size-4" />
            <span className="max-sm:sr-only">Context</span>
          </Button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {/* `relative` so the jump button can sit on the scroller's bottom edge — above the
              composer, but not inside the scrolling content, where it would scroll away. */}
          <div className="relative flex min-h-0 flex-1 flex-col">
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
                    <div className="flex flex-1 flex-col items-center justify-center gap-3 py-8 text-center sm:py-16">
                      <p className="font-[family-name:var(--font-display)] text-xl text-ink sm:text-2xl">
                        Ask your <span className="gold-shimmer-text [animation-iteration-count:2]!">network</span>
                      </p>
                      <p className="max-w-md text-sm text-muted-foreground">
                        Who can help, who to follow up with, or who knows what —
                        try a suggestion below.
                      </p>
                    </div>
                  )}

                  {messages.map((msg, i) => {
                    // Only the pair that ends the thread can be edited or regenerated —
                    // versions exist for the last turn only.
                    const isLastAssistant =
                      msg.role === "assistant" && i === messages.length - 1 && msg.persisted;
                    const isLastUser =
                      msg.role === "user" &&
                      i === messages.length - 1 - (messages[messages.length - 1]?.role === "assistant" ? 1 : 0) &&
                      Boolean(messages[messages.length - 1]?.role === "assistant" && (messages[messages.length - 1] as AssistantMessage).persisted);
                    return msg.role === "user" ? (
                      <UserBubble
                        key={msg.id}
                        msg={msg}
                        editable={isLastUser && !busy}
                        editing={editingUserId === msg.id}
                        onStartEdit={bubbleHandlers.startEdit}
                        onCancelEdit={bubbleHandlers.cancelEdit}
                        onSubmitEdit={bubbleHandlers.submitEdit}
                      />
                    ) : (
                      <AssistantBubble
                        key={msg.id}
                        msg={msg}
                        question={messages[i - 1]?.role === "user" ? (messages[i - 1] as UserMessage).content : undefined}
                        onRetry={isLastAssistant ? bubbleHandlers.regenerate : bubbleHandlers.askAgain}
                        retryLabel={isLastAssistant ? "Regenerate" : "Ask again"}
                        onFollowUp={bubbleHandlers.followUp}
                        onActionSettled={bubbleHandlers.actionSettled}
                        versions={isLastAssistant ? versions : EMPTY_VERSIONS}
                        onSwitchVersion={isLastAssistant ? bubbleHandlers.switchVersion : undefined}
                      />
                    );
                  })}

                  {/*
                    Only reachable before the first `step` event lands — which is now within
                    a few milliseconds of sending, because the route opens the stream before
                    it starts retrieving. After that the assistant bubble's own ChatActivity
                    takes over and says what is actually happening.
                  */}
                  {awaitingFirstToken && (
                    <div className="flex justify-start">
                      <div className="flex items-center gap-2 px-1 py-2 text-sm text-muted-foreground">
                        <OrbitMark reduceMotion={reduceMotion} />
                        {resuming ? "Still writing the answer…" : deep ? "Researching in depth…" : "Starting…"}
                      </div>
                    </div>
                  )}
                  <div ref={threadEndRef} className="h-px w-full shrink-0" />
                </>
              )}
            </div>
          </div>
          <div
            className={cn(
              "pointer-events-none absolute inset-x-0 bottom-3 flex justify-center transition-opacity duration-150",
              !atBottom && messages.length > 0 ? "opacity-100" : "opacity-0"
            )}
          >
            <button
              type="button"
              // Only a tab stop while it is visible: an invisible button in the tab order is a
              // control you can land on and cannot see.
              tabIndex={!atBottom && messages.length > 0 ? 0 : -1}
              aria-hidden={atBottom || messages.length === 0}
              aria-label="Jump to latest"
              title="Jump to latest"
              onClick={() => {
                stickToBottomRef.current = true;
                setAtBottom(true);
                scrollToBottom(true);
              }}
              className={cn(
                "flex size-8 items-center justify-center rounded-full border border-border/70 bg-card text-muted-foreground shadow-md transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                !atBottom && messages.length > 0 && "pointer-events-auto"
              )}
            >
              <ArrowDown className="size-4" />
            </button>
          </div>
          </div>

          <div className="shrink-0 border-t border-border/60 bg-card p-3 sm:p-4">
            {/* `relative`: the `@` type-ahead anchors to this box's top edge, which is the
                top of the composer pill. */}
            <div className="relative mx-auto max-w-3xl space-y-2.5">
              {queued.length > 0 && (
                <ul aria-label="Queued messages" aria-live="polite" className="space-y-1">
                  {queued.map((item) => (
                    <li
                      key={item.id}
                      className="flex items-center gap-2 rounded-xl border border-border/60 bg-muted/40 py-1 pl-3 pr-1 text-sm"
                    >
                      <span className="min-w-0 flex-1 truncate text-foreground/80">
                        {item.attachments?.length ? <Paperclip className="mr-1.5 inline size-3.5 text-muted-foreground" aria-label={`${item.attachments.length} attached`} /> : null}
                        {item.text}
                      </span>
                      {item.steering ? (
                        <span className="shrink-0 px-2 text-xs text-muted-foreground">Steering…</span>
                      ) : (
                        <>
                          {((streaming && !item.attachments?.length) || !busy) && (
                            <button
                              type="button"
                              title={streaming ? "Send it to the answer being written" : undefined}
                              onClick={() => {
                                if (streaming) return steerQueued(item);
                                setQueued((prev) => prev.filter((q) => q.id !== item.id));
                                sendQuestion(item.text, {
                                  contextContactIds: item.contextContactIds,
                                  attachments: item.attachments ?? [],
                                });
                              }}
                              className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                            >
                              Send now
                            </button>
                          )}
                          <button
                            type="button"
                            aria-label={`Remove queued message: ${item.text}`}
                            onClick={() => setQueued((prev) => prev.filter((q) => q.id !== item.id))}
                            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                          >
                            <X className="size-3.5" />
                          </button>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {fileChips.length > 0 && (
                <ul aria-label="Attached files" aria-live="polite" className="flex flex-wrap gap-1.5">
                  {fileChips.map((chip) => (
                    <li
                      key={chip.id}
                      title={chip.error}
                      className={cn(
                        "flex max-w-full items-center gap-1.5 rounded-lg border py-1 pl-2 pr-1 text-xs",
                        chip.status === "failed"
                          ? "border-destructive/40 bg-destructive/5 text-destructive"
                          : "border-border/60 bg-muted/40 text-foreground/80"
                      )}
                    >
                      {chip.status === "reading" ? (
                        <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-hidden />
                      ) : (
                        <Paperclip className="size-3.5 shrink-0" aria-hidden />
                      )}
                      <span className="min-w-0 truncate">
                        {chip.name}
                        {chip.status === "reading" && <span className="text-muted-foreground"> · reading…</span>}
                        {chip.status === "failed" && <span> · {chip.error || "couldn’t be read"}</span>}
                      </span>
                      <button
                        type="button"
                        aria-label={`Remove ${chip.name}`}
                        onClick={() => removeFile(chip.id)}
                        className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                      >
                        <X className="size-3" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex items-center gap-1 sm:hidden">
                {composerExtras.attach}
                {composerExtras.deep}
                {composerExtras.web}
              </div>
              {/* One pill holding every control, rather than a field with satellites.
                  `items-end` keeps the buttons on the last line as the field grows. */}
              <div
                {...tourAnchor("chat.composer")}
                // Files dropped anywhere on the pill attach to the question.
                onDragOver={(e) => {
                  if (e.dataTransfer.types.includes("Files")) e.preventDefault();
                }}
                onDrop={(e) => {
                  if (!e.dataTransfer.files.length) return;
                  e.preventDefault();
                  addFiles([...e.dataTransfer.files]);
                }}
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
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept={CHAT_ATTACH_ACCEPT}
                  className="sr-only"
                  tabIndex={-1}
                  aria-hidden="true"
                  onChange={(e) => {
                    addFiles([...(e.target.files ?? [])]);
                    e.target.value = "";
                  }}
                />
                <span className="hidden shrink-0 items-center sm:flex">{composerExtras.attach}</span>
                {/* No vertical padding on the field box: the mirror is `inset-0` of it, so
                    any padding there would offset the field from its ghost layer. The field
                    and the mirror each carry their own py instead.

                    `MentionComposer` renders the `@` menu as a sibling of this box. It is
                    absolutely positioned, so it stays out of the pill's flex flow and
                    anchors to the nearest positioned ancestor — the `relative` wrapper
                    above, which is why the menu sits above the WHOLE composer rather than
                    inside the pill. */}
                <MentionComposer
                  className="flex-1"
                  textareaRef={textareaRef}
                  handleRef={composerRef}
                  value={question}
                  onValueChange={onComposerValueChange}
                  picks={attached}
                  onPicksChange={setAttached}
                  // Chat is the surface where a past conversation is worth naming.
                  events
                  // `/` at the start of a line opens the command menu (prefills and page jumps).
                  commands
                  // Off while the recogniser owns the box — an accepted row splices text
                  // the dictated span is anchored against. (Mid-IME is the composer's own
                  // business and it shuts itself.)
                  menuEnabled={!dictation.listening && !loadingThread}
                  boxClassName={COMPOSER_TEXT_BOX}
                  onKeyDown={onComposerKeyDown}
                  onPaste={(e) => {
                    // A pasted screenshot or file attaches; pasted text is left to the field.
                    if (!e.clipboardData.files.length) return;
                    e.preventDefault();
                    addFiles([...e.clipboardData.files]);
                  }}
                  onSelectionCollapsedChange={setSelectionCollapsed}
                  onCompositionChange={setComposing}
                  rows={1}
                  maxLength={CHAT_QUESTION_MAX_CHARS}
                  placeholder={busy ? "Add a follow-up…" : "Ask about your network…"}
                  // The placeholder vanishes once there's text, so it can't be the name.
                  aria-label="Message Orbit"
                  data-dictating={dictation.listening || undefined}
                  textareaClassName={cn(
                    // Bare field: the pill around it owns the border, background, focus
                    // ring and padding. `field-sizing-content` has no ceiling of its own
                    // and this sits in a fixed-height card, so the cap stays.
                    // `min-h-9` matches the 36px control buttons exactly, and py-2 centres
                    // a single 20px line inside it — so with `items-end` the text sits on
                    // the same axis as the mic and send. Growing past one line just adds
                    // height downwards and the buttons stay on the last line.
                    "min-h-9 max-h-40 w-full resize-none overflow-y-auto",
                    FIELD_BARE,
                    // The mirror paints the glyphs while it is up. The caret is left
                    // visible so the field still reads as focused and editable.
                    showMirror && "text-transparent caret-ink selection:text-foreground",
                  )}
                  style={dictation.listening ? { scrollbarGutter: "stable" } : undefined}
                  // Not while busy: a follow-up can be typed, queued or sent to steer.
                  disabled={loadingThread}
                >
                  {showMirror && interimRange && (
                    <ComposerMirror
                      value={question}
                      interimStart={interimRange[0]}
                      interimEnd={interimRange[1]}
                      textareaRef={textareaRef}
                    />
                  )}
                </MentionComposer>
                <span className="hidden shrink-0 items-center gap-1 sm:flex">
                  {composerExtras.deep}
                  {composerExtras.web}
                </span>
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
                <OrbitVoiceEntry
                  surfaceRef={voiceSurfaceRef}
                  hasText={Boolean(question.trim())}
                  busy={busy}
                  disabled={
                    busy ||
                    loadingThread
                  }
                  onStop={stopStreaming}
                  onSend={() => sendQuestion(question)}
                  prepare={async () => {
                    dictation.stop();
                    return ensureThread();
                  }}
                  onEnd={async (id) => {
                    threadPrefetch.forget(id);
                    await loadThread(id);
                    requestAnimationFrame(() => textareaRef.current?.focus());
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
      </div>

      <Sheet open={contextOpen} onOpenChange={setContextOpen}>
        <SheetContent
          side="right"
          // 26rem (416px) instead of the Sheet's `data-[side=right]:sm:max-w-sm` (384px):
          // the three compact scan buttons need ~370px side by side and the sheet leaves
          // 382px inside its border and padding at this width, at 384px only 350px.
          // `data-[side=right]:` matches the built-in rule's selector shape so this wins the
          // cascade; a plain `sm:max-w-*` loses to it.
          className="w-full gap-0 overflow-y-auto data-[side=right]:sm:max-w-[26rem]"
        >
          <SheetHeader className="border-b border-border/60">
            <SheetTitle>Chat context</SheetTitle>
            <SheetDescription>
              Add context for Orbit to keep in mind during this conversation.
              This won&apos;t create or update any contacts.
            </SheetDescription>
          </SheetHeader>
          <div className="flex flex-col gap-3 p-4">
            <h3 id="chat-context-heading" className="text-sm font-medium text-foreground">
              This chat
            </h3>
            <Textarea
              ref={contextTextareaRef}
              aria-labelledby="chat-context-heading"
              rows={8}
              placeholder="e.g. I'm prepping for a fundraise this quarter, so prioritize investor intros."
              value={contextIngest.notes}
              onChange={(e) => contextIngest.setNotes(e.target.value)}
              // `field-sizing-content` (the shared Textarea's default) sizes off the typed
              // content alone, so `rows` never gave this its starting height — an explicit
              // floor does. Matches Capture's own notes box (`messy-notes-capture.tsx`).
              className="min-h-[220px] resize-none"
              disabled={contextSaving}
            />

            {/* Same media-to-text pipeline as Capture's Messy Notes tab: a photo, the
                webcam, or a phone QR handoff all just OCR into the box above — nothing
                here ever queues extraction. */}
            <ScanControls
              accept={CAPTURE_FILE_ACCEPT}
              disabled={contextSaving || contextIngest.busy || contextDictation.listening}
              onRawFiles={contextIngest.handleFilesSelected}
              onPages={contextIngest.ingestScanPages}
              onTranscript={(text, sources, jobId) =>
                contextIngest.onPhoneTranscript(text, sources, jobId ?? null)
              }
              compact
            />
            {contextIngest.busy && (
              <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" /> Reading…
              </span>
            )}

            <div className="flex items-center justify-between gap-2">
              <DictationButton
                state={contextDictation.state}
                level={contextDictation.level}
                disabled={contextSaving || contextIngest.busy}
                onToggle={(source) => {
                  contextDictation.toggle();
                  if (source === "pointer") contextTextareaRef.current?.focus();
                }}
                // Unlike the main composer's mic, which sits inline right next to the
                // field it dictates into, this one is alone in the footer — an outline
                // gives it the same "this is a control" weight the Save button has.
                className="border border-border/70"
              />
              <Button
                type="button"
                onClick={saveContext}
                disabled={contextSaving || contextIngest.busy}
              >
                {contextSaving ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  "Save"
                )}
              </Button>
            </div>
          </div>
          <WritingInstructionsField active={contextOpen} />
          <ChatMemoriesField active={contextOpen} />
        </SheetContent>
      </Sheet>
    </ChatThreadProvider>
  );
}

const UserBubble = memo(function UserBubble({
  msg,
  editable = false,
  editing = false,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
}: {
  msg: UserMessage;
  /** Only the very last user turn can be edited — versions exist for the last turn only. */
  editable?: boolean;
  editing?: boolean;
  /** Called with this bubble's message id — a stable handler shared by every bubble. */
  onStartEdit?: (id: string) => void;
  onCancelEdit?: () => void;
  onSubmitEdit?: (id: string, text: string) => void;
}) {
  const [text, setText] = useState(msg.content);
  const fieldRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editing) return;
    setText(msg.content);
    const el = fieldRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [editing, msg.content]);

  function submit() {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSubmitEdit?.(msg.id, trimmed);
  }

  if (editing) {
    return (
      <div className="flex justify-end">
        <div className="w-full max-w-[85%] rounded-2xl rounded-br-md border border-primary/40 bg-background p-2">
          <Textarea
            ref={fieldRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                onCancelEdit?.();
              }
            }}
            rows={2}
            maxLength={CHAT_QUESTION_MAX_CHARS}
            aria-label="Edit your question"
            className="min-h-16 resize-none border-none bg-transparent p-1 text-sm shadow-none focus-visible:ring-0"
          />
          <div className="mt-1 flex justify-end gap-1.5">
            <button
              type="button"
              onClick={onCancelEdit}
              className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              aria-label="Cancel edit"
              title="Cancel"
            >
              <X className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={!text.trim()}
              className="flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Save & ask
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="group flex items-center justify-end gap-1.5">
      {editable && (
        <button
          type="button"
          onClick={() => onStartEdit?.(msg.id)}
          aria-label="Edit this question"
          title="Edit"
          className="relative flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground tap-target pointer-fine:opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
        >
          <Pencil className="size-3.5" />
        </button>
      )}
      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-sm break-words text-primary-foreground">
        {msg.fileNames?.length ? (
          <ul aria-label="Attached files" className="mb-1.5 flex flex-wrap gap-1">
            {msg.fileNames.map((name, i) => (
              <li key={`${name}-${i}`} className="flex max-w-full items-center gap-1 rounded-md bg-primary-foreground/15 px-1.5 py-0.5 text-xs">
                <Paperclip className="size-3 shrink-0" aria-hidden />
                <span className="truncate">{name}</span>
              </li>
            ))}
          </ul>
        ) : null}
        <MentionText text={msg.content} names={msg.mentionNames} />
      </div>
    </div>
  );
});

const AssistantBubble = memo(function AssistantBubble({
  msg,
  question,
  onRetry,
  retryLabel,
  onFollowUp,
  onActionSettled,
  versions = [],
  onSwitchVersion,
}: {
  msg: AssistantMessage;
  /** The question this answers — what an on-demand draft is written for. */
  question?: string;
  /** Called with this bubble's message id — the handlers are stable and shared by every bubble. */
  onRetry?: (id: string) => void;
  retryLabel?: string;
  onFollowUp?: (question: string) => void;
  onActionSettled?: (messageId: string, actionId: string, next: StoredProposedAction) => void;
  /** Every version of this turn, when it is the last one. Otherwise empty — no switcher. */
  versions?: VersionRow[];
  onSwitchVersion?: (version: number) => void;
}) {
  const steps = msg.steps ?? [];

  // Who this answer may name, from its own grounding only: the contacts retrieval returned
  // and the people it recommended. Exact names, so the prose links only what is known.
  const people = useMemo<ChatPerson[]>(() => {
    const out: ChatPerson[] = [];
    for (const c of msg.retrieved ?? []) {
      out.push({ name: c.fullName, href: `/contacts/${c.id}` });
    }
    for (const r of msg.recommendations) {
      if (r.recruiter_id) out.push({ name: r.name, href: `/recruiters/${r.recruiter_id}` });
      else if (r.contact_id) out.push({ name: r.name, href: `/contacts/${r.contact_id}` });
    }
    return out;
  }, [msg.retrieved, msg.recommendations]);

  // A name for a proposed action's contact — same sources as `people`, keyed by id instead
  // of assembled into link text.
  const nameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of msg.retrieved ?? []) map.set(c.id, c.fullName);
    for (const r of msg.recommendations) if (r.contact_id) map.set(r.contact_id, r.name);
    return map;
  }, [msg.retrieved, msg.recommendations]);

  // Photos learned by the activity steps, so a card shows the same face the orbit did.
  const photoById = useMemo(() => {
    const map = new Map<string, string>();
    for (const step of msg.steps ?? []) {
      for (const ref of step.refs ?? []) {
        if (ref.kind === "contact" && ref.photoUrl && !map.has(ref.id)) map.set(ref.id, ref.photoUrl);
      }
    }
    return map;
  }, [msg.steps]);

  // Role and company for a card come from retrieval's own rows, not from the model.
  const subtitleById = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of msg.retrieved ?? []) {
      const line = [c.title, c.company].filter(Boolean).join(" · ");
      if (line) map.set(c.id, line);
    }
    return map;
  }, [msg.retrieved]);

  // People the answer placed inline (`::people`) render there, as cards; the grid below keeps
  // only the rest — recruiters, and every recommendation of an answer written before blocks.
  const inlineIds = useMemo(() => new Set(peopleIdsIn(msg.answer)), [msg.answer]);
  const recById = useMemo(
    () => new Map(msg.recommendations.filter((r) => r.contact_id).map((r) => [r.contact_id!, r])),
    [msg.recommendations]
  );
  const renderCard = (r: ChatRecommendation) => (
    <RecommendationCard
      key={`${msg.id}-${r.recruiter_id || r.contact_id}`}
      rec={r}
      question={question}
      subtitle={r.contact_id ? subtitleById.get(r.contact_id) : undefined}
      photoUrl={r.contact_id ? photoById.get(r.contact_id) : undefined}
      // Only a saved answer can send: the server checks the message recommended this
      // person, and a streamed-but-unsaved one has no row to check against.
      messageId={msg.persisted ? msg.id : undefined}
      sentAt={r.contact_id ? msg.sentTo?.[r.contact_id] : undefined}
    />
  );
  const renderPeople = (ids: string[]) => {
    // While streaming the cards come from the blocks the server sent; once saved, from the
    // stored recommendations — the same people, the latter after the server's checks.
    const recs = ids.flatMap((id): ChatRecommendation[] => {
      const saved = recById.get(id);
      const person = msg.blocks?.people[id];
      // An entry added only to hold a saved draft has no reason of its own: keep the role line.
      if (saved) return [saved.reason ? saved : { ...saved, reason: person?.subtitle ?? "" }];
      return person
        ? [{ contact_id: id, recruiter_id: null, name: person.name, reason: person.subtitle ?? "", suggested_action: "", draft_message: null }]
        : [];
    });
    return recs.length ? <div className="grid gap-2 sm:grid-cols-2">{recs.map(renderCard)}</div> : null;
  };
  const gridRecs = msg.recommendations.filter((r) => !r.contact_id || !inlineIds.has(r.contact_id));
  const copyText = useMemo(
    () =>
      directivesAsText(msg.answer, (id) => recById.get(id)?.name ?? msg.blocks?.people[id]?.name, msg.blocks?.lists),
    [msg.answer, recById, msg.blocks]
  );

  return (
    // No bubble on the assistant side: the answer is the page's content, not a chat turn
    // from a stranger. The user's own words keep a bubble, so the two are still easy to
    // tell apart while scanning.
    <div className="flex justify-start">
      <div className="w-full min-w-0 max-w-[92%] space-y-3">
        {steps.length > 0 && (
          <ChatActivity steps={steps} state={msg.streaming ? "live" : "final"} answerStarted={Boolean(msg.answer)} />
        )}
        {msg.answer && (
          <div className="text-sm leading-relaxed text-foreground">
            {/* Only once persisted: `msg.id` is a client-minted placeholder until `done`
                swaps in the real row id, and a chip needs the real id to fetch its snippet. */}
            <ChatMarkdown
              people={people}
              messageId={msg.persisted ? msg.id : undefined}
              evidence={msg.evidence}
              blocks={msg.blocks}
              // A stopped or failed answer was cut off mid-stream too: the same hold-back keeps
              // a half-written directive or citation at its end off the screen.
              streaming={Boolean(msg.streaming || msg.stopped || msg.failed)}
              renderPeople={renderPeople}
            >
              {msg.answer}
            </ChatMarkdown>
          </div>
        )}
        {msg.stopped && (
          <p className="text-xs text-muted-foreground">
            Stopped — this turn wasn’t saved.
          </p>
        )}
        {msg.failed && (
          <p role="alert" className="text-xs text-destructive">
            {msg.failed.replace(/[.!?]?$/, ".")} This turn wasn’t saved — your question is back in the box to try again.
          </p>
        )}
        {gridRecs.length > 0 && <div className="grid gap-2 sm:grid-cols-2">{gridRecs.map(renderCard)}</div>}
        {/* As soon as they stream, beside the answer that proposed them; their controls wait
            for the saved row, since committing needs its real id. */}
        {(msg.proposedActions?.length ?? 0) > 0 && (
          <ProposedActionsList
            messageId={msg.id}
            actions={msg.proposedActions!}
            nameById={nameById}
            pending={!msg.persisted}
            onSettled={(actionId, next) => onActionSettled?.(msg.id, actionId, next)}
          />
        )}
        {!msg.streaming && (msg.followUps?.length ?? 0) > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {msg.followUps?.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => onFollowUp?.(q)}
                className="rounded-full border border-border/70 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                {q}
              </button>
            ))}
          </div>
        )}
        {!msg.streaming && msg.answer && (
          <div className="flex flex-wrap items-center gap-2">
            <AnswerActions
              messageId={msg.id}
              answer={copyText}
              persisted={Boolean(msg.persisted)}
              initialFeedback={msg.feedback ?? null}
              onRetry={onRetry && (() => onRetry(msg.id))}
              retryLabel={retryLabel}
            />
            {versions.length > 1 && <VersionSwitcher versions={versions} currentId={msg.id} onSwitch={onSwitchVersion} />}
          </div>
        )}
      </div>
    </div>
  );
});

function VersionSwitcher({
  versions,
  currentId,
  onSwitch,
}: {
  versions: VersionRow[];
  /** The assistant message id currently shown, to find its place among `versions`. */
  currentId: string;
  onSwitch?: (version: number) => void;
}) {
  const index = versions.findIndex((v) => v.assistantMessageId === currentId);
  if (index === -1) return null;
  const current = versions[index]!;
  return (
    <div className="flex items-center gap-0.5 text-xs text-muted-foreground" role="group" aria-label="Answer version">
      <button
        type="button"
        onClick={() => onSwitch?.(versions[index - 1]!.version)}
        disabled={index === 0}
        aria-label="Previous version"
        className="relative flex size-6 tap-target items-center justify-center rounded transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
      >
        <ChevronLeft className="size-3.5" />
      </button>
      <span className="tabular-nums" aria-live="polite">
        {index + 1}/{versions.length}
      </span>
      <button
        type="button"
        onClick={() => onSwitch?.(versions[index + 1]!.version)}
        disabled={index === versions.length - 1}
        aria-label="Next version"
        className="relative flex size-6 tap-target items-center justify-center rounded transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
      >
        <ChevronRight className="size-3.5" />
      </button>
      <span className="sr-only">version {current.version}</span>
    </div>
  );
}

const RecommendationCard = memo(function RecommendationCard({
  rec,
  question,
  subtitle,
  photoUrl,
  messageId,
  sentAt,
}: {
  rec: ChatRecommendation;
  /** The question the answer was for — what a draft written on demand is about. */
  question?: string;
  /** Role and company from retrieval — absent on a reloaded thread, which is fine. */
  subtitle?: string | null;
  /** The contact's stored photo, when the activity steps learned it. */
  photoUrl?: string | null;
  /** The saved answer this card belongs to. Absent until it is saved, which hides Send. */
  messageId?: string;
  /** When this draft was already emailed to this person, from the timeline. */
  sentAt?: string;
}) {
  // A draft edited before the Gmail connect redirect comes back with the person. Read-only
  // here and cleared in an effect, so a StrictMode double render cannot lose it.
  const [resume] = useState(() =>
    messageId && rec.contact_id ? peekSendResumeFor(messageId, rec.contact_id) : null
  );
  useEffect(() => {
    if (resume) clearSendResume();
  }, [resume]);
  const [sendOpen, setSendOpen] = useState(false);
  const [sendBody, setSendBody] = useState("");
  const [sent, setSent] = useState<{ at: string; maybe: boolean } | null>(
    sentAt ? { at: sentAt, maybe: false } : null
  );
  const href = rec.recruiter_id
    ? `/recruiters/${rec.recruiter_id}`
    : rec.contact_id
      ? `/contacts/${rec.contact_id}`
      : "#";
  const canRemind = Boolean(rec.contact_id);
  // A person the answer placed inline (`::people`) carries the server's role line as its
  // reason and no next step: the answer's own sentence says why, so the card shows who.
  const placed = !rec.recruiter_id && !rec.suggested_action;
  const line = rec.recruiter_id ? "Recruiter" : subtitle || (placed ? rec.reason : undefined);
  // Drafts are written when asked for, not with every answer — most would never be read.
  const [draft, setDraft] = useState(rec.edited_draft ?? rec.draft_message);
  const [drafting, setDrafting] = useState(false);
  // Kept on the saved answer so a reload brings the draft back. Quiet: the text stays on
  // screen whatever happens, and an unsaved answer has nowhere to keep it yet.
  const contactId = rec.contact_id;
  const saveDraft = useMemo(
    () =>
      messageId && contactId
        ? (text: string) => void saveChatDraft(messageId, contactId, text).catch(() => {})
        : undefined,
    [messageId, contactId]
  );
  async function writeDraft() {
    if (!rec.contact_id || drafting) return;
    setDrafting(true);
    try {
      const result = await draftContactFollowUp(rec.contact_id, { channel: "email", intent: question });
      if (result.ok) {
        setDraft(result.body);
        saveDraft?.(result.body);
      } else toast.error(result.error);
    } catch (err) {
      toast.error(friendlyError(err, TOAST_COPY.draftFollowUpFailed));
    } finally {
      setDrafting(false);
    }
  }

  return (
    <div className="flex h-full flex-col rounded-xl border border-border/70 bg-background p-3">
      <div className="flex items-center gap-2.5">
        {/* The picture opens the profile too — it is the obvious thing to click. The name
            beside it is the same link and stays the keyboard and screen-reader route, so this
            one is left out of both (`tabIndex`, `aria-hidden`) rather than announced twice. */}
        {href !== "#" ? (
          <Link
            href={href}
            tabIndex={-1}
            aria-hidden="true"
            className="shrink-0 rounded-full ring-2 ring-transparent transition-[transform,box-shadow] hover:scale-105 hover:ring-primary/40"
          >
            <ContactAvatar
              contactId={rec.contact_id ?? null}
              fullName={rec.name}
              profileImageUrl={photoUrl}
              size="sm"
              className="size-9"
            />
          </Link>
        ) : (
          <ContactAvatar
            contactId={rec.contact_id ?? null}
            fullName={rec.name}
            profileImageUrl={photoUrl}
            size="sm"
            className="size-9 shrink-0"
          />
        )}
        <div className="min-w-0 flex-1">
          <Link
            href={href}
            className="block truncate text-sm font-medium text-foreground hover:text-primary hover:underline"
          >
            {rec.name}
          </Link>
          {line && <p className="truncate text-xs text-muted-foreground">{line}</p>}
        </div>
      </div>
      {!placed && rec.reason && <p className="mt-2 text-xs leading-snug text-muted-foreground">{rec.reason}</p>}
      {rec.suggested_action && (
        <p className="mt-1.5 text-xs leading-snug">
          <span className="font-medium">Next: </span>
          {rec.suggested_action}
        </p>
      )}
      {!draft && !resume && rec.contact_id && (
        <button
          type="button"
          onClick={writeDraft}
          disabled={drafting}
          className="mt-2.5 inline-flex w-fit items-center gap-1.5 rounded-full border border-border/70 px-2.5 py-1 text-2xs font-medium text-foreground/80 transition-colors hover:bg-muted disabled:opacity-60"
        >
          {drafting ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Mail className="size-3.5" aria-hidden />}
          {drafting ? "Drafting…" : "Draft message"}
        </button>
      )}
      {(draft || resume) && (
        <DraftEditor
          initial={resume?.body ?? draft ?? ""}
          name={rec.name}
          onSave={saveDraft}
          actions={
            messageId && rec.contact_id
              ? (text) =>
                  sent ? (
                    <p className="flex items-center gap-1.5 text-2xs text-muted-foreground">
                      <Check className="size-3.5" aria-hidden />
                      {sent.maybe ? "May have been sent — check your Sent folder" : `Sent to ${rec.name}`}
                      {!sent.maybe && ` · ${formatSentAt(sent.at)}`}
                    </p>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setSendBody(text);
                        setSendOpen(true);
                      }}
                      className="inline-flex items-center gap-1.5 rounded-full bg-primary px-2.5 py-1 text-2xs font-medium text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                    >
                      <Mail className="size-3.5" aria-hidden /> Send email…
                    </button>
                  )
              : undefined
          }
        />
      )}
      {messageId && rec.contact_id && (
        <GmailSendDialog
          open={sendOpen}
          onOpenChange={setSendOpen}
          messageId={messageId}
          contactId={rec.contact_id}
          name={rec.name}
          body={sendBody}
          onSent={(at, maybe) => setSent({ at, maybe })}
          onUndone={() => setSent(null)}
        />
      )}
      {canRemind && (
        <div className="mt-auto pt-2.5">
          <ReminderButton
            contactId={rec.contact_id!}
            name={rec.name}
            suggestedAction={rec.suggested_action}
          />
        </div>
      )}
    </div>
  );
});
