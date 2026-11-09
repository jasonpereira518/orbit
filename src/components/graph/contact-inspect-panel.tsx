"use client";

import Link from "next/link";
import { IntentLink } from "@/components/ui/intent-link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { format, formatDistanceToNow } from "date-fns";
import {
  CalendarClock,
  Globe,
  Mail,
  PenLine,
  Phone,
  Settings,
  X,
} from "lucide-react";
import { toast } from "@/lib/toast";
import { regenerateContactSummary } from "@/actions/contacts";
import { EasyFollowUp } from "@/components/follow-up/easy-follow-up";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { avatarRouteUrl } from "@/lib/contact-avatar-url";
import { safeHttpUrl, safeProfileUrl } from "@/lib/safe-links";
import { formatHowMetSummary } from "@/lib/met-context";
import {
  closenessPercentChipClass,
  closenessTierChipClass,
} from "@/lib/closeness";
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

function closenessChipClass(
  closeness: number | undefined,
  tier: "inner" | "mid" | "outer" | undefined,
) {
  if (typeof closeness === "number")
    return closenessPercentChipClass(closeness);
  if (!tier) return "bg-muted text-muted-foreground";
  return closenessTierChipClass(tier);
}

function LinkedInGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
      className={className}
    >
      <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
    </svg>
  );
}

function GitHubGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
      className={className}
    >
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

function XGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
      className={className}
    >
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.227-8.26L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

/** The selected star's cluster, as the card's chip shows it. */
export type InspectCluster = { id: string; name: string; color?: string };
/** A neighbour in the same cluster, ready to open as its own selection. */
export type InspectNeighbour = { id: string; data: GraphNodeData };

/**
 * A floating glass card over the sky, not a modal sheet: the sky stays pannable and
 * clickable behind it, and clicking another star swaps what it shows. It lives inside the
 * graph stage, so it also shows in fullscreen. Always dark-scoped — the sky is deep space
 * whatever the app theme, and light glass over it went muddy grey.
 */
