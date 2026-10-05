"use client";

import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, Bell, Check, Sparkles, Users, X, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { EASE_HOUSE } from "@/lib/motion";
import { DEMO_PEOPLE, dueLabel, personById, tierOf } from "../demo-cast";
import { useDemo } from "../demo-context";
import { activeSuggestions, closenessOf, dueList, followUpOf, stats, type ContactsFilter } from "../demo-state";
import { Avatar, BTN, BTN_GHOST, BTN_PRIMARY, CARD, DISPLAY, ReasonPill } from "../demo-ui";
import { SkyChart } from "../sky-chart";

/**
 * The real dashboard (`dashboard-header.tsx`, `dashboard-sections.tsx`), on the cast. The
 * headings, stat labels and subtitles are the app's words — `scripts/smoke-waitlist-demo-
 * fidelity.ts` fails if they drift — and the depth numbers are computed from the cast, so
 * they always add up.
 */
const CARD_TITLE = cn(DISPLAY, "text-base");

function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  onClick,
}: {
  label: string;
  value: number;
  hint?: string;
  icon: LucideIcon;
  onClick: () => void;
}) {
  return (
    <button type="button" onClick={onClick} className={cn(CARD, "p-4 text-left transition-colors hover:border-primary/40")}>
      <div className="flex items-center justify-between">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
        <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
      </div>
      <p className={cn(DISPLAY, "mt-3 text-3xl tabular-nums")}>{value}</p>
      {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : <p className="mt-1 text-xs">&nbsp;</p>}
    </button>
  );
}

