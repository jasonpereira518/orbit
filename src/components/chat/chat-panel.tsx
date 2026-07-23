"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
  type KeyboardEvent,
} from "react";
import Link from "next/link";
import {
  ArrowUp,
  History,
  Loader2,
  NotebookPen,
  Plus,
  Trash2,
} from "lucide-react";
import { toast } from "@/lib/toast";
import { toUserFacingError } from "@/lib/errors";
import {
  askNetwork,
  createChatThread,
  deleteChatThread,
  getChatThread,
  listChatThreads,
} from "@/actions/chat";
import { createReminder } from "@/actions/reminders";
import { BulkNotesPanel } from "@/components/chat/bulk-notes-panel";
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
  const listRef = useRef<HTMLDivElement>(null);
  const threadEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const stickToBottomRef = useRef(true);

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
  }, [messages, pending, isNearBottom, scrollToBottom]);

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
      setQuestion("");
      requestAnimationFrame(() => scrollToBottom(false));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load chat");
    } finally {
      setLoadingThread(false);
    }
  }, [scrollToBottom]);

  const startNewChat = useCallback(() => {
    start(async () => {
      try {
        const created = await createChatThread();
        setThreadId(created.id);
        setThreadTitle(created.title);
        setMessages([]);
        setQuestion("");
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
  }, []);

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
            setQuestion("");
          }
          toast.success("Chat deleted");
        } catch (err) {
          toast.error(err instanceof Error ? err.message : "Delete failed");
        }
      });
    },
    [threadId]
  );

  const sendQuestion = useCallback(
    (raw: string) => {
      const q = raw.trim();
      if (!q || pending || loadingThread) return;

      setLastUserQuery(q);
      const userMsg: UserMessage = {
        id: newId(),
        role: "user",
        content: q,
      };
      stickToBottomRef.current = true;
      setMessages((prev) => [...prev, userMsg]);
      setQuestion("");
      requestAnimationFrame(() => scrollToBottom(true));

      start(async () => {
        try {
          const activeId = await ensureThread();
          const res = await askNetwork(q, { threadId: activeId });
          if (!res.ok) {
            toast.error(res.error);
            setMessages((prev) => prev.filter((m) => m.id !== userMsg.id));
            setQuestion(q);
            return;
          }
          const assistantMsg: AssistantMessage = {
            id: res.messageId || newId(),
            role: "assistant",
            answer: res.answer,
            recommendations: res.recommendations,
          };
          setMessages((prev) => [...prev, assistantMsg]);
          if (res.title) setThreadTitle(res.title);
          setThreads((prev) => {
            const next = prev.filter((t) => t.id !== activeId);
            return [
              {
                id: activeId,
                title: res.title ?? null,
                createdAt: new Date(),
                updatedAt: new Date(),
              },
              ...next,
            ];
          });
        } catch (err) {
          toast.error(
            toUserFacingError(
              err,
              "Could not answer that. Add your AI API key in Settings."
            ).message
          );
          setMessages((prev) => prev.filter((m) => m.id !== userMsg.id));
          setQuestion(q);
        }
      });
    },
    [pending, loadingThread, ensureThread, scrollToBottom]
  );

  function fillMostRecentUserMessage() {
    const fromThread = [...messages]
      .reverse()
      .find((m): m is UserMessage => m.role === "user");
    const content = fromThread?.content || lastUserQuery;
    if (!content) return false;
    setQuestion(content);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      const len = content.length;
      el.focus();
      el.setSelectionRange(len, len);
    });
    return true;
  }

  function onComposerKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
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
      <div className="flex h-[calc(100dvh-16.5rem)] w-full max-h-[calc(100dvh-16.5rem)] flex-col overflow-hidden rounded-2xl border border-border/70 bg-card md:h-[calc(100dvh-11rem)] md:max-h-[calc(100dvh-11rem)]">
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
            <p className="truncate text-sm font-medium text-primary">
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
            disabled={pending}
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
            <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-2">
              {loadingThread ? (
                <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  Loading chat…
                </div>
              ) : (
                <>
                  {messages.length === 0 && !pending && (
                    <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
                      <p className="font-[family-name:var(--font-display)] text-xl text-primary sm:text-2xl">
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

                  {pending && (
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
                <Textarea
                  ref={textareaRef}
                  rows={2}
                  placeholder="Ask about your network…"
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  onKeyDown={onComposerKeyDown}
                  className="min-h-[44px] flex-1 resize-none"
                  disabled={pending || loadingThread}
                />
                <Button
                  type="button"
                  size="icon"
                  disabled={
                    pending ||
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
                  {pending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <ArrowUp className="size-4" />
                  )}
                </Button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {SUGGESTION_CHIPS.map((chip) => (
                  <button
                    key={chip}
                    type="button"
                    disabled={pending || loadingThread}
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
            <BulkNotesPanel compact />
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
