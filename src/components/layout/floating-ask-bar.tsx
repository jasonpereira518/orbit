"use client";

import Link from "next/link";
import { IntentLink } from "@/components/ui/intent-link";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { AnimatePresence, motion } from "motion/react";
import { DUR, EASE_HOUSE } from "@/lib/motion";
import { ArrowUp, CornerDownLeft, RotateCcw, Search, X } from "lucide-react";
import { toast } from "@/lib/toast";
import { friendlyError } from "@/lib/errors";
import { OPEN_ASK_BAR_EVENT, type OpenAskBarDetail } from "@/lib/ask-bar-events";
import { useFeedbackPanelState } from "@/lib/feedback-events";
import { askNetwork, createChatThread } from "@/actions/chat";
import { streamChat } from "@/lib/chat-stream-client";
import {
  createStreamSmoother,
  prefersReducedMotionNow,
  type StreamSmoother,
} from "@/lib/stream-smoother";
import type { ChatStep } from "@/lib/chat-stream-protocol";
import { ChatActivity } from "@/components/chat/chat-activity";
import { OrbitMark } from "@/components/chat/orbit-mark";
import { useChatSuggestions } from "@/components/chat/use-chat-suggestions";
import { CONTACT_PAGE_SUGGESTIONS, type ChatSuggestion } from "@/lib/chat-suggestions";
import { getAskBarContact } from "@/actions/contacts";
import { searchDashboardContacts } from "@/actions/search";
import { createReminder } from "@/actions/reminders";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import { Button } from "@/components/ui/button";
import type { KeywordSearchHit } from "@/lib/keyword-search";
import { companyBrandColor } from "@/lib/company-brand";
import { cn } from "@/lib/utils";
import { TOAST_COPY } from "@/lib/toast-copy";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";

/**
 * Split out of the shell's chunk.
 *
 * `ChatMarkdown` pulls react-markdown — micromark plus the mdast/hast pipeline, ~30-40KB
 * gzipped — and only ever renders an answer that exists *after* the user has asked
 * something. `AppShell` mounts this bar on nearly every route, so importing it statically
 * put that parser in the first load of /dashboard, /contacts, /graph and /reminders to
 * render nothing. `preloadChatMarkdown` runs when the bar opens, so the chunk is already
 * in flight long before an answer comes back and there is no gap to paint around.
 */
const ChatMarkdown = dynamic(
  () => import("@/components/chat/chat-markdown").then((m) => m.ChatMarkdown),
  { loading: () => null }
);

function preloadChatMarkdown() {
  void import("@/components/chat/chat-markdown");
}

type ChatResult = Extract<
  Awaited<ReturnType<typeof askNetwork>>,
  { ok: true }
>;

type AskBarContact = NonNullable<Awaited<ReturnType<typeof getAskBarContact>>>;

type UserMessage = {
  id: string;
  role: "user";
  content: string;
};

type AssistantMessage = {
  id: string;
  role: "assistant";
  answer: string;
  recommendations: ChatResult["recommendations"];
  retrieved: ChatResult["retrieved"];
  /** True while the answer is still arriving from `/api/chat`. */
  streaming?: boolean;
  /** The stages the server reported, so this bar narrates the same work `/chat` does. */
  steps?: ChatStep[];
};

type ThreadMessage = UserMessage | AssistantMessage;

const CONTACT_PATH_RE =
  /^\/contacts\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/**
 * Only the contact-scoped set is hardcoded here now.
 *
 * The general ones were a verbatim copy of the chat panel's, which is how they drifted from
 * what the pipeline could actually answer. They come from `useChatSuggestions` instead —
 * the same personalised row `/chat` shows, rendered as pills because this popover is too
 * narrow for a card. On a contact's page these still win: the pathname is a stronger signal
 * about what you are asking than anything a general rule could infer.
 */
/** How many fit the bar's panel without crowding out the search results below. */
const ASK_BAR_SUGGESTIONS = 4;

function newId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function contactIdFromPath(pathname: string): string | null {
  const match = CONTACT_PATH_RE.exec(pathname);
  return match?.[1] ?? null;
}

