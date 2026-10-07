"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  dismissRecommendation,
  neverForContact,
  restoreRecommendation,
  scheduleFromRecommendation,
  snoozeRecommendation,
} from "@/actions/radar";
import { friendlyError } from "@/lib/errors";
import { runToastAction, toast } from "@/lib/toast";

/**
 * Cards brought back by Undo, so the card that remounts after the refresh grows back into
 * place instead of popping in. Module state on purpose: the card that set it has unmounted.
 */
const restored = new Set<string>();

/** How long a resolved card takes to fold away before the list is refreshed around it. */
const COLLAPSE_MS = 260;

function prefersReducedMotion() {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, prefersReducedMotion() ? 0 : COLLAPSE_MS));

/**
 * One card's actions, shared by the full card, the dashboard's compact row and focus mode's
 * shortcuts. `collapsed` drives the fold: true while a resolving action runs (and before the
 * refresh removes the card), and on the first frame of a card brought back by Undo.
 */
export function useRecommendationActions(rec: { id: string; contactName: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [exiting, setExiting] = useState(false);
  const [entering, setEntering] = useState(() => restored.has(rec.id));
  const [draftOpen, setDraftOpen] = useState(false);

  useEffect(() => {
    if (!entering) return;
    restored.delete(rec.id);
    const frame = requestAnimationFrame(() => setEntering(false));
    return () => cancelAnimationFrame(frame);
  }, [entering, rec.id]);

  /** Resolve the card: fold it away, run the action, offer Undo, refresh the list. */
  const resolve = (run: () => Promise<{ ok: boolean; message?: string }>, success: string) =>
    start(async () => {
      setExiting(true);
      const [result] = await Promise.all([
        runToastAction({
          run: async () => {
            const out = await run();
            if (!out.ok) throw new Error(out.message ?? "Couldn’t do that — try again?");
            return out;
          },
          success,
          failure: "Couldn’t do that — try again?",
          undo: () => async () => {
            restored.add(rec.id);
            const out = await restoreRecommendation(rec.id);
            router.refresh();
            return out;
          },
        }),
        settle(),
      ]);
      if (result === undefined) {
        setExiting(false);
        return;
      }
      router.refresh();
    });

  const schedule = (days: 3 | 7 | 14) =>
    start(async () => {
      setExiting(true);
      try {
        const [result] = await Promise.all([scheduleFromRecommendation(rec.id, days), settle()]);
        if (!result.ok) {
          setExiting(false);
          toast.error(result.message);
          return;
        }
        toast.success(days === 7 ? "Follow-up set for a week from now" : `Follow-up set for ${days} days from now`);
        router.refresh();
      } catch (err) {
        setExiting(false);
        toast.error(friendlyError(err, "Couldn’t schedule that follow-up — try again?"));
      }
    });

  return {
    pending,
    collapsed: exiting || entering,
    draftOpen,
    setDraftOpen,
    schedule,
    /** Fold the card away for an email sent from its sheet; the send resolves it server-side. */
    hide: () => setExiting(true),
    /** Undo took the email back: the card is still live. */
    unhide: () => setExiting(false),
    snooze: (length: "1w" | "1m") =>
      resolve(() => snoozeRecommendation(rec.id, length), length === "1w" ? "Snoozed for a week" : "Snoozed for a month"),
    dismiss: () => resolve(() => dismissRecommendation(rec.id), "Dismissed"),
    never: () => resolve(() => neverForContact(rec.id), `No more suggestions about ${rec.contactName}`),
  };
}
