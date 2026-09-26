"use client";

import { ArrowLeft, BellPlus, MapPin, MessageSquare, NotebookPen } from "lucide-react";
import { cn } from "@/lib/utils";
import { daysLabel, dueLabel, firstName, personById } from "../demo-cast";
import { useDemo } from "../demo-context";
import { closenessOf, followUpOf, lastTouchOf, timelineOf } from "../demo-state";
import { Avatar, BTN, BTN_PRIMARY, CARD, DISPLAY, SourceBadge, TierBadge, TypeIcon } from "../demo-ui";

export function ContactProfileScreen() {
  const { state, dispatch } = useDemo();
  const p = personById(state.profileId);
  if (!p) return null;
  const c = closenessOf(state, p);
  const fu = followUpOf(state, p);
  const first = firstName(p);
  const backTo = { dashboard: "Dashboard", contacts: "Contacts", chat: "Chat", constellation: "Constellation" }[state.prevScreen];

  return (
    <div className="space-y-5">
      <button
        type="button"
        onClick={() => dispatch({ type: "back" })}
        className="inline-flex items-center gap-1.5 text-xs text-[var(--d-dim)] hover:text-[var(--d-ink)]"
      >
        <ArrowLeft className="size-3.5" aria-hidden="true" />
        {backTo}
      </button>

      <header className="flex items-center gap-5">
        <Avatar person={p} size={84} />
        <div className="min-w-0 flex-1">
          <h2 className={cn(DISPLAY, "text-3xl")}>{p.name}</h2>
          <p className="mt-0.5 text-sm text-[var(--d-ink)]/85">
            {p.title} · {p.company}
          </p>
          <p className="mt-1 inline-flex items-center gap-1 text-xs text-[var(--d-dim)]">
            <MapPin className="size-3" aria-hidden="true" />
            {p.city} · {p.howMet}
          </p>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-white/[0.06] px-2.5 py-1 text-xs text-[var(--d-ink)]">
          Closeness <span className="font-medium tabular-nums">{c}%</span>
        </span>
        <TierBadge closeness={c} />
        <span className="rounded-full bg-white/[0.06] px-2.5 py-1 text-xs text-[var(--d-dim)]">
          Last touch {daysLabel(lastTouchOf(state, p))}
        </span>
        {fu !== null && (
          <span className={cn("rounded-full px-2.5 py-1 text-xs", fu < 0 ? "bg-amber-400/15 text-amber-200" : "bg-white/[0.06] text-[var(--d-dim)]")}>
            Follow-up · {dueLabel(fu)}
          </span>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <button type="button" className={BTN} onClick={() => dispatch({ type: "overlay", overlay: "log", logFor: p.id })}>
          <NotebookPen className="size-3.5" aria-hidden="true" />
          Log interaction
        </button>
        <button type="button" className={BTN} onClick={() => dispatch({ type: "setFollowUp", id: p.id, days: 7 })}>
          <BellPlus className="size-3.5" aria-hidden="true" />
          {fu !== null ? "Move follow-up to next week" : "Set follow-up"}
        </button>
        <button
          type="button"
          data-demo-target="profile-ask"
          className={BTN_PRIMARY}
          onClick={() => dispatch({ type: "ask", q: p.promise ? `What did I promise ${first}?` : `Where did I leave things with ${first}?` })}
        >
          <MessageSquare className="size-3.5" aria-hidden="true" />
          Ask about {first}
        </button>
      </div>

      <div className="grid grid-cols-5 gap-4">
        <section className={cn(CARD, "col-span-2 space-y-3 p-4")} aria-labelledby="demo-standing">
          <h3 id="demo-standing" className="text-sm font-medium text-[var(--d-ink)]">
            Where things stand
          </h3>
          <p className="text-xs leading-relaxed text-[var(--d-ink)]/85">{p.standing}</p>
          <div>
            <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--d-dim)]">Next step</p>
            <p className="mt-0.5 text-xs text-[var(--d-ink)]">{p.nextStep}</p>
          </div>
          {p.promise && (
            <div className="rounded-lg border border-amber-300/25 bg-amber-300/[0.06] px-3 py-2">
              <p className="text-[10px] font-medium uppercase tracking-wide text-amber-200/90">You promised</p>
              <p className="mt-0.5 text-xs text-[var(--d-ink)]">
                To {p.promise.text} — {p.promise.when}.
              </p>
            </div>
          )}
          <div className="flex flex-wrap gap-1.5 pt-1">
            {p.tags.map((t) => (
              <span key={t} className="rounded-full border border-[var(--d-border)] px-2 py-0.5 text-[10px] text-[var(--d-dim)]">
                {t}
              </span>
            ))}
          </div>
        </section>

        <section data-demo-target="profile-timeline" className={cn(CARD, "col-span-3 p-4")} aria-labelledby="demo-timeline">
          <h3 id="demo-timeline" className="text-sm font-medium text-[var(--d-ink)]">
            Timeline
          </h3>
          <ol className="mt-3 space-y-3">
            {timelineOf(state, p).map((t) => (
              <li key={t.id} className="flex gap-3">
                <TypeIcon type={t.type} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-xs font-medium text-[var(--d-ink)]">{t.type}</p>
                    <span className="text-[11px] text-[var(--d-dim)]">{daysLabel(t.daysAgo)}</span>
                    <SourceBadge source={t.source} />
                  </div>
                  <p className="mt-0.5 text-xs leading-relaxed text-[var(--d-ink)]/80">{t.note}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </div>
  );
}
