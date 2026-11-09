"use client";

import { useMemo, useState, useTransition } from "react";
import { IntentLink } from "@/components/ui/intent-link";
import { Briefcase, ExternalLink, Eye, GraduationCap, Sparkles, TrendingUp, UserPlus } from "lucide-react";
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
import { DraftPreviewDialog } from "@/components/outreach/draft-preview-dialog";
import { normalizeCompanyKey } from "@/lib/company-name";
import type { WarmPath } from "@/lib/warm-paths";
import { buildLinkedInSearchUrl, buildLinkedInUrl, channelLabel } from "@/lib/outreach-channels";
import { isAwaitingReply, isDeliveredMessage } from "@/lib/outreach-metrics";
import type { OutreachChannel, PipelineFilter } from "@/lib/outreach-types";
import { friendlyError } from "@/lib/errors";
import { TOAST_COPY } from "@/lib/toast-copy";

export type ProspectRow = {
  id: string;
  fullName: string;
  title: string | null;
  company: string | null;
  location?: string | null;
  email: string | null;
  phone: string | null;
  linkedinUrl: string | null;
  status: string;
  contactId: string | null;
  isDemo?: boolean;
  companyMismatch?: boolean;
  pipeline?: PipelineFilter;
  avatarUrl?: string | null;
  enrichment?: Record<string, unknown> | null;
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
    <div className="mt-1.5 rounded-lg border border-primary/30 bg-primary/5 px-2 py-1.5 text-xs">
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
  const [expanded, _setExpanded] = useState<string | null>(null);
  const [previewProspect, setPreviewProspect] = useState<ProspectRow | null>(null);

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
      <div className="rounded-3xl border border-dashed border-border/70 p-10 text-center text-sm text-muted-foreground">
        No prospects in this view. Adjust filters or run a search from the campaign wizard.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-3xl border border-border/70 bg-card">
      {/*
        A table from `md` up, and the same markup reflowed into stacked cards below it.

        It used to be a 980px table in a horizontal scroller at every width. On a phone
        that showed the Person column and half of Contact, and the edge of the card sliced
        "Save to Orbit" mid-word — nothing said the Draft and Actions columns were a
        sideways swipe away, so it read as clipping rather than as a scroller. Reflowing
        with CSS rather than rendering a second, card-shaped copy of each row keeps one
        instance of the draft editor and the send controls, which both hold state.
      */}
      <div className="md:overflow-x-auto">
        <table className="block w-full text-sm md:table md:min-w-[980px]">
          <thead className="hidden border-b border-border/70 bg-muted/30 text-left text-muted-foreground md:table-header-group">
            <tr>
              <th className="px-4 py-3 w-10" />
              <th className="px-4 py-3">Person</th>
              <th className="px-4 py-3">Contact</th>
              <th className="px-4 py-3">Draft</th>
              <th className="px-4 py-3">Actions / outcome</th>
            </tr>
          </thead>
          <tbody className="block md:table-row-group">
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
              const enrichment = (prospect.enrichment ?? {}) as Record<string, unknown>;
              const avatarUrl = prospect.avatarUrl || (typeof enrichment.avatarUrl === "string" ? enrichment.avatarUrl : null);
              const summary = (typeof enrichment.summary === "string" ? enrichment.summary : null) || (typeof enrichment.headline === "string" ? enrichment.headline : null);
              const effectivenessScore = typeof enrichment.effectivenessScore === "number" ? enrichment.effectivenessScore : null;
              const scoreReasons = Array.isArray(enrichment.scoreReasons) ? (enrichment.scoreReasons as string[]) : [];
              const isAlumniMatch = Boolean(enrichment.isAlumniMatch);
              const matchedSchool = typeof enrichment.matchedSchool === "string" ? enrichment.matchedSchool : null;
              const education = typeof enrichment.education === "string" ? enrichment.education : (typeof enrichment.almaMater === "string" ? enrichment.almaMater : null);
              const newsContext = typeof enrichment.newsContext === "string" ? enrichment.newsContext : null;
              const signals = Array.isArray(enrichment.signals) ? (enrichment.signals as string[]) : [];

              return (
                <tr
                  key={prospect.id}
                  className={`grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-4 border-b border-border/50 px-4 py-4 align-top last:border-b-0 md:table-row md:p-0 md:last:border-b ${
                    awaiting ? "bg-primary/[0.03]" : ""
                  }`}
                >
                  <td className="pt-0.5 md:table-cell md:px-4 md:py-3">
                    <Checkbox
                      checked={isSelected}
                      onCheckedChange={(checked) =>
                        toggleSelection(prospect.id, Boolean(checked))
                      }
                      disabled={pending}
                    />
                  </td>
                  <td className="min-w-0 md:table-cell md:px-4 md:py-3">
                    <div className="flex items-start gap-3">
                      {/* Avatar */}
                      <div className="relative h-9 w-9 shrink-0 rounded-full overflow-hidden border border-border/60 bg-muted">
                        {avatarUrl ? (
                          <img
                            src={avatarUrl}
                            alt={prospect.fullName}
                            className="h-full w-full object-cover"
                            onError={(e) => {
                              (e.target as HTMLElement).style.display = "none";
                            }}
                          />
                        ) : (
                          <div className="h-full w-full flex items-center justify-center font-medium text-xs text-muted-foreground">
                            {prospect.fullName.slice(0, 2).toUpperCase()}
                          </div>
                        )}
                      </div>

                      <div className="min-w-0 flex-1">
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
                        <div className="text-muted-foreground text-xs mt-0.5">
                          {prospect.title || "—"}
                          {prospect.company ? ` @ ${prospect.company}` : ""}
                          {prospect.location ? ` · ${prospect.location}` : ""}
                        </div>

                        {/* Bio / Summary snippet if present */}
                        {Boolean(summary) && (
                          <p className="mt-1 text-2xs text-muted-foreground line-clamp-1 max-w-md">
                            {summary}
                          </p>
                        )}

                        {/* Warm path note */}
                        <WarmPathNote company={prospect.company} warmPaths={warmPaths} />

                        {/* Student-friendly Smart Badges */}
                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                          {/* Effectiveness Match Badge */}
                          {typeof effectivenessScore === "number" && (
                            <span
                              title={scoreReasons.join(" • ") || "Effectiveness probability"}
                              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-semibold tabular-nums border ${
                                effectivenessScore >= 80
                                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                                  : effectivenessScore >= 60
                                    ? "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300"
                                    : "border-border/60 bg-muted/40 text-muted-foreground"
                              }`}
                            >
                              <Sparkles className="h-2.5 w-2.5 text-emerald-500" />
                              {effectivenessScore}% Match
                            </span>
                          )}

                          {/* Shared Alumni Match Badge */}
                          {Boolean(isAlumniMatch && matchedSchool) && (
                            <span className="inline-flex items-center gap-1 rounded-full border border-indigo-500/40 bg-indigo-500/15 px-2.5 py-0.5 text-2xs font-semibold text-indigo-800 dark:text-indigo-200 shadow-xs">
                              <GraduationCap className="h-3.5 w-3.5 text-indigo-600 dark:text-indigo-300" />
                              Alumni Match: {matchedSchool}
                            </span>
                          )}

                          {/* Education / Alma Mater Badge */}
                          {Boolean(education) && !isAlumniMatch && (
                            <span
                              className="inline-flex items-center gap-1 rounded-full border border-indigo-500/30 bg-indigo-500/10 px-2 py-0.5 text-2xs font-medium text-indigo-700 dark:text-indigo-300 max-w-xs truncate"
                              title={education}
                            >
                              <GraduationCap className="h-3 w-3 text-indigo-500 shrink-0" />
                              <span className="truncate">{education}</span>
                            </span>
                          )}

                          {/* Warm Path Connection Badge */}
                          {Boolean(prospect.company && warmPaths && warmPaths[normalizeCompanyKey(prospect.company)]?.length) && (
                            <span className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-2xs font-medium text-primary">
                              Warm Connection
                            </span>
                          )}

                          {/* Recent News Hook */}
                          {Boolean(newsContext) && (
                            <span
                              className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-2xs font-medium text-emerald-700 dark:text-emerald-300 max-w-sm truncate"
                              title={newsContext}
                            >
                              <TrendingUp className="h-3 w-3 text-emerald-500 shrink-0" />
                              <span className="truncate">{newsContext}</span>
                            </span>
                          )}

                          {/* Hiring Signal */}
                          {signals.some((s) => /hir|grow|scale|expan/i.test(s)) && (
                            <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-2xs font-medium text-amber-700 dark:text-amber-300">
                              <Briefcase className="h-3 w-3 text-amber-600" />
                              Hiring Signal
                            </span>
                          )}
                        </div>

                        {/* Company Growth Signals */}
                        {signals.length > 0 && (
                          <div className="mt-1 flex flex-wrap gap-1">
                            {signals.slice(0, 2).map((sig: string) => (
                              <span key={sig} className="inline-flex items-center rounded-full bg-muted/50 border border-border/40 px-2 py-0.5 text-3xs text-muted-foreground">
                                {sig}
                              </span>
                            ))}
                          </div>
                        )}

                        <div className="mt-1 flex flex-wrap gap-1">
                          <Badge variant="outline" className="rounded-full">{prospect.status}</Badge>
                          {prospect.isDemo && <Badge variant="outline" className="rounded-full">Demo</Badge>}
                          {prospect.companyMismatch && (
                            <Badge variant="outline" className="rounded-full">Company mismatch</Badge>
                          )}
                          {prospect.pipeline && prospect.pipeline !== "all" && (
                            <Badge variant="outline" className="rounded-full">
                              {prospect.pipeline.replaceAll("_", " ")}
                            </Badge>
                          )}
                          {message?.status && (
                            <Badge variant="outline" className="rounded-full">{message.status}</Badge>
                          )}
                          {(message?.stepIndex ?? 0) > 0 && (
                            <Badge variant="outline" className="rounded-full">Follow-up {message?.stepIndex}</Badge>
                          )}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="col-start-2 min-w-0 text-muted-foreground md:table-cell md:px-4 md:py-3">
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
                          <UserPlus className="mr-1 h-3 w-3" />
                          Save to Orbit
                        </Button>
                      )}
                    </div>
                  </td>
                  <td className="col-start-2 min-w-0 md:table-cell md:px-4 md:py-3">
                    <span className={CELL_LABEL}>Draft</span>
                    {message ? (
                      <div className="space-y-2">
                        <div className="flex items-center justify-between gap-1">
                          <Badge variant="outline" className="rounded-full text-2xs">{channelLabel(channel)}</Badge>
                          <Button
                            size="xs"
                            variant="outline"
                            onClick={() => setPreviewProspect(prospect)}
                            className="rounded-full gap-1 text-2xs h-6 px-2.5 shadow-xs"
                          >
                            <Eye className="h-3 w-3 text-primary" />
                            Preview
                          </Button>
                        </div>
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
                            className="line-clamp-2 text-left text-xs text-muted-foreground hover:text-foreground"
                            onClick={() => setPreviewProspect(prospect)}
                            title="Click to preview full draft"
                          >
                            {message.body || "Empty draft — click to edit"}
                          </button>
                        )}
                      </div>
                    ) : (
                      <span className="text-muted-foreground">No draft</span>
                    )}
                  </td>
                  <td className="col-start-2 min-w-0 max-md:has-[>div:empty]:hidden md:table-cell md:px-4 md:py-3">
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

      {previewProspect && (
        <DraftPreviewDialog
          open={Boolean(previewProspect)}
          onOpenChange={(open) => !open && setPreviewProspect(null)}
          campaignId={campaignId}
          prospect={previewProspect}
          onUpdated={onUpdated}
        />
      )}
    </div>
  );
}

/**
 * The column name, shown inside the cell only while the table is reflowed into cards —
 * the header row that normally names these columns is hidden below `md`.
 */
const CELL_LABEL =
  "mb-1 block text-2xs font-medium uppercase tracking-wide text-muted-foreground-subtle md:hidden";

export function useSelectedProspectIds(prospects: ProspectRow[]) {
  return useMemo(
    () => prospects.filter((p) => p.status === "selected").map((p) => p.id),
    [prospects]
  );
}
