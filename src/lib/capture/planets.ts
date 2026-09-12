/**
 * One planet per person, in the order you would recite them. Pure so the badge, the
 * summary rows and the smoke test share one table.
 *
 * The first eight have art in `public/landing/planets/`; the rest are drawn as CSS
 * spheres from the palette here, under the same glow and terminator so the two kinds
 * read as one set. Fifteen bodies, then it wraps — a batch that large is rare, and two
 * people sharing Mercury at cards 1 and 16 is no worse than any other icon repeating.
 */
export const PLANET_ORDER = [
  "mercury",
  "venus",
  "earth",
  "mars",
  "jupiter",
  "saturn",
  "uranus",
  "neptune",
  "pluto",
  "ceres",
  "eris",
  "moon",
  "titan",
  "europa",
  "ganymede",
] as const;

export type PlanetId = (typeof PLANET_ORDER)[number];

export type PlanetDef = {
  id: PlanetId;
  label: string;
  /** `raster` = a `<picture>` from public/landing/planets; `css` = a gradient sphere. */
  kind: "raster" | "css";
  /** The atmosphere glow, as an rgba string (the landing hero uses the same values). */
  glow: string;
  /** Three stops for the CSS sphere: highlight, body, limb. Raster bodies carry them too, for the summary dot. */
  stops: [string, string, string];
  rings?: boolean;
};

export const PLANETS: Record<PlanetId, PlanetDef> = {
  mercury: { id: "mercury", label: "Mercury", kind: "raster", glow: "rgba(190, 180, 170, 0.45)", stops: ["#d9d2c9", "#8f8780", "#3d3833"] },
  venus: { id: "venus", label: "Venus", kind: "raster", glow: "rgba(236, 200, 140, 0.55)", stops: ["#f6e2b5", "#d8a862", "#6b4a22"] },
  earth: { id: "earth", label: "Earth", kind: "raster", glow: "rgba(110, 170, 240, 0.6)", stops: ["#b9dcff", "#3f7fd0", "#0e2a55"] },
  mars: { id: "mars", label: "Mars", kind: "raster", glow: "rgba(230, 120, 80, 0.55)", stops: ["#f3b28f", "#c8603a", "#4f2114"] },
  jupiter: { id: "jupiter", label: "Jupiter", kind: "raster", glow: "rgba(220, 180, 140, 0.5)", stops: ["#f0d7b8", "#c2916a", "#5a3a25"] },
  saturn: { id: "saturn", label: "Saturn", kind: "raster", glow: "rgba(230, 205, 150, 0.55)", stops: ["#f3e1b6", "#d0b07a", "#5e4a2a"], rings: true },
  uranus: { id: "uranus", label: "Uranus", kind: "raster", glow: "rgba(150, 220, 230, 0.55)", stops: ["#d7f4f7", "#87cfd8", "#1f5560"], rings: true },
  neptune: { id: "neptune", label: "Neptune", kind: "raster", glow: "rgba(90, 130, 230, 0.6)", stops: ["#a9bfff", "#3a5fd6", "#0f1f5c"] },
  pluto: { id: "pluto", label: "Pluto", kind: "css", glow: "rgba(200, 185, 175, 0.45)", stops: ["#e8ddd3", "#a8968a", "#4a3d36"] },
  ceres: { id: "ceres", label: "Ceres", kind: "css", glow: "rgba(170, 170, 175, 0.4)", stops: ["#cfcfd2", "#7f7f84", "#2f2f33"] },
  eris: { id: "eris", label: "Eris", kind: "css", glow: "rgba(215, 220, 230, 0.45)", stops: ["#f4f6fa", "#b7bfcc", "#4b5361"] },
  moon: { id: "moon", label: "The Moon", kind: "css", glow: "rgba(210, 210, 215, 0.5)", stops: ["#eeeeef", "#9d9ea3", "#3c3d42"] },
  titan: { id: "titan", label: "Titan", kind: "css", glow: "rgba(235, 170, 90, 0.5)", stops: ["#f7d19a", "#d9924a", "#5e3a15"] },
  europa: { id: "europa", label: "Europa", kind: "css", glow: "rgba(220, 205, 190, 0.45)", stops: ["#f6efe6", "#c9b7a4", "#5c4c3e"] },
  ganymede: { id: "ganymede", label: "Ganymede", kind: "css", glow: "rgba(180, 175, 170, 0.45)", stops: ["#d8d1c8", "#8b847c", "#3a3531"] },
};

export function planetForIndex(index: number): PlanetDef {
  const n = PLANET_ORDER.length;
  const i = ((Math.floor(index) % n) + n) % n;
  return PLANETS[PLANET_ORDER[i]!];
}
