/**
 * What the sky dims, and by how much.
 *
 * Pure and shared, because emphasis is the one thing a person reads instantly and would
 * never think to compare across devices. If a phone dimmed the unsearched stars a little
 * differently from a laptop, nobody would file it — they would just find one of the two
 * harder to read. So the precedence lives here once, and both renderers apply it.
 */

export type SkyFocusState = {
  hoveredId: string | null;
  /** The selected contact's id, or null (including when the sun is selected). */
  selectedContactId: string | null;
  searchHitIds: Set<string>;
  /** True only when the search actually hit someone. */
  searchDimActive: boolean;
};

/** Hover/selection focus is transient, so it dims harder than search does. */
export const FOCUS_DIM_OPACITY = 0.15;
/** Search keeps the rest of the sky readable as context. */
export const SEARCH_DIM_OPACITY = 0.35;

export type StarEmphasis = {
  opacity: number;
  selected: boolean;
  spotlight: boolean;
  /** The one-and-only search hit — it gets the label and the ring no matter the zoom. */
  spotlightSolo: boolean;
};

export function starEmphasis(id: string, state: SkyFocusState): StarEmphasis {
  const isHovered = state.hoveredId === id;
  const isSelected = state.selectedContactId === id;
  // Spotlight only explicit search hits — not every star in a zoomed cluster.
  const spotlight = state.searchDimActive && state.searchHitIds.has(id);
  const dimFromSearch = state.searchDimActive && !spotlight;
  const dimFromFocus =
    Boolean(state.hoveredId || state.selectedContactId) && !isHovered && !isSelected;

  return {
    opacity: dimFromFocus
      ? FOCUS_DIM_OPACITY
      : dimFromSearch
        ? SEARCH_DIM_OPACITY
        : 1,
    selected: isSelected,
    spotlight,
    spotlightSolo: spotlight && state.searchHitIds.size === 1,
  };
}

/**
 * A cluster's haze and label fade only while a search is narrowing the sky; outside a
 * search, framing a cluster must not make the others vanish.
 */
export function clusterEmphasis(
  clusterName: string | undefined,
  focusCompany: string | null,
  companyFilter: string,
  searchDimActive: boolean
): number {
  const hidden =
    Boolean(focusCompany) && clusterName !== focusCompany && companyFilter === "all";
  return hidden && searchDimActive ? SEARCH_DIM_OPACITY : 1;
}

export function edgeEmphasis(
  edge: { source: string; target: string; opacity: number; strokeWidth: number; kind?: string },
  state: SkyFocusState & { focusCluster: string | null }
): { opacity: number; strokeWidth: number } {
  const { hoveredId, selectedContactId, searchHitIds, searchDimActive, focusCluster } = state;

  const relatedToHover =
    Boolean(hoveredId) && (edge.source === hoveredId || edge.target === hoveredId);
  const relatedToSelection =
    Boolean(selectedContactId) &&
    (edge.source === selectedContactId || edge.target === selectedContactId);
  const dimOthers = Boolean(hoveredId || selectedContactId);
  const emphasized = relatedToHover || relatedToSelection;

  let opacity = edge.opacity;
  if (searchDimActive) {
    const sourceOk = searchHitIds.has(edge.source);
    const targetOk = searchHitIds.has(edge.target);
    if (focusCluster && edge.kind === "constellation") {
      // Framing a cluster for a person search — keep constellation lines,
      // slightly emphasize edges that touch the highlighted person.
      if (sourceOk || targetOk) opacity = Math.min(1, opacity + 0.25);
    } else if (!(sourceOk && targetOk)) {
      opacity = Math.min(opacity, 0.25);
    }
  }
  if (dimOthers && !emphasized) {
    opacity = Math.min(opacity, 0.1);
  } else if (emphasized) {
    opacity = Math.min(1, opacity + 0.35);
  }

  return {
    opacity,
    strokeWidth: emphasized ? edge.strokeWidth + 0.75 : edge.strokeWidth,
  };
}
