"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  BellOff,
  BellRing,
  ChevronDown,
  ChevronUp,
  Clock,
  Copy,
  MessageCircleX,
  MoreHorizontal,
  Sparkles,
} from "lucide-react";
import { toast } from "@/lib/toast";
import {
  acceptSuggestionAction,
  dismissSuggestionAction,
  draftForSuggestionAction,
  markSentAction,
  muteSuggestionContactAction,
  snoozeSuggestionAction,
  type TodaySuggestion,
} from "@/actions/follow-ups";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

const KIND_LABELS: Record<string, string> = {
  commitment_due: "Commitment due",
  scheduled_follow_up: "Scheduled follow-up",
  open_loop: "Open loop",
  dormant: "Gone quiet",
  thread_quiet: "Thread quiet",
  post_event: "Post-event",
  never_contacted: "Never contacted",
  met_anniversary: "Met anniversary",
  work_anniversary: "Work anniversary",
  birthday: "Birthday",
  personal_date: "Personal date",
  job_change: "Job change",
  job_opening: "Job opening",
};

const SNOOZE_OPTIONS = [
  { label: "3 days", days: 3 },
  { label: "1 week", days: 7 },
  { label: "1 month", days: 30 },
] as const;

const DISMISS_OPTIONS = [
  { label: "Not now", reason: "not_now" },
  { label: "Wrong reason", reason: "wrong_reason" },
  { label: "Stop suggesting this kind", reason: "stop_this_kind" },
] as const;

export function SuggestionCard({ suggestion }: { suggestion: TodaySuggestion }) {
  const router = useRouter();
  const [resolved, setResolved] = useState(false);
  const [pending, setPending] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [draftPending, setDraftPending] = useState(false);
  const [showSignals, setShowSignals] = useState(false);

  if (resolved) return null;

  async function run(label: string, fn: () => Promise<unknown>) {
    setPending(true);
    try {
      await fn();
      toast.success(label);
      setResolved(true);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setPending(false);
    }
  }

  async function generateDraft() {
    setDraftPending(true);
    try {
      const result = await draftForSuggestionAction(suggestion.id);
      setDraft(result.body);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not draft follow-up");
    } finally {
      setDraftPending(false);
    }
  }

  const secondary = [suggestion.title, suggestion.company].filter(Boolean).join(" · ");
  const actionClass = cn(buttonVariants({ variant: "outline", size: "sm" }), "h-8");

  return (
    <div className="rounded-xl border border-border/60 bg-card p-4">
      <div className="flex items-start gap-3">
        <ContactAvatar
          contactId={suggestion.contactId}
          fullName={suggestion.contactName}
          profileImageUrl={suggestion.avatarUrl}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-medium">{suggestion.contactName}</p>
            <span className="rounded-full bg-muted/80 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {KIND_LABELS[suggestion.primaryKind] ?? suggestion.primaryKind}
            </span>
          </div>
          {secondary && (
            <p className="mt-0.5 text-xs text-muted-foreground">{secondary}</p>
          )}

          <p className="mt-2 text-sm text-foreground">{suggestion.reason}</p>
          {suggestion.hook && (
            <p className="mt-1 text-sm italic text-muted-foreground">
              &ldquo;{suggestion.hook}&rdquo;
            </p>
          )}

          {suggestion.signals.length > 0 && (
            <div className="mt-1">
              <button
                type="button"
                onClick={() => setShowSignals((v) => !v)}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                {showSignals ? (
                  <ChevronUp className="size-3" />
                ) : (
                  <ChevronDown className="size-3" />
                )}
                why this surfaced
              </button>
              {showSignals && (
                <ul className="mt-1 space-y-1 rounded-lg bg-muted/50 p-2 text-xs text-muted-foreground">
                  {suggestion.signals.map((s, i) => (
                    <li key={`${s.kind}-${i}`}>
                      <span className="font-medium text-foreground">
                        {KIND_LABELS[s.kind] ?? s.kind}:
                      </span>{" "}
                      {s.evidence}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="mt-3 flex flex-wrap gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="default"
              className="h-8"
              disabled={draftPending || pending}
              onClick={generateDraft}
            >
              <Sparkles className="mr-1.5 h-3.5 w-3.5" />
              {draftPending ? "Drafting…" : draft ? "Regenerate draft" : "Draft"}
            </Button>

            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8"
              disabled={pending}
              onClick={() =>
                run("Reminder added", () => acceptSuggestionAction(suggestion.id))
              }
            >
              <BellRing className="mr-1.5 h-3.5 w-3.5" />
              Remind me
            </Button>

            <DropdownMenu>
              <DropdownMenuTrigger
                type="button"
                disabled={pending}
                className={actionClass}
              >
                <Clock className="mr-1.5 h-3.5 w-3.5" />
                Snooze
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {SNOOZE_OPTIONS.map((opt) => (
                  <DropdownMenuItem
                    key={opt.days}
                    onClick={() =>
                      run(`Snoozed ${opt.label}`, () =>
                        snoozeSuggestionAction(suggestion.id, opt.days)
                      )
                    }
                  >
                    {opt.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            <DropdownMenu>
              <DropdownMenuTrigger
                type="button"
                disabled={pending}
                className={actionClass}
              >
                <MessageCircleX className="mr-1.5 h-3.5 w-3.5" />
                Dismiss
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {DISMISS_OPTIONS.map((opt) => (
                  <DropdownMenuItem
                    key={opt.reason}
                    onClick={() =>
                      run("Dismissed", () =>
                        dismissSuggestionAction(suggestion.id, opt.reason)
                      )
                    }
                  >
                    {opt.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            <DropdownMenu>
              <DropdownMenuTrigger
                type="button"
                disabled={pending}
                aria-label="More actions"
                className={cn(
                  buttonVariants({ variant: "ghost", size: "icon-sm" }),
                  "h-8 w-8"
                )}
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onClick={() =>
                    run("Contact muted", () =>
                      muteSuggestionContactAction(suggestion.id)
                    )
                  }
                >
                  <BellOff className="mr-2 h-3.5 w-3.5" />
                  Mute this contact
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() =>
                    run("Marked as sent", () => markSentAction(suggestion.id))
                  }
                >
                  I already messaged them
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {draft && (
            <div className="mt-3 rounded-lg bg-muted/50 p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Draft follow-up
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  onClick={() => {
                    void navigator.clipboard.writeText(draft);
                    toast.success("Copied to clipboard");
                  }}
                >
                  <Copy className="mr-1 h-3 w-3" />
                  Copy
                </Button>
              </div>
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                {draft}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