export function ContactInspectPanel({
  selection,
  onClose,
  onContactPatch,
  cluster,
  nearby,
  onFocusCluster,
  onSelectContact,
}: {
  selection: InspectSelection;
  onClose: () => void;
  onContactPatch?: (id: string, patch: Partial<GraphNodeData>) => void;
  cluster?: InspectCluster | null;
  nearby?: InspectNeighbour[];
  onFocusCluster?: (clusterId: string) => void;
  onSelectContact?: (id: string, data: GraphNodeData) => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const cardRef = useRef<HTMLElement>(null);
  const open = selection !== null;
  const titleId = useId();

  // Focus moves into the card when it opens and back to whatever opened it (the canvas)
  // when it closes — but swapping stars keeps focus where it is.
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    cardRef.current?.focus({ preventScroll: true });
    return () => {
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [open]);

  if (!selection) return null;

  return (
    <div
      className={cn(
        "dark pointer-events-none absolute z-30 flex",
        // Below lg the card docks to the bottom, clear of the corner buttons; from lg it
        // floats on the right between the top and bottom toolbars.
        "inset-x-2 top-[40%] bottom-14 items-end",
        "lg:inset-x-auto lg:right-3 lg:top-14 lg:bottom-14 lg:w-[24rem] lg:items-start",
      )}
    >
      <section
        ref={cardRef}
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={(e) => {
          // React bubbles events out of portals (the follow-up popover), so only an Escape
          // pressed in the card itself closes it.
          if (e.key !== "Escape") return;
          if (!e.currentTarget.contains(e.target as Node)) return;
          e.stopPropagation();
          onClose();
        }}
        className={cn(
          "liquid-glass pointer-events-auto flex max-h-full w-full flex-col rounded-2xl text-foreground outline-none",
          "animate-in fade-in-0 slide-in-from-bottom-3 duration-base ease-house lg:slide-in-from-bottom-0 lg:slide-in-from-right-4",
        )}
      >
        {/* `.liquid-glass > *` pins its children to `position: relative` (unlayered, so it
            beats `absolute`); one wrapper down, the close button can sit in the corner. */}
        <div className="flex min-h-0 flex-1 flex-col">
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="absolute right-3 top-3 z-10 inline-flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <X className="size-4" />
          </button>
          <TooltipProvider>
            {selection.type === "user" && (
              <YouPanelBody
                titleId={titleId}
                summary={selection.summary}
                data={selection.data}
              />
            )}

            {selection.type === "contact" && (
              <ContactPanelBody
                key={selection.id}
                titleId={titleId}
                id={selection.id}
                data={selection.data}
                pending={pending}
                start={start}
                cluster={cluster ?? null}
                nearby={nearby ?? []}
                onFocusCluster={onFocusCluster}
                onSelectContact={onSelectContact}
                onContactPatch={onContactPatch}
                onRefresh={() => router.refresh()}
              />
            )}
          </TooltipProvider>
        </div>
      </section>
    </div>
  );
}

const SECTION_LABEL =
  "mb-1.5 text-3xs font-medium uppercase tracking-[0.14em] text-muted-foreground";

function YouPanelBody({
  titleId,
  data,
  summary,
}: {
  titleId: string;
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
    socials.linkedin || socials.twitter || socials.github || socials.website,
  );
  const goals = summary.goals || [];
  const stats = [
    { value: summary.companyCount, label: "companies" },
    { value: summary.strongTies ?? 0, label: "strong ties" },
    {
      value: summary.dormantCount ?? 0,
      label: "drifting comets",
      tone: "text-[#ff8a6b]",
    },
    { value: summary.overdueCount ?? 0, label: "overdue follow-ups" },
  ];

  return (
    <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain p-4">
      <header className="flex items-center gap-3 pr-8">
        {summary.userImageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={summary.userImageUrl}
            alt=""
            className="size-14 shrink-0 rounded-full border border-[#f5c86a]/40 object-cover shadow-[0_0_24px_rgba(255,200,100,0.35)]"
          />
        ) : (
          <div className="flex size-14 shrink-0 items-center justify-center rounded-full bg-[radial-gradient(circle_at_30%_30%,#fff,#f5c86a_55%,#e09030)] text-sm font-semibold text-[#3a2708] shadow-[0_0_24px_rgba(255,200,100,0.45)]">
            {data.initials}
          </div>
        )}
        <div className="min-w-0">
          <h2
            id={titleId}
            className="font-[family-name:var(--font-display)] text-2xl leading-tight break-words text-foreground"
          >
            {data.label}
          </h2>
          <p className="truncate text-sm text-muted-foreground">
            {summary.userEmail || "Center of your solar system"}
          </p>
        </div>
      </header>

      <div className="flex items-baseline gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-3.5 py-3">
        <span className="font-[family-name:var(--font-display)] text-3xl text-[#f2c14e]">
          {summary.total}
        </span>
        <span className="text-sm text-muted-foreground">people in orbit</span>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {stats.map((s) => (
          <div
            key={s.label}
            className="rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2.5"
          >
            <p className={cn("text-lg font-medium text-foreground", s.tone)}>
              {s.value}
            </p>
            <p className="text-xs text-muted-foreground">{s.label}</p>
          </div>
        ))}
      </div>

      <div>
        <p className={SECTION_LABEL}>By orbit</p>
        <ul className="space-y-0.5 text-sm">
          {[5, 4, 3, 2, 1].map((score) => (
            <li
              key={score}
              className="flex items-center justify-between rounded-lg px-1 py-1"
            >
              <span>
                {RING_LABELS[score]}
                <span className="ml-1.5 text-xs text-muted-foreground">
                  ({score})
                </span>
              </span>
              <span className="tabular-nums text-foreground">
                {summary.scoreCounts[score] || 0}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <p className={cn(SECTION_LABEL, "mb-0")}>Socials</p>
          <Link
            href="/settings"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary"
          >
            <Settings className="h-3 w-3" />
            Edit
          </Link>
        </div>
        {hasSocials ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {socials.linkedin ? (
              <IconAction href={socials.linkedin} label="LinkedIn" external>
                <LinkedInGlyph className="size-4" />
              </IconAction>
            ) : null}
            {socials.twitter ? (
              <IconAction href={socials.twitter} label="X / Twitter" external>
                <XGlyph className="size-4" />
              </IconAction>
            ) : null}
            {socials.github ? (
              <IconAction href={socials.github} label="GitHub" external>
                <GitHubGlyph className="size-4" />
              </IconAction>
            ) : null}
            {socials.website ? (
              <IconAction href={socials.website} label="Website" external>
                <Globe className="size-4" />
              </IconAction>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Add your social links in Settings to show them here.
          </p>
        )}
      </div>

      <div>
        <p className={SECTION_LABEL}>Focus & goals</p>
        {goals.length > 0 ? (
          <ul className="space-y-1.5">
            {goals.map((g) => (
              <li
                key={g.id}
                className="rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-foreground/90"
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
  );
}

const ICON_ACTION_CLASS = cn(
  "inline-flex size-9 items-center justify-center rounded-full border border-white/12 bg-white/[0.05] text-muted-foreground transition-colors",
  "hover:border-white/25 hover:bg-white/10 hover:text-foreground",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
  "aria-pressed:border-[#f2c14e]/50 aria-pressed:bg-[#f2c14e]/15 aria-pressed:text-[#f2c14e]",
);

/** One round icon in the card's action row: a link, or a toggle when `onClick` is given. */
function IconAction({
  label,
  href,
  external,
  onClick,
  pressed,
  children,
}: {
  label: string;
  href?: string;
  external?: boolean;
  onClick?: () => void;
  pressed?: boolean;
  children: React.ReactNode;
}) {
  const trigger = href ? (
    external ? (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={label}
        className={ICON_ACTION_CLASS}
      />
    ) : (
      <Link href={href} aria-label={label} className={ICON_ACTION_CLASS} />
    )
  ) : (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      onClick={onClick}
      className={ICON_ACTION_CLASS}
    />
  );
  return (
    <Tooltip>
      <TooltipTrigger render={trigger}>{children}</TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}

/** A neighbour's face: their stored photo when there is one, initials otherwise. */
function NeighbourFace({ id, data }: InspectNeighbour) {
  const [failed, setFailed] = useState(false);
  const src =
    !failed && data.profileImageUrl?.trim()
      ? avatarRouteUrl(id, data.profileImageUrl)
      : null;
  return src ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      onError={() => setFailed(true)}
      className="size-full rounded-full object-cover"
    />
  ) : (
    <span className="flex size-full items-center justify-center rounded-full bg-primary/80 text-3xs font-semibold text-primary-foreground">
      {data.initials}
    </span>
  );
}

function ContactPanelBody({
  titleId,
  id,
  data,
  pending,
  start,
  cluster,
  nearby,
  onFocusCluster,
  onSelectContact,
  onContactPatch,
  onRefresh,
}: {
  titleId: string;
  id: string;
  data: GraphNodeData;
  pending: boolean;
  start: (fn: () => void | Promise<void>) => void;
  cluster: InspectCluster | null;
  nearby: InspectNeighbour[];
  onFocusCluster?: (clusterId: string) => void;
  onSelectContact?: (id: string, data: GraphNodeData) => void;
  onContactPatch?: (id: string, patch: Partial<GraphNodeData>) => void;
  onRefresh: () => void;
}) {
  // Keyed by contact by the caller, so this state starts fresh for every star.
  const [summaryText, setSummaryText] = useState(data.aiSummary ?? null);
  const [photoFailed, setPhotoFailed] = useState(false);
  const [followUpOpen, setFollowUpOpen] = useState(false);

  useEffect(() => {
    setSummaryText(data.aiSummary ?? null);
  }, [data.aiSummary]);

  /**
   * Always the same-origin avatar route, never the stored URL directly: it serves inline
   * photos as bytes and proxies remote ones, so LinkedIn CDN images (which refuse
   * hotlinking) and `data:` URLs both load. Opening a star is a deliberate single-contact
   * view, so it is also the right place to resolve a missing photo on demand.
   */
  const canResolvePhoto = Boolean(
    data.linkedinUrl?.trim() || data.email?.trim(),
  );
  /** Their profile when we have it; otherwise the LinkedIn search you would have typed. */
  const linkedinHref =
    safeHttpUrl(data.linkedinUrl) ||
    `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(
      [data.fullName || data.label, data.company].filter(Boolean).join(" "),
    )}`;
  const website = safeHttpUrl(data.website);
  const photoSrc =
    !photoFailed && (Boolean(data.profileImageUrl?.trim()) || canResolvePhoto)
      ? avatarRouteUrl(id, data.profileImageUrl)
      : null;

  const howMet = formatHowMetSummary({
    metContext: data.metContext,
    dateMet: data.dateMet,
    howMet: data.howMet,
  });
  // "Last interaction" only when one was actually logged — otherwise the stamp is the
  // import date, and would contradict the empty timeline on the full profile.
  const lastTouch =
    formatMaybeRelative(data.lastInteractionAt) ||
    formatMaybeDate(data.lastInteractionAt) ||
    "Never";
  const nextTouch = formatMaybeDate(data.nextFollowUpAt);

  const regenerate = () =>
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
        toast.error(friendlyError(err, TOAST_COPY.summaryFailed));
      }
    });

  return (
    <>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-4 pb-3">
        <header className="flex items-center gap-3 pr-8">
          {photoSrc ? (
            // The photo stands on its own: comet and overdue state is spelled out in
            // words by the chips below, so a ring here would only repeat it.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={photoSrc}
              alt=""
              onError={() => setPhotoFailed(true)}
              className="size-14 shrink-0 rounded-full border border-white/15 object-cover shadow-[0_0_22px_rgba(124,195,226,0.25)]"
            />
          ) : (
            <div
              className={cn(
                "flex size-14 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white",
                "bg-[radial-gradient(circle_at_30%_30%,rgba(255,255,255,0.35),transparent_42%)] bg-[#0f3d3e]",
                data.comet && "bg-[#c4452d] ring-2 ring-[#ff6b4a]/60",
                data.overdue && !data.comet && "ring-2 ring-[#c4a35a]",
              )}
            >
              {data.initials}
            </div>
          )}
          <div className="min-w-0">
            {/* `min-w-0` lets flex shrink it, but a single unbroken token still needs
                `break-words` or a long name runs off the card. */}
            <h2
              id={titleId}
              className="font-[family-name:var(--font-display)] text-2xl leading-tight break-words text-foreground"
            >
              {data.label}
            </h2>
            {data.fullName &&
              data.preferredName &&
              data.preferredName !== data.fullName && (
                <p className="text-xs break-words text-muted-foreground">
                  {data.fullName}
                </p>
              )}
            <p className="text-sm break-words text-muted-foreground">
              {[data.title, data.company].filter(Boolean).join(" · ") ||
                "Contact in your network"}
            </p>
            {data.school && (
              <p className="text-xs text-muted-foreground">{data.school}</p>
            )}
          </div>
        </header>

        <div className="flex flex-wrap gap-1.5">
          <span
            className={cn(
              "rounded-full px-2.5 py-0.5 text-xs font-medium",
              closenessChipClass(data.closeness, data.closenessTier),
            )}
          >
            {RING_LABELS[data.score || 2] || "Orbit"}
            {typeof data.closeness === "number"
              ? ` · ${Math.round(data.closeness * 100)}%`
              : ` · ${data.score}/5`}
          </span>
          {data.comet && (
            <span className="rounded-full bg-[#c4452d]/20 px-2.5 py-0.5 text-xs font-medium text-[#ff8a6b]">
              Drifting comet
            </span>
          )}
          {data.overdue && (
            <span className="rounded-full bg-[#f2c14e]/15 px-2.5 py-0.5 text-xs font-medium text-[#f2c14e]">
              Follow-up overdue
            </span>
          )}
        </div>

        {(cluster || nearby.length > 0) && (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-2.5 py-2">
            {cluster && (
              <button
                type="button"
                onClick={() => onFocusCluster?.(cluster.id)}
                className="inline-flex min-w-0 items-center gap-1.5 rounded-full px-1.5 py-0.5 text-sm transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                aria-label={`Fly to the ${cluster.name} cluster`}
              >
                <span
                  aria-hidden
                  className="size-2 shrink-0 rounded-full"
                  style={{
                    background: cluster.color,
                    boxShadow: cluster.color
                      ? `0 0 8px ${cluster.color}`
                      : undefined,
                  }}
                />
                <span className="truncate" style={{ color: cluster.color }}>
                  {cluster.name}
                </span>
              </button>
            )}
            {nearby.length > 0 && (
              <div className="ml-auto flex items-center">
                <span className="mr-2 text-3xs uppercase tracking-[0.14em] text-muted-foreground">
                  Nearby
                </span>
                <ul className="flex -space-x-1.5">
                  {nearby.map((n) => (
                    <li key={n.id}>
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <button
                              type="button"
                              onClick={() => onSelectContact?.(n.id, n.data)}
                              aria-label={`Open ${n.data.label}`}
                              className="relative block size-7 rounded-full ring-2 ring-[#141820] transition-transform hover:z-10 hover:-translate-y-0.5 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-ring"
                            />
                          }
                        >
                          <NeighbourFace id={n.id} data={n.data} />
                        </TooltipTrigger>
                        <TooltipContent side="top">
                          {n.data.label}
                        </TooltipContent>
                      </Tooltip>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        <dl className="grid grid-cols-2 gap-2 text-sm">
          <div className="rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2">
            <dt className="text-xs text-muted-foreground">
              {data.hasLoggedInteraction ? "Last touch" : "In your network"}
            </dt>
            <dd className="text-foreground">{lastTouch}</dd>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2">
            <dt className="text-xs text-muted-foreground">Next follow-up</dt>
            <dd
              className={cn(
                "text-foreground",
                data.overdue && "text-[#f2c14e]",
              )}
            >
              {nextTouch || "None"}
            </dd>
          </div>
          {howMet && (
            <div className="col-span-2 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2">
              <dt className="text-xs text-muted-foreground">How you met</dt>
              <dd className="text-foreground">{howMet}</dd>
            </div>
          )}
        </dl>

        <div>
          <div className="mb-1 flex items-center justify-between gap-2">
            <p className={cn(SECTION_LABEL, "mb-0")}>Who they are</p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              disabled={pending}
              onClick={regenerate}
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

        {(data.tags || []).length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {data.tags!.map((tag) => (
              <span
                key={tag}
                className="rounded-md border border-white/10 bg-white/[0.05] px-2 py-0.5 text-xs text-foreground/85"
              >
                {tag}
              </span>
            ))}
          </div>
        )}

        {(data.keyFacts || []).length > 0 && (
          <div>
            <p className={SECTION_LABEL}>Key facts</p>
            <ul className="space-y-1 text-sm text-foreground/90">
              {data.keyFacts!.map((fact) => (
                <li key={fact} className="flex gap-2">
                  <span
                    aria-hidden
                    className="mt-[0.55em] size-1 shrink-0 rounded-full bg-[#f2c14e]"
                  />
                  {fact}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <footer className="space-y-2.5 border-t border-white/10 p-3">
        {followUpOpen && (
          <EasyFollowUp
            contactId={id}
            contactName={data.preferredName || data.fullName}
            nextFollowUpAt={data.nextFollowUpAt}
            className="w-full rounded-xl border border-white/10 bg-white/[0.04] p-3"
            onScheduled={(dueDate) => {
              onContactPatch?.(id, { nextFollowUpAt: dueDate, overdue: false });
              onRefresh();
            }}
          />
        )}
        <div className="flex items-center gap-1.5">
          {data.email && (
            <IconAction
              href={`mailto:${data.email}`}
              label={`Email ${data.label}`}
            >
              <Mail className="size-4" />
            </IconAction>
          )}
          {data.phone && (
            <IconAction href={`tel:${data.phone}`} label={`Call ${data.label}`}>
              <Phone className="size-4" />
            </IconAction>
          )}
          <IconAction
            href={linkedinHref}
            external
            label={data.linkedinUrl ? "LinkedIn profile" : "Search on LinkedIn"}
          >
            <LinkedInGlyph className="size-4" />
          </IconAction>
          {website && (
            <IconAction href={website} external label="Website">
              <Globe className="size-4" />
            </IconAction>
          )}
          <IconAction href={`/capture?contactId=${id}`} label="Log interaction">
            <PenLine className="size-4" />
          </IconAction>
          <IconAction
            label={followUpOpen ? "Hide follow-up" : "Schedule follow-up"}
            pressed={followUpOpen}
            onClick={() => setFollowUpOpen((v) => !v)}
          >
            <CalendarClock className="size-4" />
          </IconAction>
          <IntentLink
            href={`/contacts/${id}`}
            className={cn(
              buttonVariants({ size: "sm" }),
              "ml-auto h-9 rounded-full px-4",
            )}
          >
            Open profile
          </IntentLink>
        </div>
      </footer>
    </>
  );
}
