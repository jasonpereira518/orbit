"use client";

import { AlertTriangle, Clock } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { dismissFailedSendAction, retryFailedSendAction } from "@/actions/email-compose";
import { cancelEmailSendAction } from "@/actions/email-sends";
import { showUndoSendToast } from "@/components/email/undo-send-toast";
import { useHiddenSurfaces } from "@/components/layout/hidden-surfaces";
import { Button } from "@/components/ui/button";
import { openCompose } from "@/lib/compose-events";
import type { PendingSend } from "@/lib/email/compose";
import { formatScheduled } from "@/lib/email/schedule-presets";
import { friendlyError } from "@/lib/errors";
import { COMPOSE_SURFACE_KEY } from "@/lib/surfaces";
import { toast } from "@/lib/toast";

/**
 * Emails to this contact that are still on their way or didn't make it. Renders nothing when
 * there are none. Retry resends a definite failure; a send that may have gone out only offers
 * Dismiss, because the person has to check their Sent folder first.
 */
export function PendingSends({
  contactId,
  contactName,
  sends,
}: {
  contactId: string;
  contactName: string;
  sends: PendingSend[];
}) {
  const router = useRouter();
  const hidden = useHiddenSurfaces();
  const [pending, start] = useTransition();
  if (!sends.length) return null;
  const canEdit = !hidden.has(COMPOSE_SURFACE_KEY);

  const act = (fn: () => Promise<void>) =>
    start(async () => {
      try {
        await fn();
        router.refresh();
      } catch (err) {
        toast.error(friendlyError(err, "That didn’t work — try again?"));
      }
    });

  return (
    <section aria-label="Emails in progress" className="flex flex-col gap-2 rounded-2xl border border-border/70 p-3">
      {sends.map((s) => {
        const failed = s.status === "failed";
        const maybeSent = failed && s.failureKind === "ambiguous";
        const retryable = failed && !maybeSent && s.origin !== "agent" && s.origin !== "recruiter";
        const status = maybeSent
          ? "May have sent — check your Sent folder"
          : failed
            ? "Didn’t send"
            : s.status === "sending"
              ? "Sending now"
              : s.scheduledFor
                ? `Scheduled ${formatScheduled(new Date(s.scheduledFor), new Date())}`
                : "Waiting to send";
        const files = s.attachments.length ? ` · ${s.attachments.length} ${s.attachments.length === 1 ? "file" : "files"}` : "";
        const reopen = () => openCompose({ contactId, to: s.to, subject: s.subject, body: s.bodyText, attachments: s.attachments });
        return (
          <div key={s.id} className="flex flex-wrap items-center gap-2 text-sm">
            {failed ? (
              <AlertTriangle className="size-4 shrink-0 text-destructive" aria-hidden />
            ) : (
              <Clock className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{s.subject || "(no subject)"}</p>
              <p className="text-xs text-muted-foreground">
                {status}
                {files}
              </p>
            </div>
            <div className="flex items-center gap-1">
              {s.status === "queued" && s.scheduledFor && canEdit && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() =>
                    act(async () => {
                      // Take it off the schedule first: two copies must never be possible.
                      const { result } = await cancelEmailSendAction(s.id);
                      if (result === "canceled") reopen();
                      else toast.message("Already sent");
                    })
                  }
                >
                  Edit
                </Button>
              )}
              {s.status === "queued" && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() =>
                    act(async () => {
                      const { result } = await cancelEmailSendAction(s.id);
                      toast.message(result === "canceled" ? "Canceled — nothing went out" : "Already sent");
                    })
                  }
                >
                  Cancel
                </Button>
              )}
              {retryable && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() =>
                    act(async () => {
                      const res = await retryFailedSendAction(s.id);
                      if (!res.ok) {
                        toast.error(res.message);
                        return;
                      }
                      showUndoSendToast({ sendId: res.sendId, recipientLabel: contactName, onUndone: () => router.refresh() });
                    })
                  }
                >
                  Retry
                </Button>
              )}
              {retryable && canEdit && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() =>
                    act(async () => {
                      await dismissFailedSendAction(s.id);
                      reopen();
                    })
                  }
                >
                  Edit
                </Button>
              )}
              {failed && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() =>
                    act(async () => {
                      await dismissFailedSendAction(s.id);
                    })
                  }
                >
                  Dismiss
                </Button>
              )}
            </div>
          </div>
        );
      })}
    </section>
  );
}
