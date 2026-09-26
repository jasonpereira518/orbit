"use client";

import { CalendarDays, Coffee, Mail, MessageSquare, Phone, StickyNote, UserRound, Users } from "lucide-react";
import { useId, type CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { LOOKS, initials, tierOf, type DemoPerson, type Look, type SuggestionReason, type TimelineSource, type TimelineType } from "./demo-cast";

/**
 * The app's dark theme, copied as values from `globals.css` `.dark`, scoped to the demo so
 * it looks like the real app whatever the page around it does.
 */
export const DEMO_TOKENS = {
  "--d-bg": "#0e1524",
  "--d-card": "#1a2438",
  "--d-card-2": "#212c42",
  "--d-muted": "#151d2f",
  "--d-border": "#333f5a",
  "--d-ink": "#e4ebf6",
  "--d-dim": "#96a8c4",
  "--d-primary": "#7cc3e2",
  "--d-primary-ink": "#04121b",
  "--d-sidebar": "#080d18",
} as CSSProperties;

export const CARD = "rounded-2xl border border-[var(--d-border)]/70 bg-[var(--d-card)]/80";
export const DISPLAY = "font-[family-name:var(--font-display)] tracking-tight text-[var(--d-ink)]";
export const BTN =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-[var(--d-border)] bg-[var(--d-card-2)] px-2.5 py-1.5 text-xs font-medium text-[var(--d-ink)] transition-colors hover:border-[var(--d-primary)]/50 hover:bg-[var(--d-card-2)]/70";
export const BTN_PRIMARY =
  "inline-flex items-center justify-center gap-1.5 rounded-lg bg-[var(--d-primary)] px-2.5 py-1.5 text-xs font-medium text-[var(--d-primary-ink)] transition-opacity hover:opacity-90";
export const INPUT =
  "w-full rounded-lg border border-[var(--d-border)] bg-[var(--d-muted)] px-3 py-2 text-sm text-[var(--d-ink)] placeholder:text-[var(--d-dim)]/70 focus:border-[var(--d-primary)]/60 focus:outline-none";

/** Hair drawn behind the head (length that falls past it). */
function HairBack({ look }: { look: Look }) {
  const f = look.hair;
  switch (look.style) {
    case "long":
      return <path d="M18 28C18 14 25 9 32 9s14 5 14 19l2 21c-5 3-9 2-11 1V31H27v19c-2 1-6 2-11-1z" fill={f} />;
    case "wavy":
      return <path d="M18 28C17 14 25 9 32 9s15 5 14 19c1 6 3 10 1 15-3 3-7 2-9 0V31H26v12c-2 2-6 3-9 0-2-5 0-9 1-15z" fill={f} />;
    case "bob":
      return <path d="M19 28C18 14 25 10 32 10s14 4 13 18l1 12c-3 2-6 2-8 0V31H26v9c-2 2-5 2-8 0z" fill={f} />;
    case "curly":
      return (
        <g fill={f}>
          {[
            [21, 18, 7],
            [27, 12, 7],
            [34, 10, 7.5],
            [41, 14, 7],
            [45, 21, 6.5],
            [19, 26, 6],
            [46, 29, 5.5],
            [20, 34, 5],
            [45, 36, 5],
          ].map(([cx, cy, r], i) => (
            <circle key={i} cx={cx} cy={cy} r={r} />
          ))}
        </g>
      );
    default:
      return null;
  }
}

/** Hair drawn over the head (fringe, crown, bun). */
function HairFront({ look }: { look: Look }) {
  const f = look.hair;
  switch (look.style) {
    case "short":
      return <path d="M20.5 27c-1-11 5-16 11.5-16 7 0 12.5 4 11.5 16-1.5-5-5-8-11-8.5-6 0-10 3-12 8.5z" fill={f} />;
    case "buzz":
      return <path d="M21 25c0-9 5-13 11-13s11 4 11 13c-2-4-6-6.5-11-6.5S23 21 21 25z" fill={f} opacity={0.9} />;
    case "bun":
      return (
        <g fill={f}>
          <circle cx={32} cy={8.5} r={5.5} />
          <path d="M20.5 27c-1-11 5-15.5 11.5-15.5S44.5 16 43.5 27c-2-6-6-8.5-11.5-8.5S22.5 21 20.5 27z" />
        </g>
      );
    case "long":
    case "wavy":
    case "bob":
      return <path d="M20.5 28c-.5-11 5-16 11.5-16s12 5 11.5 16c-3-6-8-8.5-14-8-3 .5-6 3-9 8z" fill={f} />;
    default:
      return null;
  }
}

/**
 * The cast's portraits: illustrated, drawn in SVG from `LOOKS`, so the demo carries no
 * photos of anyone real and requests no images the waitlist host would redirect.
 */
export function Avatar({ person, size = 32, className }: { person: DemoPerson; size?: number; className?: string }) {
  // Unique per instance: the same person can appear twice on one screen.
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const look = LOOKS[person.id];
  const h = person.hue;
  if (!look) {
    return (
      <span
        aria-hidden="true"
        className={cn("inline-flex shrink-0 items-center justify-center rounded-full font-medium text-white/95", className)}
        style={{ width: size, height: size, fontSize: Math.round(size * 0.38), background: `hsl(${h} 55% 45%)` }}
      >
        {initials(person)}
      </span>
    );
  }
  const clip = `demo-av-${uid}`;
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 64 64"
      width={size}
      height={size}
      className={cn("shrink-0 rounded-full ring-1 ring-white/10", className)}
    >
      <defs>
        <clipPath id={clip}>
          <circle cx={32} cy={32} r={32} />
        </clipPath>
        <linearGradient id={`${clip}-bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={`hsl(${h} 45% 34%)`} />
          <stop offset="100%" stopColor={`hsl(${(h + 40) % 360} 40% 20%)`} />
        </linearGradient>
      </defs>
      <g clipPath={`url(#${clip})`}>
        <rect width={64} height={64} fill={`url(#${clip}-bg)`} />
        <HairBack look={look} />
        <path d="M8 66c1-13 11-20 24-20s23 7 24 20z" fill={look.shirt} />
        <path d="M26 44c2 3 10 3 12 0l1 4c-4 3-10 3-14 0z" fill="#000" opacity={0.12} />
        <rect x={27} y={35} width={10} height={11} rx={4} fill={look.skin} />
        <ellipse cx={32} cy={27} rx={11} ry={12.5} fill={look.skin} />
        <ellipse cx={32} cy={36.5} rx={6} ry={2} fill="#000" opacity={0.08} />
        {look.beard && <path d="M21.5 29c1 8 5 11.5 10.5 11.5S41.5 37 42.5 29c-3 4-6 5-10.5 5s-7.5-1-10.5-5z" fill={look.hair} opacity={0.92} />}
        <circle cx={27.8} cy={27.5} r={1.25} fill="#1c1917" />
        <circle cx={36.2} cy={27.5} r={1.25} fill="#1c1917" />
        <path d="M28.8 33c1.9 1.5 4.5 1.5 6.4 0" stroke="#1c1917" strokeWidth={1.1} strokeLinecap="round" fill="none" opacity={0.55} />
        {look.glasses && (
          <g fill="none" stroke="#111827" strokeWidth={1.2} opacity={0.85}>
            <rect x={23.5} y={24.5} width={8} height={6} rx={2.2} />
            <rect x={32.5} y={24.5} width={8} height={6} rx={2.2} />
            <path d="M31.5 27h1" />
          </g>
        )}
        <HairFront look={look} />
      </g>
    </svg>
  );
}

const TIER_STYLE = {
  inner: { chip: "bg-emerald-400/15 text-emerald-200 ring-emerald-300/25", label: "Inner orbit" },
  mid: { chip: "bg-sky-400/15 text-sky-200 ring-sky-300/25", label: "Mid orbit" },
  outer: { chip: "bg-amber-400/15 text-amber-200 ring-amber-300/25", label: "Outer orbit" },
} as const;

export function TierBadge({ closeness }: { closeness: number }) {
  const t = TIER_STYLE[tierOf(closeness)];
  return <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-medium ring-1", t.chip)}>{t.label}</span>;
}

export function ClosenessChip({ closeness }: { closeness: number }) {
  const t = TIER_STYLE[tierOf(closeness)];
  return (
    <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium tabular-nums ring-1", t.chip)} title="Closeness">
      {closeness}%
    </span>
  );
}

const REASON_STYLE: Record<SuggestionReason, string> = {
  Dormant: "bg-amber-500/15 text-amber-200",
  "LinkedIn quiet": "bg-sky-500/15 text-sky-200",
  "Post-event": "bg-violet-500/15 text-violet-200",
  "Score bump": "bg-emerald-500/15 text-emerald-200",
};

export function ReasonPill({ reason }: { reason: SuggestionReason }) {
  return <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-medium", REASON_STYLE[reason])}>{reason}</span>;
}

export function LinkedInGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className} fill="currentColor">
      <path d="M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.35V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28zM5.34 7.43a2.06 2.06 0 1 1 0-4.13 2.06 2.06 0 0 1 0 4.13zM7.12 20.45H3.56V9h3.56v11.45zM22.22 0H1.77C.79 0 0 .77 0 1.73v20.54C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.73V1.73C24 .77 23.2 0 22.22 0z" />
    </svg>
  );
}

