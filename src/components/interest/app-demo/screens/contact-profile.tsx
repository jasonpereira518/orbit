"use client";

import { ArrowLeft, Bell, Calendar, Check, Mail, MessageSquare, Pencil, Plus, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { daysLabel, firstName, personById, tierOf } from "../demo-cast";
import { useDemo } from "../demo-context";
import { closenessOf, followUpOf, lastTouchOf, timelineOf } from "../demo-state";
import { Avatar, BTN, BTN_GHOST, CARD, DISPLAY, SourceBadge, TypeIcon, interactionOf } from "../demo-ui";

/**
 * The real contact profile (`contact-profile-hero.tsx`, `contact-stat-pills.tsx`,
 * `contact-brief-card.tsx`, `contact-follow-up-section.tsx`, `contact-timeline.tsx`), on the
 * cast. The floating ask bar carries the "Asking about {name}" chip, as in the app — it is the
 * tour's "Ask about her" button.
 */
const CARD_TITLE = cn(DISPLAY, "text-lg");

/** "Today" in the made-up workspace, so the timeline's dates never depend on the visitor's clock. */
const DEMO_TODAY = Date.UTC(2026, 8, 29);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function dateOf(daysAgo: number) {
  const d = new Date(DEMO_TODAY - daysAgo * 86_400_000);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

const CLOSENESS_TONE = {
  inner: "bg-emerald-500/15 text-emerald-300",
  mid: "bg-sky-500/15 text-sky-300",
  outer: "bg-amber-500/15 text-amber-300",
} as const;
const TIER_LABEL = { inner: "Inner", mid: "Mid", outer: "Outer" } as const;

export function ContactProfileScreen() {
  const { state, dispatch } = useDemo();
  const p = personById(state.profileId);
  if (!p) return null;
  const c = closenessOf(state, p);
  const tier = tierOf(c);
  const fu = followUpOf(state, p);
  const first = firstName(p);
  const backTo = { dashboard: "Dashboard", contacts: "Contacts", chat: "Chat", constellation: "Constellation" }[state.prevScreen];
  const timeline = timelineOf(state, p);
  const pill = "inline-flex h-7 items-center rounded-full px-3 text-sm";

  return (
    <div className="space-y-6">
      <button type="button" onClick={() => dispatch({ type: "back" })} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-ink">
        <ArrowLeft className="size-3.5" aria-hidden="true" />
        {backTo}
      </button>

      <header className="flex items-center gap-6">
        <Avatar person={p} size={108} className="ring-2 ring-white/10" />
        <div className="min-w-0 flex-1">
          <h2 className={cn(DISPLAY, "text-4xl")}>{p.name}</h2>
          <p className="mt-2 text-lg text-ink/85">
            {p.title} · {p.company}
          </p>
          <p className="mt-1 text-muted-foreground">{p.city}</p>
        </div>
        <button type="button" className={cn(BTN, "self-start")}>
          <Pencil className="size-3.5" aria-hidden="true" />
          Edit
        </button>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <span className={cn(pill, CLOSENESS_TONE[tier])}>
          Closeness <span className="ml-1 font-medium tabular-nums">{c}%</span>
        </span>
        <span className={cn(pill, "bg-secondary text-secondary-foreground")}>{TIER_LABEL[tier]} orbit</span>
        <span className={cn(pill, "border border-border text-muted-foreground")}>Last touch {daysLabel(lastTouchOf(state, p))}</span>
        {p.cluster && (
          <span className={cn(pill, "gap-1.5 border border-border text-ink/85")}>
            <Check className="size-3.5" aria-hidden="true" />
            On your constellation
          </span>
        )}
      </div>

      <section className={cn(CARD, "overflow-hidden")} aria-labelledby="demo-standing">
        <div className="flex items-center justify-between border-b border-border/60 px-5 py-3">
          <h3 id="demo-standing" className={CARD_TITLE}>
            Where things stand
          </h3>
          <button type="button" className={BTN_GHOST}>
            <RefreshCw className="size-3.5" aria-hidden="true" />
            Refresh
          </button>
        </div>
        <div className="grid grid-cols-[1.2fr_1fr] gap-x-8 gap-y-4 px-5 py-4">
          <div>
            <p className="leading-relaxed text-ink">{p.standing}</p>
            <div className="mt-3 rounded-lg border border-primary/25 bg-primary/5 px-3 py-2">
              <p className="text-xs text-primary">Next</p>
              <p className="mt-0.5 text-sm text-ink">{p.nextStep}</p>
            </div>
            <p className="mt-4 text-xs uppercase tracking-wide text-muted-foreground">Recent discussions</p>
            <ul className="mt-1.5 space-y-1 text-sm">
              {timeline.slice(0, 3).map((t) => (
                <li key={t.id} className="flex gap-3">
                  <span className="w-12 shrink-0 text-muted-foreground">{dateOf(t.daysAgo)}</span>
                  <span className="text-ink">{t.note}</span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Open next steps</p>
            {p.promise ? (
              <div className="mt-2 flex gap-2.5">
                <span className="mt-1 size-2 shrink-0 rounded-full bg-warning" aria-hidden="true" />
                <p className="text-sm text-ink">
                  To {p.promise.text} — {p.promise.when}.
                  <span className="mt-1 block text-xs text-muted-foreground">You promised · from your {p.promise.source === "You" ? "notes" : p.promise.source}</span>
                </p>
              </div>
            ) : (
              <p className="mt-2 text-sm text-muted-foreground">Nothing open — everything from your notes is done.</p>
            )}
          </div>
        </div>
      </section>

      <section className={cn(CARD, "overflow-hidden")} aria-labelledby="demo-who">
        <div className="flex items-center justify-between border-b border-border/60 px-5 py-3">
          <h3 id="demo-who" className={CARD_TITLE}>
            Who they are
          </h3>
          <button type="button" className={BTN_GHOST}>
            <RefreshCw className="size-3.5" aria-hidden="true" />
            Refresh
          </button>
        </div>
        <div className="px-5 py-4">
          <p className="leading-relaxed text-primary">
            {p.name} is {p.title} at {p.company}. How you met: {p.howMet}.
          </p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {p.tags.map((t) => (
              <span key={t} className="rounded-full border border-border px-2.5 py-0.5 text-xs text-muted-foreground">
                {t}
              </span>
            ))}
          </div>
        </div>
      </section>

      <section className={cn(CARD, "overflow-hidden")} aria-labelledby="demo-followup">
        <div className="border-b border-border/60 px-5 py-3">
          <h3 id="demo-followup" className={CARD_TITLE}>
            Follow up
          </h3>
          <p className="mt-0.5 text-sm text-muted-foreground">Schedule a reminder, or pick a channel to draft a message from your history.</p>
        </div>
        <div className="grid grid-cols-2 gap-x-8 gap-y-3 px-5 py-4">
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Remind</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="inline-flex h-8 items-center gap-2 rounded-lg border border-input bg-input/30 px-3 text-sm text-muted-foreground">
                <Calendar className="size-3.5" aria-hidden="true" />
                {fu !== null ? (fu < 0 ? `${-fu} days overdue` : fu === 0 ? "Today" : `In ${fu} days`) : "Pick a date"}
              </span>
              <button type="button" className={BTN} onClick={() => dispatch({ type: "setFollowUp", id: p.id, days: 7 })}>
                <Bell className="size-3.5" aria-hidden="true" />
                {fu !== null ? "Move to next week" : "Set follow-up"}
              </button>
            </div>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Draft for</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {[
                { label: "Email", icon: Mail },
                { label: "LinkedIn", icon: MessageSquare },
              ].map(({ label, icon: Icon }) => (
                <button
                  key={label}
                  type="button"
                  className={BTN}
                  onClick={() => dispatch({ type: "ask", q: p.promise ? `What did I promise ${first}?` : `Where did I leave things with ${first}?` })}
                >
                  <Icon className="size-3.5" aria-hidden="true" />
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section data-demo-target="profile-timeline" className={cn(CARD, "overflow-hidden")} aria-labelledby="demo-timeline">
        <div className="flex items-center justify-between border-b border-border/60 px-5 py-3">
          <h3 id="demo-timeline" className={CARD_TITLE}>
            Timeline
          </h3>
          <button type="button" className={BTN} onClick={() => dispatch({ type: "overlay", overlay: "log", logFor: p.id })}>
            <Plus className="size-3.5" aria-hidden="true" />
            Log interaction
          </button>
        </div>
        <ol className="relative px-5 py-4">
          <span
            aria-hidden="true"
            className="absolute bottom-6 left-[35px] top-6 w-px bg-gradient-to-b from-border via-border to-transparent"
          />
          {timeline.map((t) => {
            const { spec } = interactionOf(t.type);
            return (
              <li key={t.id} className="relative flex gap-3.5 pb-5 last:pb-0">
                <TypeIcon type={t.type} />
                <div className="min-w-0 flex-1 pt-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm text-muted-foreground">
                      {dateOf(t.daysAgo)} · <span className="text-ink">{spec.label}</span>
                    </p>
                    <SourceBadge source={t.source} />
                  </div>
                  <p className="mt-0.5 line-clamp-2 text-sm leading-relaxed text-ink/85">{t.note}</p>
                </div>
              </li>
            );
          })}
        </ol>
      </section>
    </div>
  );
}
