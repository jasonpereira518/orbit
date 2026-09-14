"use client";
import * as actions from "@/actions/outreach-v2";
import { Button } from "@/components/ui/button";
import { displayDate as date, statusLabel } from "./outreach-ui";
import type { Workspace, Draft, Act } from "./outreach-workspace-types";
export function OutreachActivity({
  data,
  messages,
  pending,
  act,
  issuesOnly,
  onIssuesOnly,
}: {
  data: Workspace;
  messages: Draft[];
  pending: boolean;
  act: Act;
  issuesOnly: boolean;
  onIssuesOnly: (value: boolean) => void;
}) {
  const id = data.campaign.id;
  return (
    <div className="space-y-5">
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={issuesOnly}
          onChange={(e) => onIssuesOnly(e.target.checked)}
        />
        Show issues only
      </label>
      <p className="text-sm text-muted-foreground" role="status">
        {data.jobs.filter((j) => j.status === "completed").length} of{" "}
        {data.jobs.length} jobs completed ·{" "}
        {
          data.jobs.filter(
            (j) => j.status === "queued" || j.status === "running",
          ).length
        }{" "}
        pending ·{" "}
        {
          data.jobs.filter(
            (j) => j.status === "failed" || j.status === "needs_verification",
          ).length
        }{" "}
        need attention
      </p>
      {["linkedin", "gmail_web", "outlook_web"].includes(
        data.campaign.sender?.transport ?? "",
      ) && (
        <div className="rounded-lg bg-muted p-4">
          <h2 className="font-medium">Run this campaign in Chrome</h2>
          <p className="mt-2 text-sm">
            Open the Orbit extension → Outreach session → choose{" "}
            {data.campaign.name}. Keep the panel open while sending or checking
            replies.
          </p>
          {data.campaign.defaultChannel === "linkedin" && (
            <p className="mt-2 text-sm">
              LinkedIn prohibits third-party automation and may restrict
              accounts that use it. The extension asks you to acknowledge this
              before starting.
            </p>
          )}
        </div>
      )}
      <div className="flex justify-end">
        <Button
          variant="outline"
          disabled={pending}
          onClick={() =>
            act(
              () => actions.cancelOutreachQueue(id),
              "Queued work cancelled. In-flight sends may still finish.",
            )
          }
        >
          Cancel queued work
        </Button>
      </div>
      {!data.jobs.length && (
        <p className="py-10 text-muted-foreground">
          Research, drafts, and sends will appear here as they run.
        </p>
      )}
      <div className="divide-y border-l pl-5">
        {data.jobs
          .filter(
            (j) =>
              !issuesOnly ||
              ["failed", "needs_verification"].includes(j.status),
          )
          .map((j) => (
            <article
              key={j.id}
              className="relative py-5 pl-7 before:absolute before:left-0 before:top-6 before:size-2 before:rounded-full before:bg-primary/50"
            >
              <div className="flex flex-wrap justify-between gap-2">
                <span className="font-medium">
                  {statusLabel(j.kind)} ·{" "}
                  {j.payload.candidate?.fullName ??
                    data.people.find((p) => p.id === j.payload.prospectId)
                      ?.fullName ??
                    messages.find((m) => m.id === j.payload.messageId)?.person
                      .fullName ??
                    "Campaign"}
                </span>
                <span className="text-sm">{statusLabel(j.status)}</span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {date(j.updatedAt)}
                {j.payload.funding
                  ? ` · ${j.payload.funding === "hosted" ? "Orbit allowance" : "Personal keys"}`
                  : ""}
              </p>
              {j.error && (
                <p className="mt-2 text-sm text-destructive">{j.error}</p>
              )}
              {Array.isArray(j.result?.errors) && (
                <p className="mt-2 text-sm text-muted-foreground">
                  {j.result.errors.join(" · ")}
                </p>
              )}
              {j.status === "needs_verification" && (
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    disabled={pending}
                    onClick={() =>
                      act(
                        () => actions.verifyOutreachSend(j.id),
                        "Provider checked.",
                      )
                    }
                  >
                    Check provider
                  </Button>
                  {j.kind === "browser_send" && (
                    <>
                      <Button
                        variant="outline"
                        disabled={pending}
                        onClick={() =>
                          act(
                            () => actions.resolveBrowserSend(j.id, true),
                            "Manually confirmed as sent.",
                          )
                        }
                      >
                        I verified it was sent
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={pending}
                        onClick={() =>
                          act(
                            () => actions.resolveBrowserSend(j.id, false),
                            "Returned to drafts for a new approval.",
                          )
                        }
                      >
                        I verified it was not sent
                      </Button>
                    </>
                  )}
                </div>
              )}
            </article>
          ))}
      </div>
    </div>
  );
}
