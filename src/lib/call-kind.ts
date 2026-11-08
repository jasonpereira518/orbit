/**
 * Which video-call app a shared window belongs to, from its track label.
 *
 * Chrome labels a shared WINDOW with its title ("Zoom Meeting", "Microsoft Teams"); a shared
 * tab's label is an opaque id, and Safari/Firefox say less still, so this is a fallback for
 * when no calendar invite names the call. Only the kind is kept, never the raw title.
 */
export type CallKind = "zoom" | "teams" | "meet" | "webex";

const RULES: [RegExp, CallKind][] = [
  [/\bzoom\b/i, "zoom"],
  [/\b(?:microsoft )?teams\b/i, "teams"],
  [/\bgoogle meet\b|meet\.google\.com|^meet\s*[-–—]/i, "meet"],
  [/\bwebex\b/i, "webex"],
];

export function callKindFromLabel(label: string | null | undefined): CallKind | null {
  if (!label) return null;
  return RULES.find(([re]) => re.test(label))?.[1] ?? null;
}

/**
 * `meeting_sessions.capture_surface` carries the call as a suffix ("window:zoom").
 * ponytail: packed into one text column to skip a schema bump; give it its own column if
 * anything ever needs to query by call kind.
 */
export function packSurface(surface: string | null, call: CallKind | null): string | null {
  return surface && call ? `${surface}:${call}` : surface;
}

export function callFromSurface(surface: string | null | undefined): CallKind | null {
  const kind = surface?.split(":")[1];
  return kind === "zoom" || kind === "teams" || kind === "meet" || kind === "webex" ? kind : null;
}
