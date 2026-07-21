"use client";

import Link from "next/link";
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
import { ArrowUp, Loader2, RotateCcw, Search, Sparkles, X } from "lucide-react";
import { toast } from "@/lib/toast";
import { toUserFacingError } from "@/lib/errors";
import { askNetwork } from "@/actions/chat";
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
};

type ThreadMessage = UserMessage | AssistantMessage;

const CONTACT_PATH_RE =
  /^\/contacts\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

const SUGGESTIONS = [
  "Who do I know at AWS?",
  "Who have I not followed up with recently?",
  "Who knows about AI agents?",
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
  const pathname = usePathname();
  const pathContactId = contactIdFromPath(pathname);

  const inputId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<number | null>(null);
  const threadEndRef = useRef<HTMLDivElement>(null);
  const lastScrollY = useRef(0);

  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<KeywordSearchHit[]>([]);
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [searchPending, startSearch] = useTransition();
  const [chatPending, startChat] = useTransition();

  const [profileContact, setProfileContact] = useState<AskBarContact | null>(
    null
  );
  const [chipDismissed, setChipDismissed] = useState(false);

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

  const pinnedOpen = open || chatPending || messages.length > 0;

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
    function findScrollParent(el: HTMLElement | null): HTMLElement | Window {
      let node = el?.parentElement ?? null;
      while (node) {
        const { overflowY } = getComputedStyle(node);
        if (
          (overflowY === "auto" || overflowY === "scroll") &&
          node.scrollHeight > node.clientHeight
        ) {
          return node;
        }
        node = node.parentElement;
      }
      return window;
    }

    const target = findScrollParent(wrapRef.current);
    const getY = () =>
      target instanceof Window ? window.scrollY : target.scrollTop;

    lastScrollY.current = getY();

    function onScroll() {
      const y = getY();
      const delta = y - lastScrollY.current;
      lastScrollY.current = y;

      if (Math.abs(delta) < 6) return;

      // Keep visible while interacting or near the top
      if (pinnedOpen || y < 24) {
        setHidden(false);
        return;
      }

      if (delta > 0) setHidden(true);
      else setHidden(false);
    }

    target.addEventListener("scroll", onScroll, { passive: true });
    return () => target.removeEventListener("scroll", onScroll);
  }, [pinnedOpen]);

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

  const sendQuestion = useCallback(
    (raw: string) => {
      const q = raw.trim();
      if (!q || chatPending) return;

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
      startChat(async () => {
        try {
          const res = await askNetwork(
            q,
            contactId ? { contactId } : undefined
          );
          if (!res.ok) {
            toast.error(res.error);
            setMessages((prev) => prev.filter((m) => m.id !== userMsg.id));
            setQuery(q);
            return;
          }
          const assistantMsg: AssistantMessage = {
            id: newId(),
            role: "assistant",
            answer: res.answer,
            recommendations: res.recommendations,
            retrieved: res.retrieved,
          };
          setMessages((prev) => [...prev, assistantMsg]);
        } catch (err) {
          toast.error(
            toUserFacingError(
              err,
              "Could not answer that. Add your AI API key in Settings."
            ).message
          );
          setMessages((prev) => prev.filter((m) => m.id !== userMsg.id));
          setQuery(q);
        }
      });
    },
    [activeContactId, chatPending]
  );

  function clearThread() {
    setMessages([]);
    setQuery("");
    setHits([]);
  }

  const showPanel = open;
  const visible = !hidden || pinnedOpen;
  const suggestionChips =
    personContextActive && open ? PROFILE_SUGGESTIONS : SUGGESTIONS;
  const placeholder =
    personContextActive && open && activeContactName
      ? `Ask about ${activeContactName}…`
      : "Ask your network…";

  return (
    <motion.div
      ref={wrapRef}
      initial={false}
      animate={
        visible
          ? { y: 0, opacity: 1 }
          : { y: 72, opacity: 0 }
      }
      transition={{
        duration: 0.55,
        ease: [0.32, 0.72, 0, 1],
        opacity: { duration: 0.45, ease: [0.4, 0, 0.2, 1] },
      }}
      className={cn(
        "pointer-events-none fixed inset-x-0 z-50 flex justify-center px-4",
        "bottom-[calc(4.5rem+env(safe-area-inset-bottom))] md:bottom-5",
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
              transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
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
                              <p className="text-sm font-medium text-primary">
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
                            {msg.answer}
                          </div>
                          {msg.recommendations.map((r) => (
                            <MiniRecommendation key={r.contact_id} rec={r} />
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
                    {chatPending && (
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
              transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
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
            disabled={chatPending || !query.trim()}
            className="size-9 shrink-0 rounded-full bg-primary text-primary-foreground hover:bg-primary/90"
            onClick={() => sendQuestion(query)}
            aria-label="Ask"
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

  return (
    <div className="rounded-2xl border border-border/70 bg-background/80 p-2.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <Link
            href={`/contacts/${rec.contact_id}`}
            className="text-sm font-medium text-primary hover:underline"
          >
            {rec.name}
          </Link>
          <p className="mt-0.5 text-xs text-muted-foreground">{rec.reason}</p>
          <p className="mt-1 text-xs">
            <span className="font-medium">Next: </span>
            {rec.suggested_action}
          </p>
        </div>
        <Button
          size="xs"
          variant="outline"
          className="rounded-full"
          disabled={pending}
          onClick={() =>
            start(async () => {
              await createReminder({
                contactId: rec.contact_id,
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
      </div>
      {rec.draft_message && (
        <div className="mt-2 rounded-xl bg-muted/50 p-2 text-xs text-muted-foreground whitespace-pre-wrap">
          {rec.draft_message}
        </div>
      )}
    </div>
  );
}
