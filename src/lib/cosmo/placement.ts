import { overlapArea, type Box } from "@/lib/tour/rail-placement";

/**
 * Where Cosmo may rest: three heights on each side edge. Bottom-right is the default home and the
 * only slot inside the shared corner column (toasts and jobs stack above it there). Pure, so the
 * placement rules are testable without a page (scripts/smoke-cosmo-placement.ts).
 */
export const COSMO_SLOTS = ["bottom-right", "middle-right", "top-right", "bottom-left", "middle-left", "top-left"] as const;
export type CosmoSlot = (typeof COSMO_SLOTS)[number];
export const HOME_SLOT: CosmoSlot = "bottom-right";
export type CosmoSide = "left" | "right";
export type CosmoHeight = "top" | "middle" | "bottom";

export function slotParts(slot: CosmoSlot): { height: CosmoHeight; side: CosmoSide } {
  const [height, side] = slot.split("-") as [CosmoHeight, CosmoSide];
  return { height, side };
}
export function isCosmoSlot(value: unknown): value is CosmoSlot {
  return typeof value === "string" && (COSMO_SLOTS as readonly string[]).includes(value);
}

export type SlotFrame = {
  viewport: { width: number; height: number };
  /** Clear space from each viewport edge: the sidebar on the left, header controls on top, the corner on the right and bottom. */
  insets: { left: number; right: number; top: number; bottom: number };
  /** Cosmo's own size right now (the idle orb, or the call bar with its tray). */
  size: { width: number; height: number };
};

export function slotBox(slot: CosmoSlot, { viewport, insets, size }: SlotFrame): Box {
  const { height, side } = slotParts(slot);
  const left = side === "right" ? viewport.width - insets.right - size.width : insets.left;
  const top =
    height === "bottom"
      ? viewport.height - insets.bottom - size.height
      : height === "top"
        ? insets.top
        : (viewport.height - size.height) / 2;
  return { left, top, width: size.width, height: size.height };
}

const centre = (b: Box) => ({ x: b.left + b.width / 2, y: b.top + b.height / 2 });

/** Slots ordered nearest-first to `from`, so ties go to the least surprising move. */
function byDistance(from: Box, frame: SlotFrame) {
  const c = centre(from);
  return [...COSMO_SLOTS].sort((a, b) => {
    const ca = centre(slotBox(a, frame));
    const cb = centre(slotBox(b, frame));
    return Math.hypot(ca.x - c.x, ca.y - c.y) - Math.hypot(cb.x - c.x, cb.y - c.y);
  });
}

/**
 * Home when nothing covers it; otherwise the least-covered slot, nearest home first. When every
 * slot is equally covered it stays home rather than wandering.
 */
export function chooseSlot(home: CosmoSlot, frame: SlotFrame, obstacles: readonly Box[]): CosmoSlot {
  const covered = (slot: CosmoSlot) => {
    const box = slotBox(slot, frame);
    return obstacles.reduce((sum, o) => sum + overlapArea(box, o), 0);
  };
  let best = home;
  let bestCover = covered(home);
  if (bestCover === 0) return home;
  for (const slot of byDistance(slotBox(home, frame), frame)) {
    const cover = covered(slot);
    if (cover < bestCover) {
      best = slot;
      bestCover = cover;
    }
  }
  return best;
}

/** Where a drop lands: the slot whose centre is nearest the dropped centre. */
export function nearestSlot(point: { x: number; y: number }, frame: SlotFrame): CosmoSlot {
  return byDistance({ left: point.x, top: point.y, width: 0, height: 0 }, frame)[0];
}

const HEIGHTS: CosmoHeight[] = ["top", "middle", "bottom"];
/** Arrow keys on a focused Cosmo: left/right cross sides, up/down climb the same side. Null for any other key. */
export function stepSlot(slot: CosmoSlot, key: string): CosmoSlot | null {
  const { height, side } = slotParts(slot);
  const at = HEIGHTS.indexOf(height);
  if (key === "ArrowLeft") return `${height}-left`;
  if (key === "ArrowRight") return `${height}-right`;
  if (key === "ArrowUp") return `${HEIGHTS[Math.max(0, at - 1)]}-${side}`;
  if (key === "ArrowDown") return `${HEIGHTS[Math.min(2, at + 1)]}-${side}`;
  return null;
}

/** Where a pointer is inside an element's box, -1..1 on each axis from its centre (clamped). */
export function pointerIn(el: { getBoundingClientRect(): { left: number; top: number; width: number; height: number } }, clientX: number, clientY: number) {
  const r = el.getBoundingClientRect();
  const clamp = (v: number) => Math.max(-1, Math.min(1, v));
  return {
    x: clamp((clientX - (r.left + r.width / 2)) / (r.width / 2 || 1)),
    y: clamp((clientY - (r.top + r.height / 2)) / (r.height / 2 || 1)),
  };
}
