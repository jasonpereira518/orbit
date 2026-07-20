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
import { ArrowUp, Loader2, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { askNetwork } from "@/actions/chat";
import { createReminder } from "@/actions/reminders";
import { BulkNotesPanel } from "@/components/chat/bulk-notes-panel";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type ChatResult = Awaited<ReturnType<typeof askNetwork>>;
type MobileTab = "chat" | "notes";

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
};

type ThreadMessage = UserMessage | AssistantMessage;

const SUGGESTION_CHIPS = [
  "Who do I know at AWS?",
  "Who have I not followed up with recently?",
  "Who knows about AI agents?",
  "Who should I reconnect with this week?",
];

function newId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function ChatPanel() {
  const [mobileTab, setMobileTab] = useState<MobileTab>("chat");
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [pending, start] = useTransition();
  const threadEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, pending]);

  const sendQuestion = useCallback(
    (raw: string) => {
      const q = raw.trim();
      if (!q || pending) return;

      const userMsg: UserMessage = {
        id: newId(),
        role: "user",
        content: q,
      };
      setMessages((prev) => [...prev, userMsg]);
      setQuestion("");

      start(async () => {
        try {
          const res = await askNetwork(q);
          const assistantMsg: AssistantMessage = {
            id: newId(),
            role: "assistant",
            answer: res.answer,
            recommendations: res.recommendations,
          };
          setMessages((prev) => [...prev, assistantMsg]);
        } catch (err) {
          toast.error(err instanceof Error ? err.message : "Chat failed");
          setMessages((prev) => prev.filter((m) => m.id !== userMsg.id));
          setQuestion(q);
        }
      });
    },
    [pending]
  );

  function onComposerKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendQuestion(question);
    }
  }

  function clearThread() {
    setMessages([]);
    setQuestion("");
  }

  return (
    <div className="space-y-4">
      {/* Mobile: Chat | Notes tabs */}
      <div className="flex gap-1 rounded-lg bg-muted p-[3px] w-fit lg:hidden">
        {(
          [
            { id: "chat", label: "Chat" },
            { id: "notes", label: "Notes" },
          ] as const
        ).map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setMobileTab(tab.id)}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              mobileTab === tab.id
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)] lg:items-start lg:gap-0">
        {/* Chat column */}
        <div
          className={cn(
            "flex min-h-[min(70vh,640px)] flex-col overflow-hidden rounded-2xl border border-border/70 bg-card lg:min-h-[min(72vh,680px)] lg:rounded-r-none lg:border-r-0",
            mobileTab !== "chat" && "hidden lg:flex"
          )}
        >
          <div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
            <div>
              <p className="text-sm font-medium text-primary">Ask</p>
              <p className="text-xs text-muted-foreground">
                Questions about people in your network
              </p>
            </div>
            {messages.length > 0 && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={clearThread}
              >
                <RotateCcw className="mr-1 size-3.5" />
                New chat
              </Button>
            )}
          </div>

          <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
            {messages.length === 0 && !pending && (
              <div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-3 text-center">
                <p className="font-[family-name:var(--font-display)] text-xl text-primary">
                  Ask your network
                </p>
                <p className="max-w-sm text-sm text-muted-foreground">
                  Who can help, who to follow up with, or who knows what — try a
                  suggestion below.
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
                      {msg.answer}
                    </div>
                    {msg.recommendations.length > 0 && (
                      <div className="space-y-2">
                        {msg.recommendations.map((r) => (
                          <RecommendationCard key={r.contact_id} rec={r} />
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
            <div ref={threadEndRef} />
          </div>

          <div className="border-t border-border/60 bg-card p-3 sm:p-4">
            <div className="flex gap-2">
              <Textarea
                ref={textareaRef}
                rows={2}
                placeholder="Ask about your network…"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={onComposerKeyDown}
                className="min-h-[44px] flex-1 resize-none"
                disabled={pending}
              />
              <Button
                type="button"
                size="icon"
                disabled={pending || !question.trim()}
                className="h-11 w-11 shrink-0 bg-primary text-primary-foreground hover:bg-primary/90"
                onClick={() => sendQuestion(question)}
                aria-label="Send"
              >
                {pending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <ArrowUp className="size-4" />
                )}
              </Button>
            </div>
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {SUGGESTION_CHIPS.map((chip) => (
                <button
                  key={chip}
                  type="button"
                  disabled={pending}
                  className="rounded-full border border-border/70 px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                  onClick={() => sendQuestion(chip)}
                >
                  {chip}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Notes column */}
        <div
          className={cn(
            "min-h-[min(70vh,640px)] overflow-hidden rounded-2xl border border-border/70 bg-card lg:sticky lg:top-8 lg:min-h-[min(72vh,680px)] lg:rounded-l-none",
            mobileTab !== "notes" && "hidden lg:block"
          )}
        >
          <div className="flex h-full max-h-[min(72vh,680px)] flex-col">
            <div className="shrink-0 border-b border-border/60 px-4 py-3">
              <p className="text-sm font-medium text-primary">
                Update from notes
              </p>
              <p className="text-xs text-muted-foreground">
                Paste notes to create or update many contacts
              </p>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              <BulkNotesPanel compact />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function RecommendationCard({
  rec,
}: {
  rec: ChatResult["recommendations"][number];
}) {
  const [pending, start] = useTransition();

  return (
    <div className="rounded-xl border border-border/70 bg-background p-3.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <Link
            href={`/contacts/${rec.contact_id}`}
            className="text-sm font-medium text-primary hover:underline"
          >
            {rec.name}
          </Link>
          <p className="mt-0.5 text-xs text-muted-foreground">{rec.reason}</p>
          <p className="mt-1.5 text-xs">
            <span className="font-medium">Next: </span>
            {rec.suggested_action}
          </p>
        </div>
        <Button
          size="xs"
          variant="outline"
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
