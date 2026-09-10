"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useTransition,
} from "react";
import { AnimatePresence, motion } from "motion/react";
import { DUR, EASE_HOUSE } from "@/lib/motion";
import { ArrowUp, Loader2, RotateCcw, Search, Sparkles, X } from "lucide-react";
import { toast } from "@/lib/toast";
import { MISSING_AI_API_KEY_MESSAGE, toUserFacingError } from "@/lib/errors";
import { OPEN_ASK_BAR_EVENT } from "@/lib/ask-bar-events";
import { useFeedbackPanelState } from "@/lib/feedback-events";
import { askNetwork, createChatThread } from "@/actions/chat";
import { streamChat } from "@/lib/chat-stream-client";
import { getAskBarContact } from "@/actions/contacts";
import { searchDashboardContacts } from "@/actions/search";
import { createReminder } from "@/actions/reminders";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  MATCHED_FIELD_LABELS,
  type KeywordSearchHit,
} from "@/lib/keyword-search";
import { cn } from "@/lib/utils";

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
};

type ThreadMessage = UserMessage | AssistantMessage;

const CONTACT_PATH_RE =
  /^\/contacts\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

const SUGGESTIONS = [
  "Who do I know at AWS?",
  "Who have I not followed up with recently?",
  "Who are the best recruiters for my search?",
  "Who should I reconnect with this week?",
];

