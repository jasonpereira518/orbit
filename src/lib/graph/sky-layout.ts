import {
  buildHybridGraphLayout,
  buildHybridGraphLayoutSteps,
  type HybridGraphLayout,
} from "@/lib/graph-layout";
import type { GraphPayload } from "@/components/graph/graph-chart-types";
import { markOpenStage } from "@/lib/graph/open-marks";

type Contacts = GraphPayload["contacts"];

/** The constellation's filter controls, as the chart holds them. */
export type SkyFilters = {
  company: string;
  school: string;
  minScore: string;
  keyword: string;
};

/** What the chart opens with — see the initial state in `network-graph.tsx`. */
export const DEFAULT_SKY_FILTERS: SkyFilters = {
  company: "all",
  school: "all",
  minScore: "1",
  keyword: "",
};

export function isDefaultSkyFilters(f: SkyFilters) {
  return (
    f.company === DEFAULT_SKY_FILTERS.company &&
    f.school === DEFAULT_SKY_FILTERS.school &&
    f.minScore === DEFAULT_SKY_FILTERS.minScore &&
    f.keyword.trim() === ""
  );
}

/** Who is in the sky for these filters. One function, so the opening layout and the chart agree. */
export function filterSkyContacts(contacts: Contacts, f: SkyFilters): Contacts {
  const kw = f.keyword.trim().toLowerCase();
  return contacts.filter((c) => {
    // No `substantive` check here: the server already shipped only what this scope draws,
    // so filtering again would be redundant — and would silently hide pinned-in contacts
    // in the "show all" view.
    if (f.company !== "all" && c.company !== f.company) return false;
    if (f.school !== "all" && (c.school || "") !== f.school) return false;
    const orbit = c.orbitScore ?? c.relationshipScore ?? 1;
    if (orbit < Number(f.minScore)) return false;
    if (kw) {
      const hay = [
        c.fullName,
        c.preferredName,
        c.company,
        c.school,
        c.title,
        c.aiSummary,
        ...(c.tags || []),
        ...(c.keyFacts || []),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!hay.includes(kw)) return false;
    }
    return true;
  });
}

/**
 * The opening sky's layout, computed ahead of the chart and off its render.
 *
 * Computed inside the chart's first render, the layout (~50ms at 10,000 contacts) and that
 * render ran as one long task. Here it runs as soon as the payload is in, in slices of at most
 * SLICE_MS between its phases, so the main thread is free to take input in between; the chart
 * then finds it waiting. Keyed on the payload's contacts array, so it lasts exactly as long as
 * that payload does and a new payload is a miss.
 */
const cache = new WeakMap<Contacts, { userName: string; layout: HybridGraphLayout }>();
const running = new WeakMap<Contacts, Promise<HybridGraphLayout>>();

const SLICE_MS = 10;

/** The opening layout for this payload, if it has already been computed. */
export function cachedSkyLayout(contacts: Contacts, userName: string) {
  const hit = cache.get(contacts);
  return hit && hit.userName === userName ? hit.layout : null;
}

/** Give the main thread back: `scheduler.yield()` where there is one, else a fresh task. */
function nextTask(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (typeof scheduler?.yield === "function") return scheduler.yield();
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => resolve();
    channel.port2.postMessage(null);
  });
}

/**
 * Compute the opening layout for `payload` in slices. Resolves once it is cached; a second call
 * for the same payload joins the first. Aborting stops it between slices (nothing is cached).
 */
export function precomputeSkyLayout(
  payload: GraphPayload,
  signal?: AbortSignal
): Promise<HybridGraphLayout> {
  const { contacts } = payload;
  const userName = payload.summary.userName;
  const hit = cachedSkyLayout(contacts, userName);
  if (hit) return Promise.resolve(hit);
  const inFlight = running.get(contacts);
  if (inFlight) return inFlight;

  const work = (async () => {
    const steps = buildHybridGraphLayoutSteps(
      filterSkyContacts(contacts, DEFAULT_SKY_FILTERS),
      userName
    );
    let sliceStart = performance.now();
    for (;;) {
      const step = steps.next();
      if (step.done) {
        cache.set(contacts, { userName, layout: step.value });
        markOpenStage("layout-computed");
        return step.value;
      }
      if (performance.now() - sliceStart > SLICE_MS) {
        await nextTask();
        if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
        sliceStart = performance.now();
      }
    }
  })();
  running.set(contacts, work);
  // An aborted run stops at its next slice, but stops being joinable at once: a caller that
  // aborts and immediately asks again (StrictMode's effect re-run) must get a live run.
  signal?.addEventListener("abort", () => {
    if (running.get(contacts) === work) running.delete(contacts);
  });
  const release = () => {
    if (running.get(contacts) === work) running.delete(contacts);
  };
  work.then(release, release);
  return work;
}

/** The layout for these filters: the precomputed one when it applies, else computed now. */
export function skyLayoutFor(
  contacts: Contacts,
  filtered: Contacts,
  filters: SkyFilters,
  userName: string
): HybridGraphLayout {
  if (isDefaultSkyFilters(filters)) {
    const hit = cachedSkyLayout(contacts, userName);
    if (hit) return hit;
  }
  const built = buildHybridGraphLayout(filtered, userName);
  markOpenStage("layout-computed");
  return built;
}
