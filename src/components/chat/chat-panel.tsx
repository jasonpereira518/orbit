"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { askNetwork } from "@/actions/chat";
import { createReminder } from "@/actions/reminders";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";

type ChatResult = Awaited<ReturnType<typeof askNetwork>>;

export function ChatPanel() {
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<ChatResult | null>(null);
  const [pending, start] = useTransition();

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-border/70 bg-white p-6 space-y-4">
        <Textarea
          rows={3}
          placeholder="Who should I reach out to about software engineering internships?"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
        />
        <div className="flex flex-wrap gap-2">
          {[
            "Who do I know at AWS?",
            "Who have I not followed up with recently?",
            "Who knows about AI agents?",
          ].map((q) => (
            <button
              key={q}
              type="button"
              className="rounded-full border border-border/70 px-3 py-1 text-xs text-muted-foreground hover:bg-muted"
              onClick={() => setQuestion(q)}
            >
              {q}
            </button>
          ))}
        </div>
        <Button
          disabled={pending || !question.trim()}
          className="bg-[#0f3d3e] hover:bg-[#0c3233]"
          onClick={() =>
            start(async () => {
              try {
                const res = await askNetwork(question);
                setResult(res);
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "Chat failed");
              }
            })
          }
        >
          {pending ? "Searching…" : "Ask your network"}
        </Button>
      </div>

      {result && (
        <div className="space-y-4">
          <div className="rounded-2xl border border-border/70 bg-white p-6">
            <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-muted-foreground">
              Answer
            </h2>
            <p className="leading-relaxed text-[#0f3d3e]">{result.answer}</p>
          </div>

          <div className="space-y-3">
            {result.recommendations.map((r) => (
              <div
                key={r.contact_id}
                className="rounded-2xl border border-border/70 bg-white p-5"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <Link
                      href={`/contacts/${r.contact_id}`}
                      className="font-medium text-[#0f3d3e] hover:underline"
                    >
                      {r.name}
                    </Link>
                    <p className="mt-1 text-sm text-muted-foreground">{r.reason}</p>
                    <p className="mt-2 text-sm">
                      <span className="font-medium">Next: </span>
                      {r.suggested_action}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      start(async () => {
                        await createReminder({
                          contactId: r.contact_id,
                          title: `Reach out to ${r.name}`,
                          description: r.suggested_action,
                          dueDate: new Date(
                            Date.now() + 3 * 24 * 60 * 60 * 1000
                          ).toISOString(),
                        });
                        toast.success("Reminder created");
                      })
                    }
                  >
                    Create reminder
                  </Button>
                </div>
                {r.draft_message && (
                  <div className="mt-4 rounded-xl bg-muted/50 p-3 text-sm">
                    <Badge variant="secondary" className="mb-2">
                      Draft
                    </Badge>
                    <p className="whitespace-pre-wrap">{r.draft_message}</p>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
