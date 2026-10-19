"use client";

import { SegmentedControl } from "@/components/ui/segmented-control";

export type CaptureMode = "messy" | "voice" | "meeting" | "library" | "cloud";

export const CAPTURE_MODES: ReadonlyArray<{ id: CaptureMode; label: string; blurb: string }> = [
  {
    id: "messy",
    label: "Notes",
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
    id: "library",
    label: "Notes library",
    blurb:
      "Backfilling? Drop a folder of meeting notes and each file becomes its own meeting — its own date, its own people, its own entry on their timeline.",
  },
  {
    id: "cloud",
    label: "Drive & OneDrive",
    blurb:
      "Pick meeting notes straight from Google Drive or OneDrive — one or a stack of them. Each becomes its own capture to review.",
  },
];

/**
 * The `SegmentedControl` id this bar is mounted with. Its tab and panel ids are
 * `${id}-tab-${mode}` / `${id}-panel-${mode}`, which the panels below the bar wire up
 * through the two helpers.
 */
const CAPTURE_TABS_ID = "capture";

export function captureTabId(mode: CaptureMode) {
  return `${CAPTURE_TABS_ID}-tab-${mode}`;
}

export function capturePanelId(mode: CaptureMode) {
  return `${CAPTURE_TABS_ID}-panel-${mode}`;
}

/**
 * The ways in, as the shared segmented control. Each mode's panel renders its own
 * `role="tabpanel"` with `capturePanelId` / `captureTabId`, so the control's `aria-controls`
 * lands on the mounted panel.
 *
 * Five tabs is tight on a narrow phone: the control fills the row below `sm` so the labels
 * shrink rather than wrap. Verify at 360px before adding a sixth.
 */
export function CaptureTabs({
  mode,
  onChange,
  disabled = false,
  showCloud = false,
}: {
  mode: CaptureMode;
  onChange: (mode: CaptureMode) => void;
  /** A job is in flight or a meeting is recording — switching would lose it. */
  disabled?: boolean;
  /** The Drive & OneDrive tab — only while the cloud-notes surface is live for this viewer. */
  showCloud?: boolean;
}) {
  return (
    <SegmentedControl
      id={CAPTURE_TABS_ID}
      ariaLabel="Capture mode"
      variant="subtle"
      value={mode}
      onChange={onChange}
      className="w-full sm:w-fit"
      items={CAPTURE_MODES.filter((m) => showCloud || m.id !== "cloud").map((m) => ({
        key: m.id,
        label: m.label,
        disabled: disabled && m.id !== mode,
      }))}
    />
  );
}