const SOURCE_STYLE: Record<TimelineSource, string> = {
  Gmail: "text-rose-200 bg-rose-400/10",
  "Google Calendar": "text-sky-200 bg-sky-400/10",
  LinkedIn: "text-blue-200 bg-blue-400/10",
  You: "text-[var(--d-dim)] bg-white/5",
};

export function SourceIcon({ source, className }: { source: TimelineSource; className?: string }) {
  if (source === "Gmail") return <Mail className={className} aria-hidden="true" />;
  if (source === "Google Calendar") return <CalendarDays className={className} aria-hidden="true" />;
  if (source === "LinkedIn") return <LinkedInGlyph className={className} />;
  return <UserRound className={className} aria-hidden="true" />;
}

export function SourceBadge({ source }: { source: TimelineSource }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium", SOURCE_STYLE[source])}>
      <SourceIcon source={source} className="size-3" />
      {source === "You" ? "Logged by you" : `via ${source}`}
    </span>
  );
}

const TYPE_ICON: Record<TimelineType, typeof Mail> = {
  Email: Mail,
  Meeting: Users,
  Call: Phone,
  LinkedIn: MessageSquare,
  "In person": Coffee,
  Note: StickyNote,
};

/** Interaction families, coloured like the app's `--interaction-*` tokens. */
const TYPE_TINT: Record<TimelineType, string> = {
  Meeting: "#f5cd7a",
  "In person": "#f5cd7a",
  Call: "#f5a3c0",
  Email: "#8aa9f2",
  LinkedIn: "#8aa9f2",
  Note: "#8f9db2",
};

export function TypeIcon({ type }: { type: TimelineType }) {
  const Icon = TYPE_ICON[type];
  return (
    <span
      className="inline-flex size-7 shrink-0 items-center justify-center rounded-full"
      style={{ background: `${TYPE_TINT[type]}22`, color: TYPE_TINT[type] }}
    >
      <Icon className="size-3.5" aria-hidden="true" />
    </span>
  );
}

export const TIMELINE_TYPES: TimelineType[] = ["Meeting", "Call", "Email", "In person", "LinkedIn", "Note"];