export function DashboardScreen() {
  const { state, dispatch, reduced } = useDemo();
  const s = stats(state);
  const suggestions = activeSuggestions(state);
  const due = dueList(state);
  const dueIds = new Set(due.map((d) => d.p.id));
  const reminders = DEMO_PEOPLE.map((p) => ({ p, days: followUpOf(state, p) }))
    .filter((x): x is { p: (typeof DEMO_PEOPLE)[number]; days: number } => x.days !== null && !dueIds.has(x.p.id))
    .sort((a, b) => a.days - b.days)
    .slice(0, 4);

  const go = (filter: ContactsFilter) => () => dispatch({ type: "go", screen: "contacts", filter });

  // Network depth, from the cast: relationship strength, and how the constellations link people.
  const tiers = { inner: 0, mid: 0, outer: 0 };
  for (const p of DEMO_PEOPLE) tiers[tierOf(closenessOf(state, p))]++;
  const n = DEMO_PEOPLE.length;
  const pct = (v: number) => Math.round((v / n) * 100);
  const clusterSizes = new Map<string, number>();
  for (const p of DEMO_PEOPLE) if (p.cluster) clusterSizes.set(p.cluster, (clusterSizes.get(p.cluster) ?? 0) + 1);
  const links = [...clusterSizes.values()].reduce((sum, k) => sum + (k * (k - 1)) / 2, 0);
  const degree = (p: (typeof DEMO_PEOPLE)[number]) => (p.cluster ? (clusterSizes.get(p.cluster) ?? 1) - 1 : 0);
  const buckets = [
    { label: "0 links", v: DEMO_PEOPLE.filter((p) => degree(p) === 0).length, tone: "bg-muted-foreground/50" },
    { label: "1-2 links", v: DEMO_PEOPLE.filter((p) => degree(p) >= 1 && degree(p) <= 2).length, tone: "bg-sky-500" },
    { label: "3+ links", v: DEMO_PEOPLE.filter((p) => degree(p) >= 3).length, tone: "bg-emerald-500" },
  ];
  const strength = [
    { label: "Close", v: tiers.inner, dot: "bg-emerald-500", text: "text-emerald-400" },
    { label: "Warm", v: tiers.mid, dot: "bg-amber-500", text: "text-amber-400" },
    { label: "Cool", v: tiers.outer, dot: "bg-sky-500", text: "text-sky-400" },
  ];

  return (
    <div className="space-y-6">
      <header>
        <p className="text-sm font-medium text-ink">Your network</p>
        <h2 className={cn(DISPLAY, "mt-1 text-4xl")}>Stay in orbit</h2>
        <p className="mt-2 max-w-xl text-muted-foreground">
          Follow-ups, dormant connections, and people worth reaching out to — in one place. Press{" "}
          <kbd className="rounded-md border border-border bg-muted/50 px-1.5 text-[11px]">⌘K</kbd> to jump anywhere, or{" "}
          <kbd className="rounded-md border border-border bg-muted/50 px-1.5 text-[11px]">⌘J</kbd> to ask your network.
        </p>
      </header>

      <div className="grid grid-cols-4 gap-3">
        <StatCard label="Contacts" value={s.contacts} icon={Users} onClick={go("all")} />
        <StatCard label="Due follow-ups" value={s.due} hint="Needs attention" icon={Bell} onClick={go("due")} />
        <StatCard label="Strong ties" value={s.strong} hint="Close + warm" icon={Sparkles} onClick={go("inner")} />
        <StatCard label="Reminders" value={s.reminders} icon={Bell} onClick={go("reminders")} />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <section className={cn(CARD, "flex flex-col p-5")} aria-labelledby="demo-depth">
          <h3 id="demo-depth" className={CARD_TITLE}>
            Network depth
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">How close your network feels and how people connect to each other</p>
          <p className="mt-4 text-xs uppercase tracking-wide text-muted-foreground">Relationship strength</p>
          <div className="mt-2 flex h-2.5 overflow-hidden rounded-full" aria-hidden="true">
            {strength.map((t) => (
              <span key={t.label} className={t.dot} style={{ width: `${(t.v / n) * 100}%` }} />
            ))}
          </div>
          <ul className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-sm">
            {strength.map((t) => (
              <li key={t.label} className="flex items-center gap-1.5">
                <span className={cn("size-2 rounded-full", t.dot)} aria-hidden="true" />
                <span className={t.text}>{t.label}</span>
                <span className="text-ink tabular-nums">
                  {t.v} <span className="text-xs text-muted-foreground">({pct(t.v)}%)</span>
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
            Strength, recency, cadence, and goal alignment combined — measured on its own terms, not ranked against the rest of
            your network
          </p>
          <div className="mt-4 border-t border-border/60 pt-4">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Peer connections</p>
            <dl className="mt-2 grid grid-cols-3 gap-3">
              {[
                ["Contacts", n],
                ["Peer links", links],
                ["Avg links", ((links * 2) / n).toFixed(1)],
              ].map(([k, v]) => (
                <div key={String(k)}>
                  <dt className="text-[11px] uppercase text-muted-foreground">{k}</dt>
                  <dd className={cn(DISPLAY, "text-2xl tabular-nums")}>{v}</dd>
                </div>
              ))}
            </dl>
            <ul className="mt-3 space-y-1.5">
              {buckets.map((b) => (
                <li key={b.label} className="flex items-center gap-3 text-xs">
                  <span className="w-14 text-muted-foreground">{b.label}</span>
                  <span className="h-2 flex-1 overflow-hidden rounded-full bg-muted/60">
                    <span className={cn("block h-full rounded-full", b.tone)} style={{ width: `${Math.max(b.v ? 6 : 3, (b.v / n) * 100)}%` }} />
                  </span>
                  <span className="w-5 text-right tabular-nums text-ink">{b.v}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className={cn(CARD, "flex flex-col overflow-hidden")} aria-labelledby="demo-preview">
          <div className="p-5 pb-3">
            <h3 id="demo-preview" className={CARD_TITLE}>
              Constellation preview
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">Your network at a glance — each constellation is a company or school</p>
          </div>
          <div className="mx-5 min-h-[210px] flex-1 overflow-hidden rounded-2xl border border-white/10 bg-[#03050a] p-1">
            <SkyChart mini />
          </div>
          <div className="mt-3 border-t border-border/60 px-3 py-2">
            <button type="button" onClick={() => dispatch({ type: "go", screen: "constellation" })} className={BTN_GHOST}>
              Open full constellation
              <ArrowRight className="size-3.5" aria-hidden="true" />
            </button>
          </div>
        </section>
      </div>

      <section className={cn(CARD, "p-5")} aria-labelledby="demo-suggested">
        <div className="flex items-center justify-between">
          <h3 id="demo-suggested" className={cn(CARD_TITLE, "flex items-center gap-2")}>
            <Sparkles className="size-4 text-warning" aria-hidden="true" />
            Suggested outreach
          </h3>
          <button type="button" className={BTN_GHOST}>
            Capture
            <ArrowRight className="size-3.5" aria-hidden="true" />
          </button>
        </div>
        <ul className="mt-3 space-y-2">
          <AnimatePresence initial={false}>
            {suggestions.map((sg) => {
              const p = personById(sg.personId)!;
              return (
                <motion.li
                  key={sg.personId}
                  layout={!reduced}
                  initial={false}
                  exit={reduced ? undefined : { opacity: 0, height: 0, marginTop: 0 }}
                  transition={{ duration: 0.28, ease: EASE_HOUSE }}
                  className="overflow-hidden"
                >
                  <div data-demo-target={`suggestion-${p.id}`} className="rounded-xl border border-border/60 bg-card p-3">
                    <div className="flex items-start gap-3">
                      <Avatar person={p} size={36} />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="font-medium text-ink">Reach out to {p.name}</p>
                          <ReasonPill reason={sg.reason} />
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {p.title} · {p.company}
                        </p>
                        <p className="mt-1 text-sm text-ink/80">{sg.why}</p>
                        <div className="mt-2.5 flex flex-wrap gap-2">
                          <button type="button" className={BTN} onClick={() => dispatch({ type: "setFollowUp", id: p.id, days: 7 })}>
                            Set follow-up
                          </button>
                          <button
                            type="button"
                            data-demo-target={`suggest-open-${p.id}`}
                            className={BTN_PRIMARY}
                            onClick={() => dispatch({ type: "openProfile", id: p.id })}
                          >
                            Open contact
                          </button>
                        </div>
                      </div>
                      <button
                        type="button"
                        aria-label={`Dismiss ${p.name}`}
                        className="rounded-md p-1 text-muted-foreground hover:bg-muted/50 hover:text-ink"
                        onClick={() => dispatch({ type: "dismiss", id: p.id })}
                      >
                        <X className="size-4" />
                      </button>
                    </div>
                  </div>
                </motion.li>
              );
            })}
          </AnimatePresence>
        </ul>
        {suggestions.length === 0 && (
          <p className="mt-3 rounded-xl border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
            Nobody has gone quiet. Log an interaction and Orbit will keep watching.
          </p>
        )}
      </section>

      <div className="grid grid-cols-2 gap-4">
        <section className={cn(CARD, "p-5")} aria-labelledby="demo-reminders">
          <h3 id="demo-reminders" className={CARD_TITLE}>
            Reminders
          </h3>
          <ul className="mt-3 space-y-2">
            {reminders.map(({ p, days }) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => dispatch({ type: "openProfile", id: p.id })}
                  className="flex w-full items-center gap-3 rounded-xl border border-border/60 bg-card p-3 text-left transition-colors hover:border-primary/40"
                >
                  <Avatar person={p} size={32} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-ink">{p.followUpLabel ?? `Catch up with ${p.name}`}</span>
                    <span className="block truncate text-xs text-muted-foreground">{p.name}</span>
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">{dueLabel(days)}</span>
                </button>
              </li>
            ))}
            {reminders.length === 0 && <li className="py-2 text-sm text-muted-foreground">Nothing scheduled.</li>}
          </ul>
        </section>

        <section className={cn(CARD, "p-5")} aria-labelledby="demo-due">
          <div className="flex items-center justify-between gap-2">
            <h3 id="demo-due" className={CARD_TITLE}>
              Due follow-ups
            </h3>
            <span className="flex gap-1">
              <button type="button" className={BTN_GHOST}>
                View all
              </button>
            </span>
          </div>
          <ul className="mt-3 space-y-2">
            {due.map(({ p, days }) => (
              <li key={p.id} className="flex items-center gap-2.5 rounded-xl border border-border/60 bg-card p-3">
                <button
                  type="button"
                  aria-label={`Mark ${p.name}'s follow-up done`}
                  onClick={() => dispatch({ type: "completeFollowUp", id: p.id })}
                  className="group inline-flex size-5 shrink-0 items-center justify-center rounded-full border border-border hover:border-emerald-400"
                >
                  <Check className="size-3 text-emerald-400 opacity-0 group-hover:opacity-100" />
                </button>
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                  onClick={() => dispatch({ type: "openProfile", id: p.id })}
                >
                  <Avatar person={p} size={30} />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-ink">
                      {state.followUps[p.id] !== undefined ? `Catch up with ${p.name.split(" ")[0]}` : (p.followUpLabel ?? `Catch up with ${p.name}`)}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">{p.name}</span>
                  </span>
                </button>
                <span className={cn("shrink-0 text-xs font-medium", days < 0 ? "text-warning" : "text-muted-foreground")}>{dueLabel(days)}</span>
              </li>
            ))}
            {due.length === 0 && <li className="py-2 text-sm text-muted-foreground">All caught up.</li>}
          </ul>
        </section>
      </div>
    </div>
  );
}
