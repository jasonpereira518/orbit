"use client";

import {
  ArrowDown,
  Bell,
  CalendarDays,
  Check,
  Clock,
  Command,
  FileText,
  Mail,
  Mic,
  Plus,
  Puzzle,
  ScanLine,
  Send,
  Sparkles,
} from "lucide-react";
import { Stagger, StaggerItem } from "@/components/onboarding/onboarding-ui";
import { cn } from "@/lib/utils";
import {
  VIRGO_CHAINS as CHAINS,
  VIRGO_FIELD_STARS as FIELD_STARS,
  VIRGO_STARS as STARS,
} from "@/lib/virgo-figure";

/**
 * Hand-built mockups of each feature, one per highlight chapter. Mockups rather than
 * screenshots: they follow the theme, they never show a real person, and they cannot drift
 * out of date with a screenshot of last month's UI.
 *
 * Every card arrives through `StaggerItem`. Looping decoration is CSS keyframes only, so the
 * global reduced-motion clamp stops it and nothing here commits React state per frame.
 */

const card = "rounded-xl border border-border/60 bg-card shadow-[0_1px_2px_rgba(0,0,0,0.04)]";

function Initials({ name, tone = "primary" }: { name: string; tone?: "primary" | "gold" }) {
  const initials = name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2);
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold",
        tone === "primary" ? "bg-primary/12 text-primary" : "bg-amber-500/15 text-amber-700 dark:text-amber-300",
      )}
    >
      {initials}
    </span>
  );
}

export function CapturePreview() {
  const modes = [
    { icon: FileText, label: "Notes", active: true },
    { icon: Mic, label: "Voice" },
    { icon: CalendarDays, label: "Meeting" },
    { icon: ScanLine, label: "Scan" },
  ];
  return (
    <Stagger className="flex h-full flex-col gap-2.5">
      <StaggerItem className="flex gap-1 self-start rounded-lg border border-border/60 bg-muted/50 p-0.5">
        {modes.map(({ icon: Icon, label, active }) => (
          <span
            key={label}
            className={cn(
              "flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium",
              active ? "bg-card text-primary shadow-sm" : "text-muted-foreground",
            )}
          >
            <Icon className="size-3" aria-hidden />
            {label}
          </span>
        ))}
      </StaggerItem>
      <StaggerItem className={cn(card, "p-3")}>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Coffee with Sarah Chen after the AWS Summit. She runs partnerships at OpenAI and offered
          to intro me to their university recruiting lead, Diego. Follow up in two weeks…
        </p>
      </StaggerItem>
      <StaggerItem className="flex items-center justify-center gap-1.5 text-[11px] font-medium text-primary">
        <Sparkles className="size-3.5" aria-hidden />
        Orbit found 2 people and a follow-up
        <ArrowDown className="size-3" aria-hidden />
      </StaggerItem>
      <div className="grid grid-cols-2 gap-2">
        {[
          { name: "Sarah Chen", meta: "OpenAI · Partnerships" },
          { name: "Diego Alvarez", meta: "OpenAI · University recruiting" },
        ].map((p) => (
          <StaggerItem key={p.name} className={cn(card, "flex items-center gap-2 p-2.5")}>
            <Initials name={p.name} />
            <span className="min-w-0">
              <span className="block truncate text-xs font-medium text-ink">{p.name}</span>
              <span className="block truncate text-[10px] text-muted-foreground">{p.meta}</span>
            </span>
          </StaggerItem>
        ))}
      </div>
      <StaggerItem className="flex items-center gap-2 rounded-lg bg-accent/70 px-3 py-2 text-[11px] text-foreground">
        <Bell className="size-3.5 text-primary" aria-hidden />
        Follow up with Sarah Chen · in 14 days
      </StaggerItem>
    </Stagger>
  );
}

export function PeoplePreview() {
  return (
    <Stagger className="flex h-full flex-col gap-2.5">
      <StaggerItem className={cn(card, "p-3")}>
        <div className="flex items-center gap-3">
          <Initials name="Priya Nair" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-ink">Priya Nair</p>
            <p className="text-[11px] text-muted-foreground">Notion · Product, AI agents</p>
          </div>
          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
            Inner orbit
          </span>
        </div>
        <p className="mt-2.5 text-xs leading-relaxed text-muted-foreground">
          Met at the Notion campus night. Mentored your team&apos;s hackathon project and said to
          send her your internship application.
        </p>
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
            Referral offered
          </span>
          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
            Every 6 weeks
          </span>
          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
            Next: send application
          </span>
        </div>
      </StaggerItem>
      {[
        { name: "Marcus Lee", meta: "Stripe · Recruiting", tag: "Recruiter", gold: true },
        { name: "Jordan Kim", meta: "Figma · Design eng", tag: "3 notes" },
      ].map((p) => (
        <StaggerItem key={p.name} className={cn(card, "flex items-center gap-3 px-3 py-2.5")}>
          <Initials name={p.name} tone={p.gold ? "gold" : "primary"} />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-ink">{p.name}</p>
            <p className="text-[11px] text-muted-foreground">{p.meta}</p>
          </div>
          <span className="text-[10px] text-muted-foreground">{p.tag}</span>
        </StaggerItem>
      ))}
    </Stagger>
  );
}

