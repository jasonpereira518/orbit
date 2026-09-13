"use client";

import { motion } from "motion/react";
import { SPRING_PILL } from "@/lib/motion";
import { cn } from "@/lib/utils";

export type CaptureMode = "messy" | "voice" | "meeting" | "structured";

export const CAPTURE_MODES: ReadonlyArray<{ id: CaptureMode; label: string; blurb: string }> = [
  {
    id: "messy",
    label: "Messy Notes",
    blurb:
      "Paste notes about one person or many — typed, photographed, or a PDF. Orbit pulls each person out and you review them one card at a time.",
  },
  {
    id: "voice",
    label: "Voice",
    blurb:
      "Just finished a conversation? Say who you met and what you agreed — Orbit transcribes it, then pulls out the people.",
  },
  {
    id: "meeting",
    label: "Meeting",
    blurb:
      "On a call? Orbit listens along, then summarizes it and pulls out the people, next steps, blockers and open questions.",
  },
  {
    id: "structured",
    label: "Structured Logging",
    blurb: "Fill in the fields yourself for a clean interaction log on a contact.",
  },
];

export function captureTabId(mode: CaptureMode) {
  return `capture-tab-${mode}`;
}

export function capturePanelId(mode: CaptureMode) {
  return `capture-panel-${mode}`;
}

/**
 * The four ways in, as a pill tab bar. The same `layoutId` pill every segmented control
 * in the app uses, plus the tab/tabpanel wiring the old bar lacked.
 */
export function CaptureTabs({
  mode,
  onChange,
  disabled = false,
}: {
  mode: CaptureMode;
  onChange: (mode: CaptureMode) => void;
  /** A job is in flight or a meeting is recording — switching would lose it. */
  disabled?: boolean;
}) {
  return (
    <div
      role="tablist"
      aria-label="Capture mode"
      className="inline-flex w-full rounded-lg bg-muted p-[3px] sm:w-auto"
    >
      {CAPTURE_MODES.map((m) => (
        <ModeTab
          key={m.id}
          id={captureTabId(m.id)}
          controls={capturePanelId(m.id)}
          active={mode === m.id}
          disabled={disabled}
          onClick={() => onChange(m.id)}
        >
          {m.label}
        </ModeTab>
      ))}
    </div>
  );
}

function ModeTab({
  id,
  controls,
  active,
  onClick,
  disabled = false,
  children,
}: {
  id: string;
  controls: string;
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      id={id}
      aria-controls={controls}
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      disabled={disabled && !active}
      onClick={onClick}
      className={cn(
        "relative flex-1 rounded-md px-2 py-1.5 text-sm font-medium transition-colors sm:flex-none sm:px-4",
        active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
        "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-muted-foreground"
      )}
    >
      {active && (
        <motion.span
          layoutId="capture-mode-pill"
          className="absolute inset-0 rounded-md bg-background shadow-sm"
          transition={SPRING_PILL}
        />
      )}
      <span className="relative z-10">{children}</span>
    </button>
  );
}
