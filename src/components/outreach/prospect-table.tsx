"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { ExternalLink, UserPlus } from "lucide-react";
import { toast } from "@/lib/toast";
import {
  enrichProspect,
  saveProspectAsContact,
  updateProspectSelection,
} from "@/actions/outreach";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { MessageEditorRow } from "@/components/outreach/message-editor-row";
import { OutcomeControls } from "@/components/outreach/outcome-controls";
import { OutreachActions } from "@/components/outreach/outreach-actions";
import { buildLinkedInSearchUrl, buildLinkedInUrl, channelLabel } from "@/lib/outreach-channels";
import { isAwaitingReply, isDeliveredMessage } from "@/lib/outreach-metrics";
import type { OutreachChannel, PipelineFilter } from "@/lib/outreach-types";

export type ProspectRow = {
  id: string;
  fullName: string;
  title: string | null;
  company: string | null;
  email: string | null;
  phone: string | null;
  linkedinUrl: string | null;
  status: string;
  contactId: string | null;
  isDemo?: boolean;
  companyMismatch?: boolean;
  pipeline?: PipelineFilter;
  message?: {
    id: string;
    channel: OutreachChannel;
    subject: string | null;
    body: string;
    status: string;
    stepIndex?: number | null;
    outcome?: string | null;
    scheduledFor?: Date | string | null;
  } | null;
  messages?: Array<{
    id: string;
    status: string;
    outcome?: string | null;
    stepIndex?: number | null;
  }>;
};

