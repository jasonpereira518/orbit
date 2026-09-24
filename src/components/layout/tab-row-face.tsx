import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The mobile tab bar's look, shared by the real row and the copy the glass lens bends.
 *
 * The lens (`nav-lens.tsx`) cannot refract the real `<ul>`: wrapping it would put an SVG
 * `filter`, `overflow: hidden` and `contain: paint` on the whole row, which clips the
 * Capture circle and its recording toast (both sit above the bar) and renders every
 * label at 1× in Safari. So the lens refracts a copy instead, laid over the real row.
 * The copy only lines up if both are built from these same classes; change them here,
 * never in one place.
 */
export const TAB_ROW_CLASS =
  "flex items-stretch justify-around gap-0.5 px-1.5 pt-0.5 pb-1";

// No callout or text selection: holding a tab is a gesture here (it lifts the glass lens),
// and iOS would otherwise open its link preview mid-press and cancel the pointer.
export function tabItemClass(active: boolean) {
  return cn(
    "flex w-full items-center justify-center py-0.5 text-[10.5px] font-medium transition-colors select-none [-webkit-touch-callout:none]",
    active
      ? "text-primary dark:text-white"
      : "text-muted-foreground hover:text-foreground dark:text-white/75"
  );
}

export const TAB_OVAL_CLASS =
  "relative flex w-[66px] flex-col items-center gap-0.5 rounded-full px-0.5 py-1.5";

export const TAB_CONTENT_CLASS =
  "relative z-10 flex flex-col items-center gap-0.5 transition-transform duration-150 ease-out";

export function tabContentStyle(pressed: boolean) {
  return { transform: pressed ? "scale(1.15)" : undefined };
}

// MobileCaptureButton's cell and its raised circle. Shared so the lens's copy of Capture
// (the circle sticks up out of the bar, and the lifted lens can overlap it) sits exactly
// on the real one.
export const CAPTURE_CELL_CLASS =
  "relative flex w-full translate-y-1 flex-col items-center gap-0.5 px-1 py-1.5 text-[10.5px] font-medium text-primary";
export const CAPTURE_CIRCLE_CLASS =
  "absolute -top-5 left-1/2 flex h-12 w-12 -translate-x-1/2 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg";

export type TabFaceItem =
  | { kind: "tab"; key: string; label: string; icon: LucideIcon }
  | { kind: "capture"; key: string; label: string; icon: LucideIcon };

/**
 * A visual-only copy of the tab row: no links, no handlers, no pending-status hooks.
 *
 * Capture is drawn too, circle and all: the lens never rests on it, but it glides past it
 * and the lifted lens overlaps it, and everything under the glass should bend. Its resting
 * look only; the hold-to-record states (mic, ring, toast) aren't mirrored. It also keeps
 * the row lined up on a narrow phone, where each cell stops at its content's minimum
 * width and a shorter Capture cell would slide every tab after it out of line.
 * `pendingIndex` stands in for `NavPendingDot`, whose `useLinkStatus` only works inside
 * the real `<Link>`; the tab the user just tapped is exactly the one under the lens, so
 * without it the lens would cover the dot.
 */
export function TabRowFace({
  items,
  entryIndex,
  highlightIndex,
  pressedIndex,
  pendingIndex,
}: {
  items: TabFaceItem[];
  /** Per item, its index among the draggable entries, or -1 for a slot. */
  entryIndex: number[];
  highlightIndex: number;
  pressedIndex: number | null;
  pendingIndex: number;
}) {
  return (
    <div className={TAB_ROW_CLASS}>
      {items.map((item, i) => {
        if (item.kind === "capture") {
          const CaptureIcon = item.icon;
          return (
            <div key={item.key} className="flex-1">
              <div className={CAPTURE_CELL_CLASS}>
                <span className="size-[18px]" />
                <span className={CAPTURE_CIRCLE_CLASS}>
                  <CaptureIcon className="size-[18px]" />
                </span>
                <span>{item.label}</span>
              </div>
            </div>
          );
        }
        const index = entryIndex[i];
        const Icon = item.icon;
        return (
          <div key={item.key} className="flex-1">
            <div className={tabItemClass(index === highlightIndex)}>
              <span className={TAB_OVAL_CLASS}>
                <span
                  className="nav-pending-dot top-0.5 right-1.5"
                  data-pending={index === pendingIndex || undefined}
                />
                <span
                  className={TAB_CONTENT_CLASS}
                  style={tabContentStyle(index === pressedIndex)}
                >
                  <Icon className="size-[18px]" />
                  <span>{item.label}</span>
                </span>
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
