"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { format, formatDistanceToNow } from "date-fns";
import {
  Globe,
  Settings,
} from "lucide-react";
import { toast } from "@/lib/toast";
import { regenerateContactSummary } from "@/actions/contacts";
import { EasyFollowUp } from "@/components/follow-up/easy-follow-up";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { formatHowMetSummary } from "@/lib/met-context";
import { RING_LABELS, type GraphNodeData } from "@/lib/graph-layout";
import type { UserSocialLinks } from "@/actions/graph";

export type InspectSelection =
  | { type: "contact"; id: string; data: GraphNodeData }
  | {
      type: "user";
      data: GraphNodeData;
      summary: {
        total: number;
        companyCount: number;
        scoreCounts: Record<number, number>;
        dormantCount?: number;
        overdueCount?: number;
        userImageUrl?: string | null;
        userEmail?: string | null;
        socialLinks?: UserSocialLinks;
        goals?: Array<{ id: string; text: string }>;
      };
    }
  | null;

function formatMaybeDate(value: string | null | undefined) {
  if (!value) return null;
  try {
    return format(new Date(value), "MMM d, yyyy");
  } catch {
    return null;
  }
}

function formatMaybeRelative(value: string | null | undefined) {
  if (!value) return null;
  try {
    return formatDistanceToNow(new Date(value), { addSuffix: true });
  } catch {
    return null;
  }
}

function closenessChipClass(closeness: number | undefined) {
  if (typeof closeness !== "number") return "bg-muted text-muted-foreground";
  if (closeness >= 0.55) return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300";
  if (closeness >= 0.25) return "bg-sky-500/15 text-sky-700 dark:text-sky-300";
  return "bg-amber-500/15 text-amber-700 dark:text-amber-300";
}

function LinkedInGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className}>
      <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
    </svg>
  );
}

function GitHubGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className}>
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

function XGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className}>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.227-8.26L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

function SocialIconButton({
  href,
  label,
  kind,
}: {
  href: string;
  label: string;
  kind: "linkedin" | "twitter" | "github" | "website";
}) {
  const icon =
    kind === "linkedin" ? (
      <LinkedInGlyph className="size-4" />
    ) : kind === "github" ? (
      <GitHubGlyph className="size-4" />
    ) : kind === "twitter" ? (
      <XGlyph className="size-4" />
    ) : (
      <Globe className="size-4" />
    );

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={label}
            className={cn(
              "inline-flex size-9 items-center justify-center rounded-full border border-border/70 bg-card text-muted-foreground transition-colors",
              "hover:border-border hover:bg-muted/60 hover:text-foreground",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            )}
          />
        }
      >
        {icon}
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