const PROFILE_SUGGESTIONS = [
  "What should I know before we talk?",
  "Summarize our relationship",
  "What have we talked about recently?",
  "Suggest a warm follow-up angle",
];

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
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
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

  useEffect(() => {
    function onOpenRequest() {
      focusBar();
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
    (raw: string) => {
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
          toast.error(toUserFacingError(err, MISSING_AI_API_KEY_MESSAGE).message);
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

        await streamChat(
          { question: q, threadId, contactId: contactId ?? undefined },
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
              patch((m) => ({ ...m, retrieved: info.retrieved, streaming: false }));
            },
            onError: (message) => {
              toast.error(message);
              setMessages((prev) => prev.filter((m) => m.id !== userMsg.id && m.id !== assistantId));
              setQuery(q);
            },
          }
        );
        setChatPending(false);
      })();
    },
    [activeContactId, chatPending, ensureChatThread]
  );

  function clearThread() {
    setMessages([]);
    setQuery("");
    setHits([]);
    chatThreadIdRef.current = null;
  }

  const showPanel = open;
  const visible = !hidden || stayVisibleWhileWaiting;
  const suggestionChips =
    personContextActive && open ? PROFILE_SUGGESTIONS : SUGGESTIONS;
  const placeholder =
    personContextActive && open && activeContactName
      ? `Ask about ${activeContactName}…`
      : "Ask your network…";

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
        "bottom-[calc(7.5rem+env(safe-area-inset-bottom))] md:bottom-5",
        !visible && "pointer-events-none"
      )}
      aria-hidden={!visible}
    >
      <div
        className={cn(
          "flex w-full max-w-md flex-col gap-2",
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
              className="overflow-hidden rounded-[1.75rem] border border-border/70 bg-card/95 shadow-xl backdrop-blur-md"
            >
              <div className="flex items-center justify-between border-b border-border/60 px-3.5 py-2">
                <div className="flex items-center gap-1.5">
                  <Sparkles className="size-3 text-primary" />
                  <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    {messages.length > 0
                      ? personContextActive && activeContactName
                        ? `Ask about ${activeContactName}`
                        : "Ask your network"
                      : searchPending
                        ? "Searching…"
                        : hits.length > 0
                          ? `${hits.length} match${hits.length === 1 ? "" : "es"}`
                          : "Semantic search"}
                  </p>
                </div>
                <div className="flex items-center gap-0.5">
                  {messages.length > 0 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-[11px] text-muted-foreground"
                      onClick={clearThread}
                    >
                      <RotateCcw className="mr-1 size-3" />
                      New
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="text-muted-foreground"
                    aria-label="Close"
                    onClick={() => setOpen(false)}
                  >
                    <X className="size-3.5" />
                  </Button>
                </div>
              </div>

              <div className="max-h-[min(48vh,24rem)] overflow-y-auto">
                {messages.length === 0 && !chatPending && hits.length === 0 && (
                  <div className="space-y-2.5 px-3.5 py-3">
                    {query.trim() ? (
                      <p className="text-sm text-muted-foreground">
                        {searchPending
                          ? "Searching…"
                          : `No people matched “${query.trim()}”. Press Enter to ask your network.`}
                      </p>
                    ) : (
                      <>
                        <p className="text-sm text-muted-foreground">
                          {personContextActive && activeContactName
                            ? `Ask anything about ${activeContactName}—relationship history, talking points, or follow-ups.`
                            : "Ask anything about people, companies, or follow-ups in your network."}
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {suggestionChips.map((chip) => (
                            <button
                              key={chip}
                              type="button"
                              disabled={chatPending}
                              className="rounded-full border border-border/70 px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                              onClick={() => sendQuestion(chip)}
                            >
                              {chip}
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                )}

                {messages.length === 0 && hits.length > 0 && (
                  <ul className="p-1.5">
                    {hits.map((hit) => (
                      <li key={hit.id}>
                        <Link
                          href={`/contacts/${hit.id}`}
                          className="block rounded-2xl px-3 py-2 transition-colors hover:bg-muted/60"
                          onClick={() => setOpen(false)}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="text-sm font-medium text-ink">
                                {hit.preferredName || hit.fullName}
                              </p>
                              <p className="truncate text-xs text-muted-foreground">
                                {[hit.title, hit.company]
                                  .filter(Boolean)
                                  .join(" · ") || "No role yet"}
                              </p>
                            </div>
                            <div className="flex shrink-0 items-center gap-1.5">
                              {(hit.source === "semantic" ||
                                hit.source === "hybrid") && (
                                <Badge
                                  variant="secondary"
                                  className="text-[10px]"
                                >
                                  {hit.source === "hybrid" ? "AI+text" : "AI"}
                                </Badge>
                              )}
                            </div>
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {hit.explanation}
                          </p>
                          {hit.matchedFields.length > 0 && (
                            <div className="mt-1.5 flex flex-wrap gap-1">
                              {hit.matchedFields.slice(0, 3).map((field) => (
                                <Badge
                                  key={field}
                                  variant="secondary"
                                  className="text-[10px] capitalize"
                                >
                                  {MATCHED_FIELD_LABELS[field]}
                                </Badge>
                              ))}
                            </div>
                          )}
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}

                {messages.length > 0 && (
                  <div className="space-y-2.5 px-2.5 py-2.5">
                    {messages.map((msg) =>
                      msg.role === "user" ? (
                        <div key={msg.id} className="flex justify-end">
                          <div className="max-w-[90%] rounded-2xl rounded-br-md bg-primary px-3 py-1.5 text-sm text-primary-foreground">
                            {msg.content}
                          </div>
                        </div>
                      ) : (
                        <div key={msg.id} className="space-y-2">
                          <div className="rounded-2xl rounded-bl-md border border-border/70 bg-muted/40 px-3 py-2 text-sm leading-relaxed">
                            <ChatMarkdown>{msg.answer}</ChatMarkdown>
                          </div>
                          {msg.recommendations.map((r) => (
                            <MiniRecommendation
                              key={r.recruiter_id || r.contact_id || r.name}
                              rec={r}
                            />
                          ))}
                          {msg.retrieved.length > 0 &&
                            msg.recommendations.length === 0 && (
                              <div className="flex flex-wrap gap-1.5 px-1">
                                {msg.retrieved.slice(0, 6).map((c) => (
                                  <Link
                                    key={c.id}
                                    href={`/contacts/${c.id}`}
                                    className="rounded-full border border-border/70 px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                                    onClick={() => setOpen(false)}
                                  >
                                    {c.fullName}
                                  </Link>
                                ))}
                              </div>
                            )}
                        </div>
                      )
                    )}
                    {awaitingFirstToken && (
                      <div className="flex items-center gap-2 rounded-2xl rounded-bl-md border border-border/70 bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
                        <Loader2 className="size-3.5 animate-spin" />
                        Searching your network…
                      </div>
                    )}
                    <div ref={threadEndRef} />
                  </div>
                )}

                {messages.length === 0 && chatPending && (
                  <div className="flex items-center gap-2 px-3.5 py-4 text-sm text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" />
                    Searching your network…
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
                linkedinUrl={profileContact.linkedinUrl}
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
          layout
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
              "h-full min-w-0 flex-1 bg-transparent text-sm outline-none",
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
            <kbd className="hidden shrink-0 rounded-full border border-border/70 bg-muted/50 px-2 py-0.5 text-[10px] text-muted-foreground sm:inline">
              ⌘K
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
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <ArrowUp className="size-3.5" />
            )}
          </Button>
        </motion.div>
      </div>
    </motion.div>
  );
}

function MiniRecommendation({
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
    <div className="rounded-2xl border border-border/70 bg-background/80 p-2.5">
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
          <p className="mt-1 text-xs">
            <span className="font-medium">Next: </span>
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
                toast.success("Reminder created");
              })
            }
          >
            Reminder
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
}