export function FollowUpsPreview() {
  const reminders = [
    { title: "Send Priya your application", due: "Overdue 2 days", overdue: true },
    { title: "Thank Marcus for the intro", due: "Due tomorrow" },
    { title: "Check in with Jordan", due: "Due in 5 days" },
  ];
  return (
    <Stagger className="flex h-full flex-col gap-2.5">
      <StaggerItem className={cn(card, "border-primary/25 bg-primary/[0.04] p-3")}>
        <p className="text-[10px] font-medium uppercase tracking-wide text-primary">
          Suggested follow-up
        </p>
        <p className="mt-1 text-sm font-medium text-ink">Reach out to Sam Okafor</p>
        <p className="text-[11px] text-muted-foreground">
          Last talked 47 days ago · you usually catch up every month
        </p>
        <div className="mt-2 flex gap-1.5">
          <span className="rounded-md bg-primary px-2 py-1 text-[10px] font-medium text-primary-foreground">
            Draft a note
          </span>
          <span className="rounded-md border border-border/70 px-2 py-1 text-[10px] text-muted-foreground">
            Snooze
          </span>
        </div>
      </StaggerItem>
      {reminders.map((r) => (
        <StaggerItem key={r.title} className={cn(card, "flex items-center gap-3 px-3 py-2")}>
          <span className="flex size-4 shrink-0 items-center justify-center rounded-full border border-border" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium text-ink">{r.title}</p>
            <p
              className={cn(
                "text-[10px]",
                r.overdue ? "font-medium text-amber-700 dark:text-amber-300" : "text-muted-foreground",
              )}
            >
              {r.due}
            </p>
          </div>
          <Clock className="size-3.5 text-muted-foreground" aria-hidden />
        </StaggerItem>
      ))}
    </Stagger>
  );
}

export function AskPreview() {
  return (
    <Stagger className="flex h-full flex-col gap-2.5">
      <StaggerItem className="self-end rounded-2xl rounded-br-md bg-primary px-3 py-2 text-xs text-primary-foreground">
        Who could help me get an AI internship?
      </StaggerItem>
      <StaggerItem className={cn(card, "p-3")}>
        <p className="text-xs leading-relaxed text-foreground">
          Start with <span className="font-medium text-ink">Marcus Lee</span> — he recruits for
          Stripe&apos;s AI infra team and offered an intro last month.{" "}
          <span className="font-medium text-ink">Priya Nair</span> also said she&apos;d refer you
          at Notion.
        </p>
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {["Marcus Lee", "Priya Nair"].map((n) => (
            <span
              key={n}
              className="flex items-center gap-1 rounded-full border border-border/70 px-2 py-0.5 text-[10px] text-muted-foreground"
            >
              <span className="size-1.5 rounded-full bg-primary" aria-hidden />
              {n}
            </span>
          ))}
        </div>
      </StaggerItem>
      <StaggerItem className="mt-auto flex items-center gap-2 rounded-xl border border-border/70 bg-muted/40 px-3 py-2">
        <Sparkles className="size-3.5 text-primary" aria-hidden />
        <span className="flex-1 text-[11px] text-muted-foreground">Ask about your network…</span>
        <span className="flex items-center gap-0.5 rounded-md border border-border/70 bg-card px-1.5 py-0.5 text-[10px] text-muted-foreground">
          <Command className="size-2.5" aria-hidden />K
        </span>
      </StaggerItem>
    </Stagger>
  );
}

export function ConstellationPreview() {
  const byId = Object.fromEntries(STARS.map((s) => [s.id, s]));
  return (
    <Stagger className="relative h-full">
      <StaggerItem className="absolute inset-0 overflow-hidden rounded-xl border border-border/60 bg-[radial-gradient(ellipse_at_center,_#1a2030_0%,_#0a0c12_60%,_#05060a_100%)]">
        <svg viewBox="0 0 280 220" className="h-full w-full" role="img" aria-label="A network drawn as a constellation">
          {FIELD_STARS.map(([x, y], i) => (
            <circle key={`f-${i}`} cx={x} cy={y} r={0.85} fill="rgba(232,243,241,0.26)" />
          ))}
          {CHAINS.flatMap((chain) =>
            chain.slice(0, -1).map((a, i) => {
              const from = byId[a]!;
              const to = byId[chain[i + 1]!]!;
              return (
                <line
                  key={`${a}-${i}`}
                  x1={from.x}
                  y1={from.y}
                  x2={to.x}
                  y2={to.y}
                  stroke="rgba(89,157,231,0.5)"
                  strokeWidth={1.1}
                  strokeLinecap="round"
                />
              );
            }),
          )}
          {STARS.map((star, i) => (
            <circle
              key={star.id}
              cx={star.x}
              cy={star.y}
              r={star.r}
              fill={star.id === "spica" ? "#e8f3f1" : "#c5d4d1"}
              // One CSS animation per star, staggered by delay — no React state per frame.
              style={{
                animation: `constellation-twinkle ${2.6 + (i % 3) * 0.4}s ease-in-out ${i * 0.15}s infinite`,
              }}
            />
          ))}
        </svg>
      </StaggerItem>
      <StaggerItem className="absolute right-3 bottom-3 left-3 rounded-xl border border-white/10 bg-[#0f1420]/90 p-3 text-white sm:left-auto sm:w-56">
        <p className="text-[10px] font-medium uppercase tracking-wide text-sky-300">Event · Tomorrow</p>
        <p className="mt-0.5 text-xs font-medium">AI Founders Night</p>
        <p className="mt-1 text-[11px] text-white/70">3 people you know are going · talk to Priya first</p>
      </StaggerItem>
    </Stagger>
  );
}

