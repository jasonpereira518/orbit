"use client";

import { useMemo, useState, useTransition } from "react";
import { IntentLink } from "@/components/ui/intent-link";
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
import { EmptyState } from "@/components/ui/empty-state";
import {
  Table,
  TableBody,
  TableCell,
  TableFrame,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { MessageEditorRow } from "@/components/outreach/message-editor-row";
import { OutcomeControls } from "@/components/outreach/outcome-controls";
import { OutreachActions } from "@/components/outreach/outreach-actions";
import { normalizeCompanyKey } from "@/lib/company-name";
import type { WarmPath } from "@/lib/warm-paths";
import { buildLinkedInSearchUrl, buildLinkedInUrl, channelLabel } from "@/lib/outreach-channels";
import { isAwaitingReply, isDeliveredMessage } from "@/lib/outreach-metrics";
import type { OutreachChannel, PipelineFilter } from "@/lib/outreach-types";
import { TONE, type Tone } from "@/lib/tone";
import { cn } from "@/lib/utils";
import { friendlyError } from "@/lib/errors";
import { TOAST_COPY } from "@/lib/toast-copy";

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
    sentAt?: Date | string | null;
  } | null;
  messages?: Array<{
    id: string;
    status: string;
    outcome?: string | null;
    stepIndex?: number | null;
  }>;
};

/** Stored prospect status → chip. The stored values never change. */
function labelForProspectStatus(status: string): { label: string; tone: Tone } {
  switch (status) {
    case "selected":
      return { label: "Selected", tone: "accent" };
    case "excluded":
      return { label: "Excluded", tone: "neutral" };
    default:
      return { label: "Suggested", tone: "neutral" };
  }
}

/** Stored message status → chip. */
function labelForMessageStatus(status: string): { label: string; tone: Tone } {
  switch (status) {
    case "sent":
      return { label: "Sent", tone: "success" };
    case "scheduled":
      return { label: "Scheduled", tone: "info" };
    case "failed":
      return { label: "Didn’t send", tone: "destructive" };
    case "copied":
      return { label: "Copied", tone: "neutral" };
    case "opened":
      return { label: "Opened", tone: "neutral" };
    case "skipped":
      return { label: "Skipped", tone: "neutral" };
    case "generated":
      return { label: "Drafted", tone: "neutral" };
    default:
      return { label: "Draft", tone: "neutral" };
  }
}

const PIPELINE_LABELS: Record<PipelineFilter, string> = {
  all: "All",
  needs_draft: "Needs draft",
  ready: "Ready",
  sent: "Sent",
  awaiting_reply: "Awaiting reply",
  follow_up_due: "Follow-up due",
  replied: "Replied",
  closed: "Closed",
};

function labelForPipeline(pipeline: PipelineFilter) {
  return PIPELINE_LABELS[pipeline] ?? pipeline.replaceAll("_", " ");
}

/**
 * "You already know 2 people at Stripe" — the line that should stop a cold email being sent.
 *
 * Renders nothing when there is no connection, which is the common case and must stay quiet;
 * a row of empty "no warm path" labels would train people to ignore the one that matters.
 *
 * Names link straight to the contact, because the next action is reading what you know about
 * them before asking for anything.
 */
