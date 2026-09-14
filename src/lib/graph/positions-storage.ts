/**
 * Where a hand-arranged sky is kept.
 *
 * Sits next to `graph-positions.ts`, which owns the prune-vs-merge rules these two
 * functions carry between the browser and the chart. Read by every renderer — a layout
 * arranged on a laptop must look the same on a phone — but written by the DOM chart
 * alone, because dragging a star is a desktop gesture.
 */
import type { PositionMap } from "@/lib/graph-positions";

export function positionsStorageKey(userId: string) {
  return `orbit-graph-positions-v5:${userId}`;
}

export function loadPositions(userId: string): PositionMap {
  try {
    const raw = localStorage.getItem(positionsStorageKey(userId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as PositionMap;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function savePositions(userId: string, positions: PositionMap) {
  try {
    localStorage.setItem(positionsStorageKey(userId), JSON.stringify(positions));
  } catch {
    // ignore quota / private mode
  }
}
