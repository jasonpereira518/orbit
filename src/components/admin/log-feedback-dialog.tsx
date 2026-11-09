"use client";

import { MessageSquarePlus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { logFeedbackAction } from "@/actions/admin";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { friendlyError } from "@/lib/errors";
import {
  AREA_OPTIONS,
  FEEDBACK_SOURCES,
  MAX_FEEDBACK_TEXT,
  SOURCE_LABELS,
  type FeedbackSource,
} from "@/lib/feedback-report";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

/**
 * File what someone told you outside the app — a text, a call, a chat in person — under their
 * account. It joins the inbox like any report, gets triaged, and opens to a reply: answering it
 * in Orbit is how they learn the button exists.
 */
export function LogFeedbackDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [text, setText] = useState("");
  const [source, setSource] = useState<FeedbackSource>("text");
  const [area, setArea] = useState("");
  const [pending, start] = useTransition();

  const reset = () => {
    setEmail("");
    setText("");
    setSource("text");
    setArea("");
  };

  const submit = () => {
    if (pending || !email.trim() || !text.trim()) return;
    start(async () => {
      try {
        const { id } = await logFeedbackAction({ email, text, source, area: area || null });
        toast.success("Logged — reply to it to bring them into Orbit");
        setOpen(false);
        reset();
        router.push(`/admin/feedback/${id}`);
      } catch (err) {
        toast.error(friendlyError(err, "That didn’t save — try again?"));
      }
    });
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-lg border border-border/70 px-3 py-1.5 text-sm text-muted-foreground transition-colors duration-fast hover:text-primary"
      >
        <MessageSquarePlus className="size-3.5" aria-hidden />
        Log feedback
      </button>
      <Dialog open={open} onOpenChange={(next) => !pending && setOpen(next)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Log feedback</DialogTitle>
            <DialogDescription>
              Something someone told you outside the app. It goes under their account so you can
              reply to it in Orbit.
            </DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <label className="grid gap-1 text-sm">
              <span className="text-xs text-muted-foreground">Their email</span>
              <Input
                type="email"
                required
                autoComplete="off"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@example.com"
              />
            </label>
            <label className="grid gap-1 text-sm">
              <span className="text-xs text-muted-foreground">What they said</span>
              <Textarea
                required
                rows={4}
                maxLength={MAX_FEEDBACK_TEXT}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Paste the text, or write it down as they said it"
              />
            </label>
            <div className="grid gap-1">
              <span className="text-xs text-muted-foreground" id="log-feedback-source">
                Where it came from
              </span>
              <div className="flex flex-wrap gap-1.5" role="group" aria-labelledby="log-feedback-source">
                {FEEDBACK_SOURCES.map((value) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={source === value}
                    onClick={() => setSource(value)}
                    className={cn(
                      "rounded-full border px-2.5 py-1 text-xs transition-colors",
                      source === value
                        ? "border-primary bg-primary/10 text-foreground"
                        : "border-border/70 text-muted-foreground hover:text-foreground"
                    )}
                  >
                    {SOURCE_LABELS[value]}
                  </button>
                ))}
              </div>
            </div>
            <label className="grid gap-1 text-sm">
              <span className="text-xs text-muted-foreground">Part of Orbit (optional)</span>
              <select
                value={area}
                onChange={(e) => setArea(e.target.value)}
                className="h-9 rounded-lg border border-border/70 bg-transparent px-2 text-sm"
              >
                <option value="">Not sure</option>
                {AREA_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <DialogFooter>
              <Button type="button" variant="ghost" disabled={pending} onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending || !email.trim() || !text.trim()}>
                {pending ? "Logging…" : "Log it"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