export function FloatingAskBar() {
  /**
   * Out of the way while a feedback screenshot is being taken or cropped.
   *
   * Two reasons, and the store's `"capturing"` covers both because it spans the widget's
   * capture AND selection phases. `getDisplayMedia` photographs the composited output, so
   * this bar would otherwise be baked into the picture of the very page being reported on.
   * And the crop overlay leaves a clear band along the bottom for its own toolbar, which is
   * exactly where this sits — so it showed through underneath it.
   *
   * `null`, not the `visible` slide-out below: that animates over `DUR.slow`, and the frame
   * is grabbed a tick after the phase changes. A bar halfway through leaving is still in
   * the photograph. Same reasoning as `FeedbackTrigger`.
   */
  const feedbackState = useFeedbackPanelState();
  const pathname = usePathname();
  const pathContactId = contactIdFromPath(pathname);

  const inputId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<number | null>(null);
  const threadEndRef = useRef<HTMLDivElement>(null);
  const chatThreadIdRef = useRef<string | null>(null);

  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<KeywordSearchHit[]>([]);
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [lastUserQuery, setLastUserQuery] = useState("");
  const [searchPending, startSearch] = useTransition();
  // Plain state, not a transition: streamed tokens must render as they arrive, and
  // updates inside `startTransition` are deferred until the async work settles.
  const [chatPending, setChatPending] = useState(false);
  // The "searching" bubble makes sense until the first token; after that the answer
  // itself is the progress indicator.
  const awaitingFirstToken =
    chatPending && !messages.some((m) => m.role === "assistant" && m.streaming);
  const reduceMotion = usePrefersReducedMotion();

  const [profileContact, setProfileContact] = useState<AskBarContact | null>(
    null
  );
  const [chipDismissed, setChipDismissed] = useState(false);

  // Warm the markdown chunk as soon as the bar opens, so it is resolved well before the
  // first answer returns from the model.
  useEffect(() => {
    if (open) preloadChatMarkdown();
  }, [open]);

  const personContextActive =
    Boolean(pathContactId) && Boolean(profileContact) && !chipDismissed;
  const activeContactId = personContextActive ? profileContact!.id : null;
  const activeContactName = personContextActive
    ? profileContact!.displayName
    : null;

  useEffect(() => {
    setChipDismissed(false);
    setProfileContact(null);

    if (!pathContactId) return;

    let cancelled = false;
    void getAskBarContact(pathContactId).then((contact) => {
      if (!cancelled) setProfileContact(contact);
    });

    return () => {
      cancelled = true;
    };
  }, [pathContactId]);

  const stayVisibleWhileWaiting = chatPending;

  const focusBar = useCallback(() => {
    setHidden(false);
    setOpen(true);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  }, []);

  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      // ⌘J, not ⌘K: ⌘K opens the command palette, which can also hand a typed question
      // straight to this bar — so the old shortcut still gets here, one Enter later.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") {
        e.preventDefault();
        focusBar();
      }
      if (e.key === "Escape" && open) {
        e.preventDefault();
        setOpen(false);
        inputRef.current?.blur();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusBar, open]);

  // Read through a ref so the listener below is registered once, not re-bound every time
  // `sendQuestion`'s identity changes with a pending reply.
  const sendQuestionRef = useRef<(q: string) => void>(() => {});
  // The reveal buffer for the answer in flight, so unmounting stops it drawing.
  const smootherRef = useRef<StreamSmoother | null>(null);
  useEffect(() => () => smootherRef.current?.cancel(), []);

  useEffect(() => {
    function onOpenRequest(e: Event) {
      focusBar();
      const question = (e as CustomEvent<OpenAskBarDetail | null>).detail?.question?.trim();
      if (question) sendQuestionRef.current(question);
    }
    window.addEventListener(OPEN_ASK_BAR_EVENT, onOpenRequest);
    return () => window.removeEventListener(OPEN_ASK_BAR_EVENT, onOpenRequest);
  }, [focusBar]);

  const chatPendingRef = useRef(chatPending);
  chatPendingRef.current = chatPending;
  const lastScrollMetaRef = useRef<{ target: EventTarget | null; y: number }>({
    target: null,
    y: 0,
  });

  useEffect(() => {
    function scrollYFromEvent(e: Event): number | null {
      const t = e.target;
      if (
        t === document ||
        t === document.documentElement ||
        t === document.body
      ) {
        return window.scrollY;
      }
      if (t instanceof HTMLElement) {
        // Ignore tiny nested scroll areas (e.g. the ask panel results list)
        if (wrapRef.current?.contains(t)) return null;
        return t.scrollTop;
      }
      return window.scrollY;
    }

    function onScroll(e: Event) {
      const y = scrollYFromEvent(e);
      if (y === null) return;

      const meta = lastScrollMetaRef.current;
      const delta =
        meta.target === e.target ? y - meta.y : 0;
      lastScrollMetaRef.current = { target: e.target, y };

      if (Math.abs(delta) < 6) return;

      // Stay visible near the top of the page, or while a reply is in flight
      if (y < 24 || chatPendingRef.current) {
        setHidden(false);
        return;
      }

      if (delta > 0) {
        setHidden(true);
        setOpen(false);
        inputRef.current?.blur();
      } else {
        setHidden(false);
      }
    }

    document.addEventListener("scroll", onScroll, {
      passive: true,
      capture: true,
    });
    return () =>
      document.removeEventListener("scroll", onScroll, { capture: true });
  }, []);

  useEffect(() => {
    function onPointer(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) {
        if (!query.trim() && messages.length === 0) setOpen(false);
      }
    }
    document.addEventListener("mousedown", onPointer);
    return () => document.removeEventListener("mousedown", onPointer);
  }, [query, messages.length]);

  useEffect(() => {
    if (open) {
      threadEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [messages, chatPending, open]);

  function runLiveSearch(value: string) {
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      startSearch(async () => {
        const q = value.trim();
        if (!q || messages.length > 0) {
          setHits([]);
          return;
        }
        const next = await searchDashboardContacts(q);
        setHits(next);
      });
    }, 180);
  }

  function fillMostRecentUserMessage() {
    const fromThread = [...messages]
      .reverse()
      .find((m): m is UserMessage => m.role === "user");
    const content = fromThread?.content || lastUserQuery;
    if (!content) return false;
    setQuery(content);
    setOpen(true);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(content.length, content.length);
    });
    return true;
  }

  const ensureChatThread = useCallback(async () => {
    if (chatThreadIdRef.current) return chatThreadIdRef.current;
    const created = await createChatThread();
    chatThreadIdRef.current = created.id;
    return created.id;
  }, []);

  const sendQuestion = useCallback(
    (raw: string, opts?: { contextContactIds?: readonly string[] }) => {
      const q = raw.trim();
      if (!q || chatPending) return;

      setLastUserQuery(q);
      const userMsg: UserMessage = {
        id: newId(),
        role: "user",
        content: q,
      };
      setMessages((prev) => [...prev, userMsg]);
      setQuery("");
      setHits([]);
      setOpen(true);

      const contactId = activeContactId;
      const assistantId = newId();
      setChatPending(true);
      void (async () => {
        let threadId: string;
        try {
          threadId = await ensureChatThread();
        } catch (err) {
          // Creating a thread only inserts a row — it never needs an AI key, so the key
          // message was the wrong fallback here.
          toast.error(friendlyError(err, TOAST_COPY.chatStartFailed));
          setMessages((prev) => prev.filter((m) => m.id !== userMsg.id));
          setQuery(q);
          setChatPending(false);
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
            {
              id: assistantId,
              role: "assistant",
              answer: "",
              recommendations: [],
              retrieved: [],
              streaming: true,
            },
          ]);
        };

        // Same frame-at-a-time reveal as the chat page; every path that ends the answer flushes it.
        const smoother = createStreamSmoother(
          (chunk) => {
            ensurePlaceholder();
            patch((m) => ({ ...m, answer: m.answer + chunk }));
          },
          { reduced: prefersReducedMotionNow() }
        );
        smootherRef.current = smoother;

        await streamChat(
          {
            question: q,
            threadId,
            contactId: contactId ?? undefined,
            // A suggestion card names someone without an `@` token, so its id rides along
            // here — that is what routes the question through `loadAttachedPeople` and puts
            // the real timeline in front of the model.
            contextContactIds: opts?.contextContactIds
              ? [...opts.contextContactIds]
              : undefined,
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
            onDone: (info) => {
              smoother.flush();
              ensurePlaceholder();
              patch((m) => ({ ...m, retrieved: info.retrieved, streaming: false }));
              if (info.notice) toast.message(info.notice);
            },
            onError: (message) => {
              smoother.cancel();
              toast.error(message);
              setMessages((prev) => prev.filter((m) => m.id !== userMsg.id && m.id !== assistantId));
              setQuery(q);
            },
          }
        );
        smoother.flush();
        smootherRef.current = null;
        setChatPending(false);
      })();
    },
    [activeContactId, chatPending, ensureChatThread]
  );
  useEffect(() => {
    sendQuestionRef.current = (q) => sendQuestion(q);
  }, [sendQuestion]);

  function clearThread() {
    setMessages([]);
    setQuery("");
    setHits([]);
    chatThreadIdRef.current = null;
  }

  const showPanel = open;
  const visible = !hidden || stayVisibleWhileWaiting;
  // Fetched only once the bar is open: it is mounted on nearly every route, and a closed
  // bar has no business issuing a query. Shares a module-level cache with /chat.
  const personalised = useChatSuggestions(open && !personContextActive);
  // Shaped as suggestions so one component renders both sets. `kind` is "generic" because
  // that is what these are — fixed strings, not a rule's output — and nothing here reads it
  // beyond picking an icon the pill variant does not draw.
  const profileChips: ChatSuggestion[] = useMemo(
    () =>
      CONTACT_PAGE_SUGGESTIONS.map((question, i) => ({
        id: `profile:${i}`,
        kind: "generic" as const,
        question,
        basis: "",
        contactIds: [],
        interactionType: null,
        rank: 10,
      })),
    [],
  );
  // Capped: this popover is `w-80` inside a 48vh scroller, and six long questions wrapped
  // to five lines of pills, which pushed the results below the fold.
  const suggestionChips = (
    personContextActive && open ? profileChips : (personalised ?? [])
  ).slice(0, ASK_BAR_SUGGESTIONS);
  const placeholder =
    personContextActive && open && activeContactName
      ? `Ask about ${activeContactName}…`
      : "Ask your network…";

  // Nothing asked, typed or found yet: the panel is an invitation, so it gets a real heading.
  const idleIntro =
    messages.length === 0 && !chatPending && !searchPending && hits.length === 0 && !query.trim();

  // After every hook, before the tree — see the note on `feedbackState` above.
  if (feedbackState === "capturing") return null;

  return (
    <motion.div
      ref={wrapRef}
      initial={false}
      animate={
        visible
          ? { y: 0, opacity: 1 }
          : { y: 72, opacity: 0 }
      }
      transition={{ duration: DUR.slow, ease: EASE_HOUSE }}
      className={cn(
        "pointer-events-none fixed inset-x-0 z-50 justify-center px-4",
        // On mobile the bar is intrusive if left permanently floating above
        // the bottom nav — keep it fully out of the layout there until the
        // "Ask your network" item in the More sheet opens it. Desktop keeps
        // the persistent collapsed pill.
        open ? "flex" : "hidden md:flex",
        "bottom-[calc(6.875rem+env(safe-area-inset-bottom))] md:bottom-5",
        !visible && "pointer-events-none"
      )}
      aria-hidden={!visible}
    >
      {/* A slim pill at rest that opens out to full width once it is in use. A spring, not a
          CSS transition: it picks up from wherever it is when a click lands mid-animation. */}
      <motion.div
        initial={false}
        animate={{ maxWidth: open || query ? 448 : 288 }}
        transition={
          reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 320, damping: 36, mass: 0.8 }
        }
        className={cn(
          "flex w-full flex-col gap-2",
          visible ? "pointer-events-auto" : "pointer-events-none"
        )}
      >
        <AnimatePresence>
          {showPanel && (
            <motion.div
              key="panel"
              initial={{ opacity: 0, y: 12, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.98 }}
              transition={{ duration: DUR.base, ease: EASE_HOUSE }}
              className="overflow-hidden rounded-3xl border border-border/60 bg-card/95 shadow-2xl shadow-black/[0.08] backdrop-blur-md"
            >
              <div
                className={cn(
                  "flex items-center justify-between pr-2 pl-4",
                  idleIntro ? "pt-2.5 pb-0.5" : "py-2"
                )}
              >
                <p
                  className={cn(
                    idleIntro
                      ? "font-display text-sm font-medium text-ink"
                      : "text-xs text-muted-foreground"
                  )}
                >
                  {messages.length > 0
                    ? personContextActive && activeContactName
                      ? `About ${activeContactName}`
                      : "Your network"
                    : searchPending
                      ? "Looking…"
                      : hits.length > 0
                        ? `${hits.length} ${hits.length === 1 ? "person matches" : "people match"}`
                        : personContextActive && activeContactName
                          ? `Ask about ${activeContactName}`
                          : "Ask your network"}
                </p>
                <div className="flex items-center gap-0.5">
                  {messages.length > 0 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 rounded-full px-2.5 text-xs text-muted-foreground"
                      onClick={clearThread}
                    >
                      <RotateCcw className="mr-1 size-3" />
                      Start over
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="rounded-full text-muted-foreground"
                    aria-label="Close"
                    onClick={() => setOpen(false)}
                  >
                    <X className="size-3.5" />
                  </Button>
                </div>
              </div>

              <div className="max-h-[min(56vh,30rem)] overflow-y-auto">
                {messages.length === 0 && !chatPending && hits.length === 0 && (
                  <div className="px-2 pb-2">
                    {query.trim() ? (
                      <p className="px-2 pt-1 pb-2 text-sm text-muted-foreground">
                        {searchPending ? (
                          "Looking…"
                        ) : (
                          <>
                            Nobody by that name. Press{" "}
                            <kbd className="inline-flex h-5 items-center rounded-md border border-border/60 bg-background px-1 align-middle">
                              <CornerDownLeft className="size-3" aria-hidden />
                              <span className="sr-only">Enter</span>
                            </kbd>{" "}
                            to ask instead.
                          </>
                        )}
                      </p>
                    ) : (
                      <>
                        <p className="px-2 pb-2 text-xs text-muted-foreground">
                          {personContextActive && activeContactName
                            ? `What would you like to know about ${activeContactName}?`
                            : "Ask anything about people, companies, or follow-ups in your network."}
                        </p>
                        {suggestionChips.length > 0 && (
                          <ul aria-label="Suggested questions" className="flex flex-col gap-1.5">
                            {suggestionChips.map((s) => (
                              <li key={s.id} className="flex">
                                <button
                                  type="button"
                                  disabled={chatPending}
                                  onClick={() =>
                                    sendQuestion(s.question, {
                                      contextContactIds: s.contactIds.length ? s.contactIds : undefined,
                                    })
                                  }
                                  className="group flex w-full flex-col rounded-xl border border-border/60 bg-background/70 px-3 py-2 text-left shadow-xs transition-[border-color,background-color,transform] duration-150 hover:-translate-y-px hover:border-primary/30 hover:bg-primary/[0.04] focus-visible:border-primary/40 focus-visible:ring-[3px] focus-visible:ring-primary/15 focus-visible:outline-none active:translate-y-0 disabled:opacity-50 motion-reduce:hover:translate-y-0 dark:bg-background/40 dark:hover:bg-primary/[0.08]"
                                >
                                  <span className="flex items-start gap-2">
                                    <span className="min-w-0 flex-1 truncate text-[13px] leading-snug text-ink">
                                      <BrandedQuestion question={s.question} company={s.company} />
                                    </span>
                                    <ArrowUp
                                      className="mt-0.5 size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                                      aria-hidden
                                    />
                                  </span>
                                  {/* The why, only on hover or focus — at rest the cards are just questions.
                                      Grid rows animate the height without measuring it. */}
                                  {s.basis && (
                                    <span className="grid grid-rows-[0fr] opacity-0 transition-[grid-template-rows,opacity] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:grid-rows-[1fr] group-hover:opacity-100 group-focus-visible:grid-rows-[1fr] group-focus-visible:opacity-100 motion-reduce:transition-none">
                                      <span className="block min-h-0 overflow-hidden">
                                        <span className="block pt-1 text-xs leading-relaxed text-muted-foreground">
                                          {s.basis}
                                        </span>
                                      </span>
                                    </span>
                                  )}
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                      </>
                    )}
                  </div>
                )}

                {messages.length === 0 && hits.length > 0 && (
                  <ul className="px-2 pb-2">
                    {hits.map((hit) => (
                      <li key={hit.id}>
                        <IntentLink
                          href={`/contacts/${hit.id}`}
                          className="block rounded-xl px-2 py-2 transition-colors hover:bg-primary/[0.06] dark:hover:bg-primary/[0.1]"
                          onClick={() => setOpen(false)}
                        >
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-ink">
                              {hit.preferredName || hit.fullName}
                              {(hit.title || hit.company) && (
                                <span className="font-normal text-muted-foreground">
                                  {" · "}
                                  {hit.title}
                                  {hit.title && hit.company && ", "}
                                  {hit.company && (
                                    <span style={{ color: companyBrandColor(hit.company) ?? undefined }}>
                                      {hit.company}
                                    </span>
                                  )}
                                </span>
                              )}
                            </p>
                            <p className="mt-0.5 truncate text-xs text-muted-foreground">
                              {hit.explanation}
                            </p>
                          </div>
                        </IntentLink>
                      </li>
                    ))}
                  </ul>
                )}

                {messages.length > 0 && (
                  <div className="space-y-3 px-4 pt-1 pb-4">
                    {messages.map((msg) =>
                      msg.role === "user" ? (
                        <UserBubble key={msg.id} msg={msg} />
                      ) : (
                        <AssistantBubble
                          key={msg.id}
                          msg={msg}
                          onNavigate={setOpen}
                        />
                      )
                    )}
                    {/* Only until the first step lands, which is now near-immediate — after
                        that ChatActivity names the stage actually running, rather than
                        claiming a search that may already be finished. */}
                    {awaitingFirstToken && (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <OrbitMark reduceMotion={reduceMotion} />
                        Looking through your network…
                      </div>
                    )}
                    <div ref={threadEndRef} />
                  </div>
                )}

                {messages.length === 0 && chatPending && (
                  <div className="flex items-center gap-2 px-4 pt-1 pb-4 text-sm text-muted-foreground">
                    <OrbitMark reduceMotion={reduceMotion} />
                    Looking through your network…
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {personContextActive && profileContact && (
            <motion.div
              key={`chip-${profileContact.id}`}
              initial={{ opacity: 0, y: 8, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6, scale: 0.98 }}
              transition={{ duration: DUR.base, ease: EASE_HOUSE }}
              className="flex items-center gap-2 self-center rounded-full border border-border/70 bg-card/95 py-1 pl-1 pr-1.5 shadow-md backdrop-blur-md"
            >
              <ContactAvatar
                contactId={profileContact.id}
                firstName={profileContact.firstName}
                fullName={profileContact.fullName}
                profileImageUrl={profileContact.profileImageUrl}
                size="sm"
                className="size-6"
              />
              <p className="truncate text-xs text-muted-foreground">
                Asking about{" "}
                <span className="font-medium text-foreground">
                  {profileContact.displayName}
                </span>
              </p>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="shrink-0 rounded-full text-muted-foreground"
                aria-label="Dismiss person context"
                onClick={() => setChipDismissed(true)}
              >
                <X className="size-3.5" />
              </Button>
            </motion.div>
          )}
        </AnimatePresence>

        <motion.div
          className={cn(
            "flex h-12 items-center gap-2 rounded-full border border-border/70 bg-card/95 pl-4 pr-1.5 shadow-lg backdrop-blur-md",
            "focus-within:border-primary/40 focus-within:ring-[3px] focus-within:ring-primary/15",
            personContextActive && "border-primary/25",
            open && "shadow-xl"
          )}
        >
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            id={inputId}
            ref={inputRef}
            type="text"
            value={query}
            placeholder={placeholder}
            disabled={chatPending}
            autoComplete="off"
            className={cn(
              // 16px on phones: iOS Safari zooms the page into any focused input with
              // smaller text, which panned the whole dashboard sideways and cut its
              // edges off the moment the bar opened. Same rule as ui/input.tsx.
              "h-full min-w-0 flex-1 bg-transparent text-base outline-none md:text-sm",
              "placeholder:text-muted-foreground disabled:opacity-60"
            )}
            onFocus={() => setOpen(true)}
            onChange={(e) => {
              const next = e.target.value;
              setQuery(next);
              runLiveSearch(next);
              if (next.trim()) setOpen(true);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowUp" && !e.shiftKey && !query.trim()) {
                if (fillMostRecentUserMessage()) {
                  e.preventDefault();
                }
                return;
              }
              if (e.key === "Enter") {
                e.preventDefault();
                sendQuestion(query);
              }
            }}
          />
          {!open && !query && (
            <kbd className="hidden h-5 shrink-0 items-center rounded-md border border-border/60 bg-background px-1.5 font-sans text-[11px] text-muted-foreground sm:inline-flex">
              ⌘J
            </kbd>
          )}
          {(query || open) && !chatPending && query && (
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              className="shrink-0 rounded-full text-muted-foreground"
              aria-label="Clear"
              onClick={() => {
                setQuery("");
                setHits([]);
                if (messages.length === 0) setOpen(false);
              }}
            >
              <X className="size-3.5" />
            </Button>
          )}
          <Button
            type="button"
            size="icon-sm"
            disabled={chatPending || (!query.trim() && !lastUserQuery)}
            className="size-9 shrink-0 rounded-full bg-primary text-primary-foreground hover:bg-primary/90"
            onClick={() => {
              if (!query.trim()) {
                fillMostRecentUserMessage();
                return;
              }
              sendQuestion(query);
            }}
            aria-label={query.trim() ? "Ask" : "Recall last message"}
          >
            {chatPending ? (
              <OrbitMark reduceMotion={reduceMotion} tone="current" />
            ) : (
              <ArrowUp className="size-3.5" />
            )}
          </Button>
        </motion.div>
      </motion.div>
    </motion.div>
  );
}

/** A suggested question with the company it names drawn in that company's brand color. */
function BrandedQuestion({ question, company }: { question: string; company?: string }) {
  const at = company ? question.lastIndexOf(company) : -1;
  if (!company || at < 0) return <>{question}</>;
  return (
    <>
      {question.slice(0, at)}
      <span className="font-medium" style={{ color: companyBrandColor(company) ?? undefined }}>
        {company}
      </span>
      {question.slice(at + company.length)}
    </>
  );
}

const UserBubble = memo(function UserBubble({ msg }: { msg: UserMessage }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-primary/[0.08] px-3 py-1.5 text-sm text-ink dark:bg-primary/[0.14]">
        {msg.content}
      </div>
    </div>
  );
});

const AssistantBubble = memo(function AssistantBubble({
  msg,
  onNavigate,
}: {
  msg: AssistantMessage;
  onNavigate: (open: boolean) => void;
}) {
  const steps = msg.steps ?? [];
  return (
    <div className="space-y-2">
      {steps.length > 0 && (
        <ChatActivity
          steps={steps}
          state={msg.streaming ? "live" : "final"}
          variant="compact"
        />
      )}
      {msg.answer && (
        <div className="text-sm leading-relaxed text-foreground/90">
          <ChatMarkdown>{msg.answer}</ChatMarkdown>
        </div>
      )}
      {msg.recommendations.map((r) => (
        <MiniRecommendation
          key={r.recruiter_id || r.contact_id || r.name}
          rec={r}
        />
      ))}
      {msg.retrieved.length > 0 &&
        msg.recommendations.length === 0 && (
          <div className="flex flex-wrap gap-1.5">
            {msg.retrieved.slice(0, 6).map((c) => (
              <IntentLink
                key={c.id}
                href={`/contacts/${c.id}`}
                className="rounded-full bg-muted/60 px-2.5 py-1 text-xs text-foreground/80 transition-colors hover:bg-primary/[0.08] hover:text-ink"
                onClick={() => onNavigate(false)}
              >
                {c.fullName}
              </IntentLink>
            ))}
          </div>
        )}
    </div>
  );
});

const MiniRecommendation = memo(function MiniRecommendation({
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
    <div className="rounded-2xl border border-border/60 bg-background/60 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <Link
            href={href}
            className="text-sm font-medium text-ink hover:underline"
          >
            {rec.name}
          </Link>
          {rec.recruiter_id && (
            <span className="text-xs text-muted-foreground"> · Recruiter</span>
          )}
          <p className="mt-0.5 text-xs text-muted-foreground">{rec.reason}</p>
          <p className="mt-1 text-xs">
            <span className="text-muted-foreground">Next: </span>
            {rec.suggested_action}
          </p>
        </div>
        {canRemind && (
          <Button
            size="xs"
            variant="outline"
            className="rounded-full"
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
                toast.success(TOAST_COPY.reminderSet);
              })
            }
          >
            Remind me
          </Button>
        )}
      </div>
      {rec.draft_message && (
        <div className="mt-2 rounded-xl bg-muted/50 p-2 text-xs text-muted-foreground whitespace-pre-wrap">
          {rec.draft_message}
        </div>
      )}
    </div>
  );
});
