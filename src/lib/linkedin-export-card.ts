/** LinkedIn takes about a day to package an export. */
const READY_AFTER_MS = 24 * 60 * 60 * 1000;

export type LinkedInCardState =
  | { show: false }
  | { show: true; mode: "start" }
  | { show: true; mode: "requested"; readyIso: string };

/**
 * The dashboard and /imports card that replaced onboarding's LinkedIn step: start the export,
 * then "should be ready about …" until something from LinkedIn is imported. Pure, so both
 * pages and the smoke agree.
 */
export function linkedinCardState(input: {
  imported: boolean;
  requestedAt: Date | string | null;
  onboardingDone: boolean;
}): LinkedInCardState {
  if (!input.onboardingDone || input.imported) return { show: false };
  if (!input.requestedAt) return { show: true, mode: "start" };
  const at = new Date(input.requestedAt).getTime();
  return { show: true, mode: "requested", readyIso: new Date(at + READY_AFTER_MS).toISOString() };
}