export function OutreachPreview() {
  return (
    <Stagger className="flex h-full flex-col gap-2.5">
      <StaggerItem className={cn(card, "flex items-start justify-between gap-2 p-3")}>
        <div>
          <p className="text-sm font-medium text-ink">Summer internships · AI labs</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">14 people · 9 drafted · 5 sent · 2 replies</p>
        </div>
        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">Active</span>
      </StaggerItem>
      <StaggerItem className={cn(card, "p-3")}>
        <div className="flex items-center gap-2">
          <Initials name="Maya Patel" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-ink">To Maya Patel</p>
            <p className="text-[10px] text-muted-foreground">Anthropic · Research engineering</p>
          </div>
          <span className="flex items-center gap-1 text-[10px] text-primary">
            <Sparkles className="size-3" aria-hidden />
            AI draft
          </span>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-foreground">
          Hi Maya — I loved your talk on eval tooling at the Stanford AI club. I&apos;m exploring
          research engineering internships and would value 15 minutes of your advice…
        </p>
      </StaggerItem>
      <StaggerItem className="flex justify-end gap-1.5">
        <span className="rounded-md border border-border/70 px-2.5 py-1 text-[10px] text-muted-foreground">Edit</span>
        <span className="flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-[10px] font-medium text-primary-foreground">
          <Send className="size-3" aria-hidden />
          Send
        </span>
      </StaggerItem>
    </Stagger>
  );
}

export function EverywherePreview() {
  return (
    <Stagger className="flex h-full flex-col gap-2.5">
      <StaggerItem className={cn(card, "overflow-hidden")}>
        <div className="flex items-center gap-1.5 border-b border-border/60 bg-muted/40 px-2.5 py-1.5">
          <span className="size-2 rounded-full bg-red-400/70" aria-hidden />
          <span className="size-2 rounded-full bg-amber-400/70" aria-hidden />
          <span className="size-2 rounded-full bg-emerald-400/70" aria-hidden />
          <span className="ml-2 flex-1 truncate rounded bg-card px-2 py-0.5 text-[10px] text-muted-foreground">
            linkedin.com/in/diego-alvarez
          </span>
          <Puzzle className="size-3.5 text-primary" aria-hidden />
        </div>
        <div className="grid grid-cols-[1fr_9.5rem] gap-2 p-2.5">
          <div className="space-y-1.5">
            <div className="h-10 rounded-md bg-gradient-to-r from-sky-500/25 to-primary/20" />
            <div className="h-2 w-2/3 rounded bg-muted" />
            <div className="h-2 w-1/2 rounded bg-muted" />
            <div className="h-2 w-3/4 rounded bg-muted" />
          </div>
          <div className="rounded-lg border border-primary/25 bg-primary/[0.04] p-2">
            <p className="text-[10px] font-medium text-ink">Diego Alvarez</p>
            <p className="text-[9px] text-muted-foreground">Already in your orbit</p>
            <span className="mt-1.5 flex items-center justify-center gap-1 rounded-md bg-primary py-1 text-[9px] font-medium text-primary-foreground">
              <Plus className="size-2.5" aria-hidden />
              Add a note
            </span>
          </div>
        </div>
      </StaggerItem>
      <div className="grid grid-cols-3 gap-2">
        {[
          { label: "Google", sub: "Contacts" },
          { label: "Outlook", sub: "Contacts" },
          { label: "Gmail", sub: "Mail sync", icon: Mail },
        ].map((s) => (
          <StaggerItem key={s.label} className={cn(card, "px-2.5 py-2")}>
            <p className="text-[11px] font-medium text-ink">{s.label}</p>
            <p className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <Check className="size-2.5 text-primary" aria-hidden />
              {s.sub}
            </p>
          </StaggerItem>
        ))}
      </div>
      <StaggerItem className="rounded-lg bg-muted/60 px-3 py-2 font-mono text-[10px] text-muted-foreground">
        POST /api/v1/contacts · MCP · webhooks
      </StaggerItem>
    </Stagger>
  );
}
