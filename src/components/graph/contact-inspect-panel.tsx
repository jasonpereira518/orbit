"use client";

import Link from "next/link";
import { IntentLink } from "@/components/ui/intent-link";
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
import { safeHttpUrl, safeProfileUrl } from "@/lib/safe-links";
import { formatHowMetSummary } from "@/lib/met-context";
import { closenessTier as tierOfCloseness } from "@/lib/closeness";
import { CLOSENESS_TIER_TONE } from "@/components/contacts/closeness-tone";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import {
  GitHubGlyph,
  LinkedInGlyph,
  XGlyph,
} from "@/components/contacts/contact-profile-icons";
import { Badge } from "@/components/ui/badge";
import { RING_LABELS, type GraphNodeData } from "@/lib/graph-layout";
import type { UserSocialLinks } from "@/actions/graph";
import { friendlyError } from "@/lib/errors";
import { TOAST_COPY } from "@/lib/toast-copy";

export type InspectSelection =
  | { type: "contact"; id: string; data: GraphNodeData }
  | {
      type: "user";
      data: GraphNodeData;
      summary: {
        total: number;
        companyCount: number;
        scoreCounts: Record<number, number>;
        strongTies?: number;
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

/** Same tier → tone map as the list and the profile, so a star reads the same when opened. */
function closenessTone(
  closeness: number | undefined,
  tier: "inner" | "mid" | "outer" | undefined
) {
  const resolved = tier ?? (typeof closeness === "number" ? tierOfCloseness(closeness) : undefined);
  return resolved ? CLOSENESS_TIER_TONE[resolved] : "neutral";
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
              "inline-flex size-9 items-center justify-center rounded-full border border-border-subtle bg-card text-muted-foreground transition-colors",
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
        className="w-full overflow-y-auto border-l border-border-subtle bg-card sm:max-w-md"
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
  // Values saved before saves were normalised can still be anything typed into the field.
  const stored = summary.socialLinks || {};
  const socials = {
    linkedin: safeProfileUrl(stored.linkedin),
    twitter: safeProfileUrl(stored.twitter),
    github: safeProfileUrl(stored.github),
    website: safeProfileUrl(stored.website),
  };
  const hasSocials = Boolean(
    socials.linkedin || socials.twitter || socials.github || socials.website
  );
  const goals = summary.goals || [];

  return (
    <>
      <SheetHeader className="border-b border-border-subtle pb-4">
        <div className="flex items-start gap-3 pr-8">
          {summary.userImageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={summary.userImageUrl}
              alt=""
              className="size-14 rounded-full border border-primary/20 object-cover"
            />
          ) : (
            // The sun, as the chart draws it: a warm disc. The gradient is a canvas colour,
            // not a UI token, which is why it stays literal here.
            <div className="flex size-14 items-center justify-center rounded-full bg-[radial-gradient(circle_at_30%_30%,#fff,#f5c86a_55%,#e09030)] text-sm font-semibold text-[#3a2708]">
              {data.initials}
            </div>
          )}
          <div className="min-w-0">
            <SheetTitle className="font-heading text-2xl text-ink">
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
          <div className="rounded-lg border border-border-subtle bg-surface-inset p-3">
            <p className="text-lg font-medium text-ink">
              {summary.companyCount}
            </p>
            <p className="text-xs text-muted-foreground">companies</p>
          </div>
          <div className="rounded-lg border border-border-subtle bg-surface-inset p-3">
            <p className="text-lg font-medium text-ink">
              {summary.strongTies ?? 0}
            </p>
            <p className="text-xs text-muted-foreground">strong ties</p>
          </div>
          <div className="rounded-lg border border-border-subtle bg-surface-inset p-3">
            <p className="text-lg font-medium text-signal">
              {summary.dormantCount ?? 0}
            </p>
            <p className="text-xs text-muted-foreground">drifting comets</p>
          </div>
          <div className="rounded-lg border border-border-subtle bg-surface-inset p-3">
            <p className="text-lg font-medium text-ink">
              {summary.overdueCount ?? 0}
            </p>
            <p className="text-xs text-muted-foreground">overdue follow-ups</p>
          </div>
        </div>

        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
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
                <span className="text-ink">
                  {summary.scoreCounts[score] || 0}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Socials
            </p>
            <Link
              href="/settings"
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary"
            >
              <Settings className="size-3" aria-hidden />
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
          <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Focus & goals
          </p>
          {goals.length > 0 ? (
            <ul className="space-y-2">
              {goals.map((g) => (
                <li
                  key={g.id}
                  className="rounded-lg border border-border-subtle bg-surface-inset px-3 py-2 text-sm text-foreground/90"
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

  /**
   * Opening a star is a deliberate single-contact view, so it is the right place to resolve
   * a missing photo on demand (`ContactAvatar` then asks the same-origin avatar route, which
   * serves inline photos as bytes and proxies remote ones).
   */
  const canResolvePhoto = Boolean(data.linkedinUrl?.trim() || data.email?.trim());
  /** Their profile when we have it; otherwise the LinkedIn search you would have typed. */
  const linkedinHref =
    data.linkedinUrl?.trim() ||
    `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(
      [data.fullName || data.label, data.company].filter(Boolean).join(" ")
    )}`;

  const howMet = formatHowMetSummary({
    metContext: data.metContext,
    dateMet: data.dateMet,
    howMet: data.howMet,
  });

  return (
    <>
      <SheetHeader className="border-b border-border-subtle pb-4">
        <div className="flex items-start gap-3 pr-8">
          {/* The same avatar as the list and the profile. Comet and overdue state is
              spelled out in words by the chips directly below, so no ring repeats it. */}
          <ContactAvatar
            contactId={id}
            fullName={data.fullName || data.label}
            profileImageUrl={data.profileImageUrl}
            resolveOnDemand={canResolvePhoto}
            size="lg"
            className="size-14 shrink-0"
          />
          <div className="min-w-0">
            {/* The wrapper is already `min-w-0`, but that only lets flex shrink it — a
                single unbroken token still overflows without `break-words`. A long name
                ran off the right edge of the mobile sheet header. */}
            <SheetTitle className="font-heading text-2xl break-words text-ink">
              {data.label}
            </SheetTitle>
            {data.fullName &&
              data.preferredName &&
              data.preferredName !== data.fullName && (
                <p className="text-xs break-words text-muted-foreground">
                  {data.fullName}
                </p>
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
          <Badge tone={closenessTone(data.closeness, data.closenessTier)}>
            {RING_LABELS[data.score || 2] || "Orbit"}
            {typeof data.closeness === "number"
              ? ` · ${Math.round(data.closeness * 100)}%`
              : ` · ${data.score}/5`}
          </Badge>
          {data.comet && (
            <Badge className="bg-signal/15 text-signal">Drifting comet</Badge>
          )}
          {data.overdue && <Badge tone="warning">Follow-up overdue</Badge>}
        </div>

        {(data.tags || []).length > 0 && (
          <div>
            <p className="mb-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Tags
            </p>
            <div className="flex flex-wrap gap-1.5">
              {data.tags!.map((tag) => (
                <span
                  key={tag}
                  className="rounded-md border border-border-subtle bg-surface-inset px-2 py-0.5 text-xs"
                >
                  {tag}
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="grid gap-2 text-sm">
          <div className="flex justify-between gap-4 border-b border-border-subtle py-2">
            {/* "Last interaction" only when one was actually logged — otherwise this row
                is reporting the import stamp, and would contradict the empty timeline
                on the full profile. */}
            <span className="text-muted-foreground">
              {data.hasLoggedInteraction ? "Last interaction" : "In your contacts"}
            </span>
            <span className="text-right text-ink">
              {formatMaybeRelative(data.lastInteractionAt) ||
                formatMaybeDate(data.lastInteractionAt) ||
                "Never"}
            </span>
          </div>
          <div className="flex justify-between gap-4 border-b border-border-subtle py-2">
            <span className="text-muted-foreground">Next follow-up</span>
            <span className="text-right text-ink">
              {formatMaybeDate(data.nextFollowUpAt) || "None"}
            </span>
          </div>
          {howMet && (
            <div className="border-b border-border-subtle py-2">
              <p className="text-muted-foreground">How you met</p>
              <p className="mt-1 text-ink">{howMet}</p>
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
            {safeHttpUrl(data.linkedinUrl) && (
              <a
                href={safeHttpUrl(data.linkedinUrl)!}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
              >
                LinkedIn
              </a>
            )}
            {safeHttpUrl(data.website) && (
              <a
                href={safeHttpUrl(data.website)!}
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
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
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
                    if (res.aiError) {
                      toast.error(res.aiError);
                    } else if (res.summary) {
                      setSummaryText(res.summary);
                      onContactPatch?.(id, { aiSummary: res.summary });
                      toast.success("Summary updated");
                    } else {
                      toast.error(TOAST_COPY.summaryFailed);
                    }
                    onRefresh();
                  } catch (err) {
                    toast.error(
                      friendlyError(err, TOAST_COPY.summaryFailed)
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
            <p className="mb-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
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

      <SheetFooter className="gap-2 border-t border-border-subtle sm:flex-col">
        <EasyFollowUp
          contactId={id}
          contactName={data.preferredName || data.fullName}
          nextFollowUpAt={data.nextFollowUpAt}
          className="w-full rounded-lg border border-border-subtle bg-surface-inset p-3"
          onScheduled={(dueDate) => {
            onContactPatch?.(id, {
              nextFollowUpAt: dueDate,
              overdue: false,
            });
            onRefresh();
          }}
        />
        <div className="flex w-full items-stretch gap-2">
          <IntentLink
            href={`/contacts/${id}`}
            className={cn(
              buttonVariants(),
              "flex-1"
            )}
          >
            Open full profile
          </IntentLink>
          {/*
            Straight to LinkedIn, the logo alone: their saved profile when there is one, and a
            LinkedIn search for their name and company when there is not.
          */}
          <Tooltip>
            <TooltipTrigger
              render={
                <a
                  href={linkedinHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={
                    data.linkedinUrl
                      ? `Open ${data.label}'s LinkedIn profile`
                      : `Search LinkedIn for ${data.label}`
                  }
                  className={cn(
                    buttonVariants({ variant: "outline", size: "icon" }),
                    "shrink-0"
                  )}
                />
              }
            >
              <LinkedInGlyph className="size-4" />
            </TooltipTrigger>
            <TooltipContent side="top">
              {data.linkedinUrl ? "LinkedIn profile" : "Search on LinkedIn"}
            </TooltipContent>
          </Tooltip>
        </div>
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