export function ContactInspectPanel({
  selection,
  onClose,
  onContactPatch,
}: {
  selection: InspectSelection;
  onClose: () => void;
  onContactPatch?: (
    id: string,
    patch: Partial<GraphNodeData>
  ) => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const open = selection !== null;

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent
        side="right"
        className="w-full overflow-y-auto border-l border-border/70 bg-card sm:max-w-md"
      >
        {selection?.type === "user" && (
          <YouPanelBody summary={selection.summary} data={selection.data} />
        )}

        {selection?.type === "contact" && (
          <ContactPanelBody
            id={selection.id}
            data={selection.data}
            pending={pending}
            start={start}
            onContactPatch={onContactPatch}
            onRefresh={() => router.refresh()}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function YouPanelBody({
  data,
  summary,
}: {
  data: GraphNodeData;
  summary: Extract<InspectSelection, { type: "user" }>["summary"];
}) {
  const socials = summary.socialLinks || {};
  const hasSocials = Boolean(
    socials.linkedin || socials.twitter || socials.github || socials.website
  );
  const goals = summary.goals || [];

  return (
    <>
      <SheetHeader className="border-b border-border/50 pb-4">
        <div className="flex items-start gap-3 pr-8">
          {summary.userImageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={summary.userImageUrl}
              alt=""
              className="h-14 w-14 rounded-full border border-primary/20 object-cover shadow-[0_0_20px_rgba(255,200,100,0.35)]"
            />
          ) : (
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[radial-gradient(circle_at_30%_30%,#fff,#f5c86a_55%,#e09030)] text-sm font-semibold text-primary shadow-[0_0_20px_rgba(255,200,100,0.45)]">
              {data.initials}
            </div>
          )}
          <div className="min-w-0">
            <SheetTitle className="font-[family-name:var(--font-display)] text-2xl text-primary">
              {data.label}
            </SheetTitle>
            <SheetDescription>
              {summary.userEmail || "Center of your solar system"}
            </SheetDescription>
          </div>
        </div>
      </SheetHeader>

      <div className="space-y-5 px-4 py-4">
        <div className="rounded-xl bg-primary p-4 text-primary-foreground">
          <p className="text-3xl font-semibold">{summary.total}</p>
          <p className="text-sm text-primary-foreground/70">people in orbit</p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-xl border border-border/60 bg-muted/30 p-3">
            <p className="text-lg font-medium text-primary">
              {summary.companyCount}
            </p>
            <p className="text-xs text-muted-foreground">companies</p>
          </div>
          <div className="rounded-xl border border-border/60 bg-muted/30 p-3">
            <p className="text-lg font-medium text-primary">
              {(summary.scoreCounts[4] || 0) + (summary.scoreCounts[5] || 0)}
            </p>
            <p className="text-xs text-muted-foreground">strong ties</p>
          </div>
          <div className="rounded-xl border border-border/60 bg-muted/30 p-3">
            <p className="text-lg font-medium text-[#c4452d]">
              {summary.dormantCount ?? 0}
            </p>
            <p className="text-xs text-muted-foreground">drifting comets</p>
          </div>
          <div className="rounded-xl border border-border/60 bg-muted/30 p-3">
            <p className="text-lg font-medium text-primary">
              {summary.overdueCount ?? 0}
            </p>
            <p className="text-xs text-muted-foreground">overdue follow-ups</p>
          </div>
        </div>

        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            By orbit
          </p>
          <ul className="space-y-1 text-sm">
            {[5, 4, 3, 2, 1].map((score) => (
              <li
                key={score}
                className="flex items-center justify-between rounded-lg px-2 py-1.5"
              >
                <span>
                  {RING_LABELS[score]}
                  <span className="ml-1.5 text-xs text-muted-foreground">
                    ({score})
                  </span>
                </span>
                <span className="text-primary">
                  {summary.scoreCounts[score] || 0}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Socials
            </p>
            <Link
              href="/settings"
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary"
            >
              <Settings className="h-3 w-3" />
              Edit
            </Link>
          </div>
          {hasSocials ? (
            <TooltipProvider>
              <div className="flex flex-wrap items-center gap-1.5">
                {socials.linkedin ? (
                  <SocialIconButton
                    href={socials.linkedin}
                    label="LinkedIn"
                    kind="linkedin"
                  />
                ) : null}
                {socials.twitter ? (
                  <SocialIconButton
                    href={socials.twitter}
                    label="X / Twitter"
                    kind="twitter"
                  />
                ) : null}
                {socials.github ? (
                  <SocialIconButton
                    href={socials.github}
                    label="GitHub"
                    kind="github"
                  />
                ) : null}
                {socials.website ? (
                  <SocialIconButton
                    href={socials.website}
                    label="Website"
                    kind="website"
                  />
                ) : null}
              </div>
            </TooltipProvider>
          ) : (
            <p className="text-sm text-muted-foreground">
              Add your social links in Settings to show them here.
            </p>
          )}
        </div>

        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Focus & goals
          </p>
          {goals.length > 0 ? (
            <ul className="space-y-2">
              {goals.map((g) => (
                <li
                  key={g.id}
                  className="rounded-xl border border-border/60 bg-muted/30 px-3 py-2 text-sm text-foreground/90"
                >
                  {g.text}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">
              Set networking goals in Settings — they shape closeness and
              outreach.
            </p>
          )}
        </div>
      </div>
    </>
  );
}

function ContactPanelBody({
  id,
  data,
  pending,
  start,
  onContactPatch,
  onRefresh,
}: {
  id: string;
  data: GraphNodeData;
  pending: boolean;
  start: (fn: () => void | Promise<void>) => void;
  onContactPatch?: (id: string, patch: Partial<GraphNodeData>) => void;
  onRefresh: () => void;
}) {
  const [summaryText, setSummaryText] = useState(data.aiSummary ?? null);

  useEffect(() => {
    setSummaryText(data.aiSummary ?? null);
  }, [id, data.aiSummary]);

  const howMet = formatHowMetSummary({
    metContext: data.metContext,
    dateMet: data.dateMet,
    howMet: data.howMet,
  });

  return (
    <>
      <SheetHeader className="border-b border-border/50 pb-4">
        <div className="flex items-start gap-3 pr-8">
          <div
            className={cn(
              "flex h-14 w-14 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-primary-foreground",
              "bg-[radial-gradient(circle_at_30%_30%,rgba(255,255,255,0.35),transparent_42%)] bg-primary",
              data.comet && "bg-[#c4452d] ring-2 ring-[#ff6b4a]/60",
              data.overdue && !data.comet && "ring-2 ring-[#c4a35a]"
            )}
          >
            {data.initials}
          </div>
          <div className="min-w-0">
            <SheetTitle className="font-[family-name:var(--font-display)] text-2xl text-primary">
              {data.label}
            </SheetTitle>
            {data.fullName &&
              data.preferredName &&
              data.preferredName !== data.fullName && (
                <p className="text-xs text-muted-foreground">{data.fullName}</p>
              )}
            <SheetDescription>
              {[data.title, data.company].filter(Boolean).join(" · ") ||
                "Contact in your network"}
            </SheetDescription>
            {data.school && (
              <p className="mt-0.5 text-xs text-muted-foreground">
                {data.school}
              </p>
            )}
          </div>
        </div>
      </SheetHeader>

      <div className="space-y-4 overflow-y-auto px-4 py-4 pb-2">
        <div className="flex flex-wrap gap-2">
          <span
            className={cn(
              "rounded-full px-2.5 py-1 text-xs font-medium",
              closenessChipClass(data.closeness)
            )}
          >
            {RING_LABELS[data.score || 2] || "Orbit"}
            {typeof data.closeness === "number"
              ? ` · ${Math.round(data.closeness * 100)}%`
              : ` · ${data.score}/5`}
          </span>
          {data.comet && (
            <span className="rounded-full bg-[#c4452d]/15 px-2.5 py-1 text-xs font-medium text-[#c4452d]">
              Drifting comet
            </span>
          )}
          {data.overdue && (
            <span className="rounded-full bg-chart-4/15 px-2.5 py-1 text-xs font-medium text-chart-4">
              Follow-up overdue
            </span>
          )}
        </div>

        {(data.tags || []).length > 0 && (
          <div>
            <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Tags
            </p>
            <div className="flex flex-wrap gap-1.5">
              {data.tags!.map((tag) => (
                <span
                  key={tag}
                  className="rounded-md border border-border/60 bg-muted/40 px-2 py-0.5 text-xs"
                >
                  {tag}
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="grid gap-2 text-sm">
          <div className="flex justify-between gap-4 border-b border-border/50 py-2">
            <span className="text-muted-foreground">Last interaction</span>
            <span className="text-right text-primary">
              {formatMaybeRelative(data.lastInteractionAt) ||
                formatMaybeDate(data.lastInteractionAt) ||
                "Never"}
            </span>
          </div>
          <div className="flex justify-between gap-4 border-b border-border/50 py-2">
            <span className="text-muted-foreground">Next follow-up</span>
            <span className="text-right text-primary">
              {formatMaybeDate(data.nextFollowUpAt) || "None"}
            </span>
          </div>
          {howMet && (
            <div className="border-b border-border/50 py-2">
              <p className="text-muted-foreground">How you met</p>
              <p className="mt-1 text-primary">{howMet}</p>
            </div>
          )}
        </div>

        {(data.email || data.phone || data.linkedinUrl || data.website) && (
          <div className="flex flex-wrap gap-2">
            {data.email && (
              <a
                href={`mailto:${data.email}`}
                className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
              >
                Email
              </a>
            )}
            {data.phone && (
              <a
                href={`tel:${data.phone}`}
                className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
              >
                Call
              </a>
            )}
            {data.linkedinUrl && (
              <a
                href={data.linkedinUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
              >
                LinkedIn
              </a>
            )}
            {data.website && (
              <a
                href={data.website}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
              >
                Website
              </a>
            )}
          </div>
        )}

        <div>
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Who they are
            </p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  try {
                    const res = await regenerateContactSummary(id);
                    if (res.summary) {
                      setSummaryText(res.summary);
                      onContactPatch?.(id, { aiSummary: res.summary });
                      toast.success("Summary updated");
                    } else {
                      toast.error("Could not generate summary");
                    }
                    onRefresh();
                  } catch (err) {
                    toast.error(
                      err instanceof Error
                        ? err.message
                        : "Could not generate summary"
                    );
                  }
                })
              }
            >
              {pending ? "…" : summaryText ? "Refresh" : "Generate"}
            </Button>
          </div>
          {summaryText ? (
            <p className="text-sm leading-relaxed text-foreground/90">
              {summaryText}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              No summary yet. Generate one from how you met and past
              conversations.
            </p>
          )}
        </div>

        {(data.keyFacts || []).length > 0 && (
          <div>
            <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Key facts
            </p>
            <ul className="list-inside list-disc space-y-1 text-sm text-foreground/90">
              {data.keyFacts!.map((fact) => (
                <li key={fact}>{fact}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <SheetFooter className="gap-2 border-t border-border/50 sm:flex-col">
        <EasyFollowUp
          contactId={id}
          contactName={data.preferredName || data.fullName}
          nextFollowUpAt={data.nextFollowUpAt}
          className="w-full rounded-xl border border-border/50 bg-muted/30 p-3"
          onScheduled={(dueDate) => {
            onContactPatch?.(id, {
              nextFollowUpAt: dueDate,
              overdue: false,
            });
            onRefresh();
          }}
        />
        <Link
          href={`/contacts/${id}`}
          className={cn(
            buttonVariants(),
            "w-full bg-primary text-primary-foreground hover:bg-primary/90"
          )}
        >
          Open full profile
        </Link>
        <Link
          href={`/capture?contactId=${id}`}
          className={cn(buttonVariants({ variant: "outline" }), "w-full")}
        >
          Log interaction
        </Link>
      </SheetFooter>
    </>
  );
}
