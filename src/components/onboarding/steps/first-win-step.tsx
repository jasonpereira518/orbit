"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { motion, useReducedMotionConfig } from "motion/react";
import { ArrowRight } from "lucide-react";
import { getFirstWinSummary, type FirstWinPerson } from "@/actions/onboarding";
import { scheduleContactFollowUp } from "@/actions/reminders";
import { OrbitLogo } from "@/components/orbit-logo";
import { Stagger, StaggerItem } from "@/components/onboarding/onboarding-ui";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { DUR, EASE_HOUSE } from "@/lib/motion";
import { toast } from "@/lib/toast";

type Summary = { people: FirstWinPerson[]; total: number };

/** "Thu, Oct 31" in the viewer's own locale and time zone, as the reminder will read. */
function dueLabel(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

const NUDGES = [
  { days: 7, label: "1 week" },
  { days: 14, label: "2 weeks" },
  { days: 30, label: "1 month" },
] as const;

/**
 * The first win, shown back: who is now in the network and the date Orbit will bring each of
 * them back. It replaced a paged tour of features with mock people, which is what someone met
 * straight after saving their first real person — the save happened, and nothing said so.
 *
 * One quiet moment of motion: a star settling into orbit around the mark, once. Everything
 * else is information. A person saved without a follow-up (not close yet, nothing dated in the
 * notes) gets the offer of one, since a contact Orbit never brings back is half the job.
 *
 * Connecting Google or Outlook, the paged overview and the example-people tour hang off here
 * as choices, after the win rather than in front of it.
 */
export function FirstWinStep({
  onDone,
  onAddAnother,
  onConnect,
  onSeeMore,
  onTour,
}: {
  onDone: () => void;
  onAddAnother: () => void;
  /** Null when no Google or Microsoft client is configured. */
  onConnect: (() => void) | null;
  onSeeMore: () => void;
  onTour: () => void;
}) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [nudging, startNudge] = useTransition();
  // Its own flag rather than the stage's transition as a prop: this step arrives while the
  // step before it is still animating out, and AnimatePresence can keep rendering the element
  // it cached then, so a prop that changes afterwards (pending ending) may never reach here.
  // In e2e that left every button disabled. Only the ways out that wait on the server need it.
  const [leaving, setLeaving] = useState(false);
  const leaveVia = (go: () => void) => () => {
    setLeaving(true);
    go();
  };
  const still = useReducedMotionConfig();

  // A failed read must not strand anyone here: it shows the plain "all set" state instead.
  const read = useCallback(() => getFirstWinSummary().catch((): Summary => ({ people: [], total: 0 })), []);
  const load = useCallback(async () => setSummary(await read()), [read]);
  useEffect(() => {
    let live = true;
    void read().then((next) => {
      if (live) setSummary(next);
    });
    return () => {
      live = false;
    };
  }, [read]);

  const people = summary?.people ?? [];
  const first = people[0] ?? null;
  const dated = people.filter((p) => p.followUp);
  const earliest = dated
    .map((p) => p.followUp!.dueDate)
    .sort()
    .at(0);
  const title = !summary
    ? null
    : people.length === 0
      ? "You’re all set"
      : summary.total === 1
        ? `${first!.firstName} is in your network`
        : `${summary.total.toLocaleString()} people are in your network`;
  const undated = people.filter((p) => !p.followUp);

  function nudge(person: FirstWinPerson, days: number) {
    startNudge(async () => {
      try {
        await scheduleContactFollowUp(person.id, days);
        await load();
      } catch {
        toast.error("That follow-up didn’t save — try again?");
      }
    });
  }

  return (
    <Stagger className="mx-auto flex w-full max-w-xl flex-col items-center text-center">
      <StaggerItem className="relative mb-4 flex size-20 items-center justify-center">
        <span aria-hidden className="absolute inset-0 rounded-full border border-primary/15" />
        <span aria-hidden className="absolute inset-3 rounded-full border border-dashed border-primary/10" />
        {people.length > 0 && (
          <motion.span
            aria-hidden
            className="absolute -top-1 right-2 size-2.5 rounded-full bg-primary shadow-[0_0_14px_3px] shadow-primary/40"
            initial={still ? false : { opacity: 0, x: 36, y: -28, scale: 0.5 }}
            animate={{ opacity: 1, x: 0, y: 0, scale: 1 }}
            transition={{ duration: DUR.slow * 2.5, ease: EASE_HOUSE, delay: 0.15 }}
          />
        )}
        <OrbitLogo size="lg" />
      </StaggerItem>

      <StaggerItem className="w-full">
        {title ? (
          <h1 className="font-[family-name:var(--font-display)] text-3xl tracking-tight text-ink text-balance sm:text-4xl">
            {title}
          </h1>
        ) : (
          <Skeleton className="mx-auto h-9 w-72 max-w-full" />
        )}
      </StaggerItem>

      <StaggerItem className="mt-5 w-full space-y-2 text-left">
        {!summary ? (
          <Skeleton className="h-20 w-full rounded-2xl" />
        ) : (
          people.map((person) => (
            <div key={person.id} className="rounded-2xl border border-border/70 bg-card px-4 py-3">
              <div className="flex items-center gap-3">
                <span
                  aria-hidden
                  className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-semibold text-primary"
                >
                  {initials(person.name)}
                </span>
                <div className="min-w-0">
                  <p className="truncate font-medium text-ink">{person.name}</p>
                  {person.subtitle && <p className="truncate text-sm text-muted-foreground">{person.subtitle}</p>}
                </div>
              </div>
              {person.followUp && (
                <p className="mt-2.5 flex items-baseline gap-2 border-t border-border/60 pt-2.5 text-sm text-foreground">
                  <span className="shrink-0 rounded-full bg-secondary px-2 py-0.5 text-xs font-semibold text-primary">
                    {dueLabel(person.followUp.dueDate)}
                  </span>
                  <span className="min-w-0">{person.followUp.title}</span>
                </p>
              )}
            </div>
          ))
        )}
        {summary && summary.total > people.length && (
          <p className="px-1 text-sm text-muted-foreground">
            and {(summary.total - people.length).toLocaleString()} more
          </p>
        )}
      </StaggerItem>

      {summary && (
        <StaggerItem className="mt-4 w-full">
          <p className="text-base text-muted-foreground text-pretty">
            {earliest
              ? `Orbit will remind you on ${dueLabel(earliest)}. When it’s time, open the reminder and Orbit drafts the message.`
              : people.length > 0
                ? "Whenever you meet someone, add them and Orbit keeps track of when to reach back out."
                : "Whenever you meet someone, add them here and Orbit sets the follow-up for you."}
          </p>
          {earliest && (
            <p className="mt-1 text-sm text-muted-foreground">It’ll be on your dashboard and in the bell when it’s due.</p>
          )}
          {undated.length > 0 && (
            <div className="mt-4 rounded-2xl border border-border/70 bg-card/70 p-3">
              {/* One person at a time: choosing reloads the summary, and the next one without a
                  follow-up (if any) takes this place. */}
              <p className="text-sm text-foreground">Want a nudge to stay in touch with {undated[0].firstName}?</p>
              <div className="mt-2 flex flex-wrap justify-center gap-2">
                {NUDGES.map((n) => (
                  <Button
                    key={n.days}
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={nudging}
                    onClick={() => nudge(undated[0], n.days)}
                  >
                    {n.label}
                  </Button>
                ))}
              </div>
            </div>
          )}
        </StaggerItem>
      )}

      <StaggerItem className="mt-6 flex w-full max-w-sm flex-col gap-2">
        <Button type="button" size="lg" className="h-11 w-full text-[15px]" disabled={leaving} onClick={leaveVia(onDone)}>
          Go to my dashboard
          <ArrowRight className="size-4" aria-hidden />
        </Button>
        <Button type="button" variant="outline" className="h-10 w-full" disabled={leaving} onClick={onAddAnother}>
          {people.length > 0 ? "Add someone else" : "Add someone you met"}
        </Button>
      </StaggerItem>

      <StaggerItem className="mt-4 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-sm">
        {onConnect && (
          <Button type="button" variant="link" className="h-auto p-1" disabled={leaving} onClick={onConnect}>
            Bring in Google or Outlook contacts
          </Button>
        )}
        <Button type="button" variant="link" className="h-auto p-1" disabled={leaving} onClick={onSeeMore}>
          See what else Orbit can do
        </Button>
        <Button type="button" variant="link" className="h-auto p-1" disabled={leaving} onClick={leaveVia(onTour)}>
          Tour every page with example people
        </Button>
      </StaggerItem>
    </Stagger>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "·";
}
