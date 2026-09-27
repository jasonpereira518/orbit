"use client";

import { useState } from "react";
import { AnimatePresence, motion, useAnimate } from "motion/react";
import { Bell, Check, Loader2 } from "lucide-react";
import { createReminder } from "@/actions/reminders";
import { Button } from "@/components/ui/button";
import { friendlyError } from "@/lib/errors";
import { DUR, EASE_HOUSE, SPRING_TAP } from "@/lib/motion";
import { toast } from "@/lib/toast";
import { TOAST_COPY } from "@/lib/toast-copy";
import { cn } from "@/lib/utils";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";

/**
 * "Remind me" on a recommendation, and the answer to whether it worked.
 *
 * The button used to do its work silently: it greyed out while the request ran and then a
 * toast appeared somewhere else on screen. Nothing on the button itself said it had happened,
 * and nothing stopped a second click from creating a second reminder. It now walks through
 * three states in place — idle, saving, set — and stays "set" once done, so the button is the
 * record that it worked and cannot be pressed twice.
 *
 * A failure was worse: `createReminder` throws, and nothing caught it, so a dropped connection
 * was an unhandled rejection with no message at all. It now gives the button back and says so.
 */

type Phase = "idle" | "saving" | "set";

/** Three days out: long enough to be a nudge rather than a nag, and what this button has always set. */
const DUE_IN_MS = 3 * 24 * 60 * 60 * 1000;

const LABEL: Record<Phase, string> = {
  idle: "Reminder",
  saving: "Setting…",
  set: "Reminder set",
};

export function ReminderButton({
  contactId,
  name,
  suggestedAction,
  className,
}: {
  contactId: string;
  name: string;
  suggestedAction: string;
  className?: string;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [dueLabel, setDueLabel] = useState<string | null>(null);
  const [scope, animate] = useAnimate<HTMLDivElement>();
  const reduceMotion = usePrefersReducedMotion();

  async function onClick() {
    // The guard is what makes "set" final: a second click on a finished or in-flight button
    // must not reach the server.
    if (phase !== "idle") return;
    setPhase("saving");
    try {
      const due = new Date(Date.now() + DUE_IN_MS);
      await createReminder({
        contactId,
        title: `Reach out to ${name}`,
        description: suggestedAction,
        dueDate: due.toISOString(),
      });
      setDueLabel(
        due.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })
      );
      setPhase("set");
      toast.success(TOAST_COPY.reminderSet);
    } catch (err) {
      setPhase("idle");
      toast.error(friendlyError(err, "Couldn’t set that reminder — try again?"));
      // A short shake says "no" on the button itself, where the eye already is; the toast
      // says why. Skipped under reduced motion, where a shake is exactly what was opted out of.
      if (!reduceMotion && scope.current) {
        void animate(scope.current, { x: [0, -4, 4, -3, 3, 0] }, { duration: 0.36, ease: "easeOut" });
      }
    }
  }

  const set = phase === "set";

  return (
    <motion.div
      ref={scope}
      className={cn("relative inline-flex", className)}
      whileTap={phase === "idle" ? { scale: 0.96 } : undefined}
      transition={SPRING_TAP}
    >
      {/* One ring, sent outward once, when the reminder lands. It is the moment of the
          button's whole interaction, so it gets the one flourish; keyed on `set` so it plays
          on entering that state and never on the way out. */}
      <AnimatePresence>
        {set && !reduceMotion && (
          <motion.span
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 rounded-[10px] border border-primary"
            initial={{ opacity: 0.55, scale: 1 }}
            animate={{ opacity: 0, scale: 1.35 }}
            transition={{ duration: 0.6, ease: EASE_HOUSE }}
          />
        )}
      </AnimatePresence>

      <Button
        size="xs"
        variant="outline"
        // `disabled` would also dim it to 50%, which reads as "unavailable" rather than
        // "done". Blocking the click in the handler and leaving the button fully lit keeps
        // the set state looking like the success it is.
        onClick={() => void onClick()}
        aria-disabled={phase !== "idle"}
        data-phase={phase}
        title={set && dueLabel ? `Due ${dueLabel}` : undefined}
        className={cn(
          "min-w-[6.75rem] transition-colors",
          set &&
            "border-primary/40 bg-primary/10 text-primary hover:bg-primary/10 hover:text-primary dark:bg-primary/15"
        )}
      >
        {/*
          Keyed on the phase so each state cross-fades in place. `popLayout` lets the outgoing
          content leave without holding the incoming one off the layout, and the button has a
          fixed minimum width so the label swap never moves its neighbours.
        */}
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={phase}
            className="inline-flex items-center gap-1"
            initial={reduceMotion ? false : { opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -5 }}
            transition={{ duration: DUR.base, ease: EASE_HOUSE }}
          >
            {phase === "saving" ? (
              <Loader2 className="animate-spin" aria-hidden="true" />
            ) : set ? (
              <motion.span
                className="inline-flex"
                initial={reduceMotion ? false : { scale: 0.3, rotate: -35 }}
                animate={{ scale: 1, rotate: 0 }}
                transition={SPRING_TAP}
              >
                <Check aria-hidden="true" />
              </motion.span>
            ) : (
              <Bell aria-hidden="true" />
            )}
            {LABEL[phase]}
          </motion.span>
        </AnimatePresence>
      </Button>

      {/* Announced politely: the button's own text change is not reliably read out. */}
      <span className="sr-only" aria-live="polite">
        {set ? `Reminder set${dueLabel ? ` for ${dueLabel}` : ""}` : ""}
      </span>
    </motion.div>
  );
}