function WarmPathNote({
  company,
  warmPaths,
}: {
  company?: string | null;
  warmPaths?: Record<string, WarmPath[]>;
}) {
  if (!company || !warmPaths) return null;
  const paths = warmPaths[normalizeCompanyKey(company)];
  if (!paths?.length) return null;

  return (
    <div className={cn("mt-1.5 rounded-lg border px-2 py-1.5 text-xs", TONE.accent.box)}>
      <span className="font-medium text-ink">
        You know {paths.length} {paths.length === 1 ? "person" : "people"} here
      </span>
      <ul className="mt-1 space-y-0.5">
        {paths.map((p) => (
          <li key={p.contactId} className="text-muted-foreground">
            <IntentLink
              href={`/contacts/${p.contactId}`}
              className="text-ink underline-offset-2 hover:underline"
            >
              {p.fullName}
            </IntentLink>
            {" — "}
            {p.reasonLabel}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The column name, shown inside the cell only while the table is reflowed into cards —
 * the header row that normally names these columns is hidden below `md`.
 */
const CELL_LABEL =
  "mb-1 block text-xs font-medium uppercase tracking-wider text-muted-foreground md:hidden";

/** A cell in the reflowed layout: no padding of its own below `md`, the row carries it. */
const CELL = "p-0 align-top md:table-cell md:px-4 md:py-3";

export function ProspectTable({
  campaignId,
  prospects,
  warmPaths,
  defaultChannel,
  onUpdated,
}: {
  campaignId: string;
  prospects: ProspectRow[];
  /**
   * Normalised company key -> people the user already knows there. Absent for a company with
   * nobody behind it, which is why the cell below tests presence rather than length.
   */
  warmPaths?: Record<string, WarmPath[]>;
  defaultChannel: OutreachChannel;
  onUpdated?: () => void;
}) {
  const [pending, start] = useTransition();
  const [expanded, setExpanded] = useState<string | null>(null);

  function toggleSelection(prospectId: string, checked: boolean) {
    start(async () => {
      try {
        await updateProspectSelection({
          campaignId,
          prospectIds: [prospectId],
          status: checked ? "selected" : "suggested",
        });
        onUpdated?.();
      } catch (err) {
        toast.error(friendlyError(err, TOAST_COPY.saveFailed));
      }
    });
  }

  function saveContact(prospectId: string) {
    start(async () => {
      try {
        const result = await saveProspectAsContact({ campaignId, prospectId });
        toast.success(result.created ? "Added to your orbit" : "Already in your contacts");
        onUpdated?.();
      } catch (err) {
        toast.error(friendlyError(err, TOAST_COPY.saveFailed));
      }
    });
  }

  function enrich(prospectId: string) {
    start(async () => {
      try {
        const updated = await enrichProspect({ campaignId, prospectId });
        if (updated.linkedinUrl) {
          toast.success("Found more on that LinkedIn profile");
        } else {
          toast.message("No LinkedIn URL found — try Find on LinkedIn");
        }
        onUpdated?.();
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t find more on that profile — try again?"));
      }
    });
  }

  if (!prospects.length) {
    return (
      <EmptyState
        title="No prospects in this view"
        description="Adjust the filters or run a search from the campaign wizard."
      />
    );
  }

  return (
    <TableFrame className="overflow-hidden md:overflow-x-auto">
      {/*
        A table from `md` up, and the same markup reflowed into stacked cards below it.

        It used to be a 980px table in a horizontal scroller at every width. On a phone
        that showed the Person column and half of Contact, and the edge of the card sliced
        "Save to Orbit" mid-word — nothing said the Draft and Actions columns were a
        sideways swipe away, so it read as clipping rather than as a scroller. Reflowing
        with CSS rather than rendering a second, card-shaped copy of each row keeps one
        instance of the draft editor and the send controls, which both hold state.
      */}
      <Table className="block md:table md:min-w-[980px]">
        <TableHeader className="hidden bg-surface-inset md:table-header-group">
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-10 px-4 py-3" />
            <TableHead className="px-4 py-3">Person</TableHead>
            <TableHead className="px-4 py-3">Contact</TableHead>
            <TableHead className="px-4 py-3">Draft</TableHead>
            <TableHead className="px-4 py-3">Actions / outcome</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody className="block md:table-row-group">
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
                sentAt: message.sentAt ?? null,
              });
            const delivered =
              message &&
              isDeliveredMessage({
                id: message.id,
                status: message.status,
                outcome: message.outcome ?? null,
                sentAt: message.sentAt ?? null,
              });
            const profileUrl = prospect.linkedinUrl
              ? buildLinkedInUrl(prospect.linkedinUrl)
              : null;
            const searchUrl = buildLinkedInSearchUrl(
              prospect.fullName,
              prospect.company
            );
            const prospectStatus = labelForProspectStatus(prospect.status);
            const messageStatus = message?.status ? labelForMessageStatus(message.status) : null;

            return (
              <TableRow
                key={prospect.id}
                className={cn(
                  "grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-4 px-4 py-4 align-top md:table-row md:p-0",
                  awaiting && "bg-primary/[0.03]"
                )}
              >
                <TableCell className={cn(CELL, "pt-0.5")}>
                  <Checkbox
                    checked={isSelected}
                    onCheckedChange={(checked) =>
                      toggleSelection(prospect.id, Boolean(checked))
                    }
                    disabled={pending}
                    aria-label={`Select ${prospect.fullName}`}
                  />
                </TableCell>
                <TableCell className={cn(CELL, "min-w-0")}>
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
                        <ExternalLink className="size-3.5" aria-hidden />
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
                          <ExternalLink className="size-3.5" aria-hidden />
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
                  {/* The warm path, directly under the company it belongs to.
                      This is the whole point of the feature: the moment a person decides
                      whether to send a cold email is the moment they need to know they do
                      not have to. Putting it anywhere else on the page — a panel, a tab —
                      would be putting it somewhere they are not looking. */}
                  <WarmPathNote company={prospect.company} warmPaths={warmPaths} />
                  <div className="mt-1 flex flex-wrap gap-1">
                    <Badge tone={prospectStatus.tone} size="sm">
                      {prospectStatus.label}
                    </Badge>
                    {prospect.isDemo && (
                      <Badge tone="warning" size="sm">
                        Demo
                      </Badge>
                    )}
                    {prospect.companyMismatch && (
                      <Badge tone="warning" size="sm">
                        Company mismatch
                      </Badge>
                    )}
                    {prospect.pipeline && prospect.pipeline !== "all" && (
                      <Badge tone="neutral" size="sm">
                        {labelForPipeline(prospect.pipeline)}
                      </Badge>
                    )}
                    {messageStatus && (
                      <Badge tone={messageStatus.tone} size="sm">
                        {messageStatus.label}
                      </Badge>
                    )}
                    {(message?.stepIndex ?? 0) > 0 && (
                      <Badge tone="neutral" size="sm">
                        Follow-up {message?.stepIndex}
                      </Badge>
                    )}
                  </div>
                </TableCell>
                <TableCell className={cn(CELL, "col-start-2 min-w-0 text-muted-foreground")}>
                  <span className={CELL_LABEL}>Contact</span>
                  <div>{prospect.email || "—"}</div>
                  <div>{prospect.phone || "—"}</div>
                  <div className="mt-2">
                    {prospect.contactId ? (
                      <IntentLink
                        href={`/contacts/${prospect.contactId}`}
                        className="text-primary underline-offset-2 hover:underline"
                      >
                        View contact
                      </IntentLink>
                    ) : (
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => saveContact(prospect.id)}
                        disabled={pending}
                      >
                        <UserPlus className="size-3" />
                        Save to Orbit
                      </Button>
                    )}
                  </div>
                </TableCell>
                <TableCell className={cn(CELL, "col-start-2 min-w-0")}>
                  <span className={CELL_LABEL}>Draft</span>
                  {message ? (
                    <div className="space-y-2">
                      <Badge tone="neutral" size="sm">
                        {channelLabel(channel)}
                      </Badge>
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
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-auto w-full justify-start px-0 py-0 text-left font-normal whitespace-normal text-muted-foreground hover:bg-transparent"
                          onClick={() => setExpanded(prospect.id)}
                          aria-label="Edit draft"
                        >
                          <span className="line-clamp-3">
                            {message.body || "Empty draft — click to edit"}
                          </span>
                        </Button>
                      )}
                    </div>
                  ) : (
                    <span className="text-muted-foreground">No draft</span>
                  )}
                </TableCell>
                <TableCell className={cn(CELL, "col-start-2 min-w-0 max-md:has-[>div:empty]:hidden")}>
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
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </TableFrame>
  );
}

export function useSelectedProspectIds(prospects: ProspectRow[]) {
  return useMemo(
    () => prospects.filter((p) => p.status === "selected").map((p) => p.id),
    [prospects]
  );
}
