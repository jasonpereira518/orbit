/**
 * Pure predicates over the guided tour's columns on `user_settings`, shared by the (app)
 * layout (should the coach rail mount?), the /onboarding page (is a tour already running?),
 * Settings → Help (offer Resume?) and the dashboard's setup card.
 *
 * `onboarding_completed_at` is stamped by the handoff in the same UPDATE as
 * `tour_started_at`, so the first-run gate never has to know about any of this: a person
 * mid-tour is simply past the gate, and their progress lives here.
 */
export type TourStateRow = {
  tourStartedAt: Date | string | null;
  tourExitedAt: Date | string | null;
  tourCompletedAt: Date | string | null;
};

/** The handoff happened and the finish card has not been reached. */
export function tourInProgress(s: TourStateRow): boolean {
  return s.tourStartedAt != null && s.tourCompletedAt == null;
}

/** The coach rail should be on screen. */
export function tourRailVisible(s: TourStateRow): boolean {
  return tourInProgress(s) && s.tourExitedAt == null;
}

/** Exited part-way: the rail is hidden, and a Resume door should be offered. */
export function tourResumable(s: TourStateRow): boolean {
  return tourInProgress(s) && s.tourExitedAt != null;
}
