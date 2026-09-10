/**
 * The constellation's scope, shared between the chart and a control that lives outside it.
 *
 * The toggle sits in the page header — above the Suspense boundary, and therefore above the
 * component that owns the payload, the cache and the fetch. Neither can see the other through
 * props, so they meet here: a module-scope bus of plain functions, in the same shape as
 * `intro-signal.ts` next door and for the same reason.
 *
 * The division of labour is deliberate. The button knows nothing about scopes beyond which one
 * it is asking for; `NetworkGraph` remains the only thing that fetches, caches or decides what
 * is on screen. So the header cannot get the chart into a state the chart did not choose, and
 * "we never load everyone until you ask" stays a property of one file.
 */

export type GraphScopeName = "engaged" | "all";

export type GraphScopeState = {
  /**
   * Whether there is anything to toggle. False until a chart reports that the constellation
   * filter is enabled at all — with the filter off, every contact is already drawn and a
   * control that switches between two identical views would be a lie.
   */
  available: boolean;
  scope: GraphScopeName;
  /** A fetch of the wider set is in flight. */
  loading: boolean;
  /** How many stars the current engaged-only payload draws. */
  shown: number;
  /** How many contacts exist in total. */
  total: number;
};

const IDLE: GraphScopeState = {
  available: false,
  scope: "engaged",
  loading: false,
  shown: 0,
  total: 0,
};

let state: GraphScopeState = IDLE;
let controller: ((next: GraphScopeName) => void) | null = null;

const listeners = new Set<(next: GraphScopeState) => void>();

export function getGraphScopeState(): GraphScopeState {
  return state;
}

export function subscribeGraphScope(fn: (next: GraphScopeState) => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Called by the chart whenever any of this changes. Publishes only on a real change. */
export function publishGraphScope(patch: Partial<GraphScopeState>) {
  const next = { ...state, ...patch };
  if (
    next.available === state.available &&
    next.scope === state.scope &&
    next.loading === state.loading &&
    next.shown === state.shown &&
    next.total === state.total
  ) {
    return;
  }
  state = next;
  for (const fn of listeners) fn(state);
}

/**
 * The chart claims the right to act on requests, and gives it up on unmount.
 *
 * Releasing resets the state, so navigating away and back starts from the default rather than
 * leaving the header advertising the last visit's counts over a chart that no longer exists.
 * The dashboard's compact preview deliberately never registers: it renders the same module but
 * has no header control, and letting it publish would make the toggle describe the wrong chart.
 */
export function registerGraphScopeController(fn: (next: GraphScopeName) => void) {
  controller = fn;
  return () => {
    if (controller === fn) controller = null;
    state = IDLE;
    for (const l of listeners) l(state);
  };
}

/** Ask for a scope. A no-op when no chart is mounted, which is the honest answer. */
export function requestGraphScope(next: GraphScopeName) {
  controller?.(next);
}

/** Test seam — the module keeps process-wide state. */
export function __resetGraphScopeForTests() {
  controller = null;
  state = IDLE;
  listeners.clear();
}