export function ProspectTable({
  campaignId,
  prospects,
  defaultChannel,
  onUpdated,
}: {
  campaignId: string;
  prospects: ProspectRow[];
  defaultChannel: OutreachChannel;
  onUpdated?: () => void;
}) {
  const [pending, start] = useTransition();
  const [expanded, setExpanded] = useState<string | null>(null);

  function toggleSelection(prospectId: string, checked: boolean) {
    start(async () => {
      await updateProspectSelection({
        campaignId,
        prospectIds: [prospectId],
        status: checked ? "selected" : "suggested",
      });
      onUpdated?.();
    });
  }

  function saveContact(prospectId: string) {
    start(async () => {
      try {
        const result = await saveProspectAsContact({ campaignId, prospectId });
        toast.success(result.created ? "Saved to contacts" : "Already in contacts");
        onUpdated?.();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Save failed");
      }
    });
  }

  function enrich(prospectId: string) {
    start(async () => {
      try {
        const updated = await enrichProspect({ campaignId, prospectId });
        if (updated.linkedinUrl) {
          toast.success("LinkedIn profile enriched");
        } else {
          toast.message("No LinkedIn URL found — try Find on LinkedIn");
        }
        onUpdated?.();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Enrich failed");
      }
    });
  }

  if (!prospects.length) {
    return (
      <div className="rounded-2xl border border-dashed border-border/70 p-10 text-center text-sm text-muted-foreground">
        No prospects in this view. Adjust filters or run a search from the campaign wizard.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-border/70 bg-card">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[980px] text-sm">
          <thead className="border-b border-border/70 bg-muted/30 text-left text-muted-foreground">
            <tr>
              <th className="px-4 py-3 w-10" />
              <th className="px-4 py-3">Person</th>
              <th className="px-4 py-3">Contact</th>
              <th className="px-4 py-3">Draft</th>
              <th className="px-4 py-3">Actions / outcome</th>
            </tr>
          </thead>
          <tbody>
            {prospects.map((prospect) => {
              const message = prospect.message;
              const channel = (message?.channel || defaultChannel) as OutreachChannel;
              const isSelected = prospect.status === "selected";
              const awaiting =
                message &&
                isAwaitingReply({
                  id: message.id,
                  status: message.status,
                  outcome: message.outcome ?? null,
                });
              const delivered =
                message &&
                isDeliveredMessage({
                  id: message.id,
                  status: message.status,
                  outcome: message.outcome ?? null,
                });
              const profileUrl = prospect.linkedinUrl
                ? buildLinkedInUrl(prospect.linkedinUrl)
                : null;
              const searchUrl = buildLinkedInSearchUrl(
                prospect.fullName,
                prospect.company
              );

              return (
                <tr
                  key={prospect.id}
                  className={`border-b border-border/50 align-top ${
                    awaiting ? "bg-primary/[0.03]" : ""
                  }`}
                >
                  <td className="px-4 py-3">
                    <Checkbox
                      checked={isSelected}
                      onCheckedChange={(checked) =>
                        toggleSelection(prospect.id, Boolean(checked))
                      }
                      disabled={pending}
                    />
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-ink">
                        {prospect.fullName}
                      </span>
                      {profileUrl ? (
                        <a
                          href={profileUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-primary underline-offset-2 hover:underline"
                          title="Open LinkedIn profile"
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                          LinkedIn
                        </a>
                      ) : (
                        <span className="inline-flex items-center gap-1.5">
                          <a
                            href={searchUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:text-primary hover:underline"
                            title="Search LinkedIn for this person"
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                            Find on LinkedIn
                          </a>
                          <Button
                            size="xs"
                            variant="ghost"
                            disabled={pending}
                            onClick={() => enrich(prospect.id)}
                          >
                            Enrich
                          </Button>
                        </span>
                      )}
                    </div>
                    <div className="text-muted-foreground">
                      {prospect.title || "—"}
                      {prospect.company ? ` @ ${prospect.company}` : ""}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      <Badge variant="outline">{prospect.status}</Badge>
                      {prospect.isDemo && <Badge variant="outline">Demo</Badge>}
                      {prospect.companyMismatch && (
                        <Badge variant="outline">Company mismatch</Badge>
                      )}
                      {prospect.pipeline && prospect.pipeline !== "all" && (
                        <Badge variant="outline">
                          {prospect.pipeline.replaceAll("_", " ")}
                        </Badge>
                      )}
                      {message?.status && (
                        <Badge variant="outline">{message.status}</Badge>
                      )}
                      {(message?.stepIndex ?? 0) > 0 && (
                        <Badge variant="outline">Follow-up {message?.stepIndex}</Badge>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    <div>{prospect.email || "—"}</div>
                    <div>{prospect.phone || "—"}</div>
                    <div className="mt-2">
                      {prospect.contactId ? (
                        <Link
                          href={`/contacts/${prospect.contactId}`}
                          className="text-primary underline-offset-2 hover:underline"
                        >
                          View contact
                        </Link>
                      ) : (
                        <Button
                          size="xs"
                          variant="outline"
                          onClick={() => saveContact(prospect.id)}
                          disabled={pending}
                        >
                          <UserPlus className="mr-1 h-3 w-3" />
                          Save to Orbit
                        </Button>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {message ? (
                      <div className="space-y-2">
                        <Badge variant="outline">{channelLabel(channel)}</Badge>
                        {expanded === prospect.id ? (
                          <MessageEditorRow
                            campaignId={campaignId}
                            prospectId={prospect.id}
                            messageId={message.id}
                            channel={channel}
                            subject={message.subject}
                            body={message.body}
                            onUpdated={onUpdated}
                          />
                        ) : (
                          <button
                            type="button"
                            className="line-clamp-3 text-left text-muted-foreground hover:text-foreground"
                            onClick={() => setExpanded(prospect.id)}
                          >
                            {message.body || "Empty draft — click to edit"}
                          </button>
                        )}
                      </div>
                    ) : (
                      <span className="text-muted-foreground">No draft</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="space-y-3">
                      {message && !delivered && (
                        <OutreachActions
                          messageId={message.id}
                          channel={channel}
                          subject={message.subject}
                          body={message.body}
                          prospect={{
                            email: prospect.email,
                            phone: prospect.phone,
                            linkedinUrl: prospect.linkedinUrl,
                          }}
                          onUpdated={onUpdated}
                        />
                      )}
                      {message && delivered && (
                        <OutcomeControls
                          messageId={message.id}
                          currentOutcome={message.outcome}
                          onUpdated={onUpdated}
                        />
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function useSelectedProspectIds(prospects: ProspectRow[]) {
  return useMemo(
    () => prospects.filter((p) => p.status === "selected").map((p) => p.id),
    [prospects]
  );
}
