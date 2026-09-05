"use client";

import { useState } from "react";
import {
  deleteFeedbackScreenshotAction,
  setFeedbackStatusAction,
} from "@/actions/admin";
import { ConfirmActionDialog } from "@/components/admin/confirm-action-dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

/**
 * Triage controls for one feedback entry.
 *
 * Every write goes through `ConfirmActionDialog`, which is the single funnel for operator
 * actions in this console — it collects the mandatory reason and surfaces the server's own
 * error message, which is why the actions throw rather than return a failure shape.
 */
export function FeedbackStatusActions({
  id,
  status,
}: {
  id: string;
  status: "new" | "triaged" | "resolved";
}) {
  const [resolutionNote, setResolutionNote] = useState("");

  return (
    <div className="flex flex-wrap items-start gap-2">
      {status !== "triaged" && (
        <ConfirmActionDialog
          trigger={
            <Button type="button" variant="outline" size="sm">
              Mark triaged
            </Button>
          }
          title="Mark this triaged"
          description="You have read it and know what it is, but it isn't dealt with yet."
          confirmLabel="Mark triaged"
          onConfirm={(reason) => setFeedbackStatusAction({ id, status: "triaged", reason })}
        />
      )}

      {status !== "resolved" && (
        <ConfirmActionDialog
          trigger={
            <Button type="button" size="sm">
              Resolve
            </Button>
          }
          title="Resolve this feedback"
          description={
            <div className="grid gap-2">
              <p>What was done about it? Recorded on the entry and in the audit log.</p>
              <Textarea
                rows={3}
                value={resolutionNote}
                placeholder="Fixed in #123 / not doing this because…"
                onChange={(e) => setResolutionNote(e.target.value)}
              />
            </div>
          }
          confirmLabel="Resolve"
          onConfirm={(reason) =>
            setFeedbackStatusAction({ id, status: "resolved", reason, resolutionNote })
          }
        />
      )}

      {status !== "new" && (
        <ConfirmActionDialog
          trigger={
            <Button type="button" variant="ghost" size="sm">
              Reopen
            </Button>
          }
          title="Reopen this feedback"
          description="Puts it back in the unresolved count. The resolution note is kept."
          confirmLabel="Reopen"
          onConfirm={(reason) => setFeedbackStatusAction({ id, status: "new", reason })}
        />
      )}
    </div>
  );
}

/**
 * Delete one screenshot for good.
 *
 * Typed confirmation because it is irreversible and because the reason to reach for it is
 * usually "this should never have been captured" — which is exactly when deleting the wrong
 * one matters.
 */
export function DeleteFeedbackScreenshotButton({ id }: { id: string }) {
  return (
    <ConfirmActionDialog
      trigger={
        <Button type="button" variant="ghost" size="xs" className="text-muted-foreground">
          Delete
        </Button>
      }
      title="Delete this screenshot"
      description="Removes the row and the stored image. This cannot be undone."
      confirmLabel="Delete screenshot"
      danger
      typedConfirmation="delete"
      onConfirm={(reason) => deleteFeedbackScreenshotAction({ id, reason })}
    />
  );
}
