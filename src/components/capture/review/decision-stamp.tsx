"use client";

/**
 * The word that appears as a card is dragged: KEEP on the way right, NOT NOW on the way
 * left, LATER when it drops down. Bound straight to the drag's MotionValue so it tracks
 * the thumb; forced fully on for the fly-out. Decorative — the live region says it out loud.
 */
import { motion, type MotionValue } from "motion/react";
import { Check, Clock, X } from "lucide-react";
import { cn } from "@/lib/utils";

export type StampKind = "accept" | "reject" | "skip";

const STAMPS: Record<StampKind, { text: string; className: string; Icon: typeof Check }> = {
  accept: { text: "Keep", className: "border-primary text-primary bg-primary/10", Icon: Check },
  reject: { text: "Not now", className: "border-destructive text-destructive bg-destructive/10", Icon: X },
  skip: { text: "Later", className: "border-muted-foreground text-muted-foreground bg-muted/60", Icon: Clock },
};

export function DecisionStamp({
  kind,
  opacity,
  side,
}: {
  kind: StampKind;
  opacity: MotionValue<number> | number;
  side: "left" | "right" | "center";
}) {
  const stamp = STAMPS[kind];
  return (
    <motion.span
      aria-hidden
      style={{ opacity }}
      className={cn(
        "pointer-events-none absolute top-4 z-20 inline-flex items-center gap-1.5 rounded-lg border-2 px-3 py-1 font-[family-name:var(--font-display)] text-lg uppercase tracking-wide backdrop-blur-sm",
        side === "left" && "left-4 -rotate-12",
        side === "right" && "right-4 rotate-12",
        side === "center" && "left-1/2 -translate-x-1/2",
        stamp.className
      )}
    >
      <stamp.Icon className="size-5" />
      {stamp.text}
    </motion.span>
  );
}
