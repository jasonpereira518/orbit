/**
 * The eight planets, ordered by distance from the sun — the art lives in
 * `public/landing/planets/`.
 *
 * Client-safe on purpose: the boarding pass renders a planet in the browser, and the module
 * that used to own these (`interest-list-email.ts`) imports `resend` and `node:crypto`,
 * neither of which belongs in a client bundle.
 */
export const WELCOME_PLANETS = [
  "mercury",
  "venus",
  "earth",
  "mars",
  "jupiter",
  "saturn",
  "uranus",
  "neptune",
] as const;
export type WelcomePlanet = (typeof WELCOME_PLANETS)[number];

/**
 * Maps a 1-based signup number onto the planet that signup receives: the 1st gets Mercury,
 * the 8th Neptune, the 9th Mercury again.
 *
 * Defensive about its input because the caller derives it from a COUNT that could in
 * principle come back 0 or non-finite — a negative index would otherwise read off the end
 * of the array and hand `undefined` to the template.
 */
export function planetForSignupNumber(signupNumber: number): WelcomePlanet {
  const n = Number.isFinite(signupNumber) ? Math.floor(signupNumber) : 1;
  return WELCOME_PLANETS[Math.max(0, n - 1) % WELCOME_PLANETS.length];
}

/**
 * Narrows the stored `welcome_planet` text back to the union. Rows written before that
 * column existed hold null, so the fallback is not theoretical — and an unrecognised value
 * must not reach a template, where it would build a 404 image URL.
 */
export function asWelcomePlanet(value: string | null | undefined): WelcomePlanet {
  return (WELCOME_PLANETS as readonly string[]).includes(value ?? "")
    ? (value as WelcomePlanet)
    : WELCOME_PLANETS[0];
}

/** "mars" → "Mars". */
export function planetLabel(planet: WelcomePlanet): string {
  return planet.charAt(0).toUpperCase() + planet.slice(1);
}

/** Atmosphere glow per planet — the same values `hero-solar-system.tsx` uses. */
export const PLANET_GLOW: Record<WelcomePlanet, string> = {
  mercury: "rgba(170, 160, 150, 0.45)",
  venus: "rgba(220, 190, 120, 0.5)",
  earth: "rgba(80, 160, 220, 0.55)",
  mars: "rgba(200, 100, 70, 0.5)",
  jupiter: "rgba(200, 160, 100, 0.45)",
  saturn: "rgba(210, 190, 140, 0.45)",
  uranus: "rgba(140, 210, 210, 0.5)",
  neptune: "rgba(70, 120, 220, 0.55)",
};
