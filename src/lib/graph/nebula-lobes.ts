/**
 * The shape of a cluster's wash — the soft coloured cloud a company or school sits in.
 *
 * Pure and DOM-free, so the chart (which draws them as CSS gradients) and the dashboard preview
 * (which draws them on a canvas) get the same cloud for the same company rather than two skies
 * that almost match.
 */

export type NebulaLobe = {
  /** Centre offset from the cluster's own centre, in layout px. */
  x: number;
  y: number;
  /** Ellipse radii, in layout px. */
  rx: number;
  ry: number;
  /** Fill strength at the centre of the lobe; it fades to nothing by `NEBULA_LOBE_EDGE`. */
  alpha: number;
};

/** Lobes per cluster. Offset, unequal ellipses read as blown-out debris. */
const LOBES = 5;
/** The wash's box runs this many radii across, so it dissolves before any boundary. */
export const NEBULA_BOX_RADII = 4;
/** Where a lobe's fill reaches nothing, as a share of its radius. */
export const NEBULA_LOBE_EDGE = 0.72;
/** Where the fill has dropped to 45% of the centre, as a share of its radius. */
export const NEBULA_LOBE_MID = 0.36;

function nebulaHash(seed: string, salt: number) {
  let h = (2166136261 ^ salt) >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h ^ seed.charCodeAt(i)) >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h % 10000) / 10000;
}

/** The lobes of one cluster's wash, seeded by its name so it looks the same every time. */
export function nebulaLobes(company: string, radius: number): NebulaLobe[] {
  return Array.from({ length: LOBES }, (_, i) => {
    const angle = nebulaHash(company, i * 9 + 1) * Math.PI * 2;
    const dist = (0.06 + nebulaHash(company, i * 9 + 2) * 0.45) * radius;
    const rx = (0.5 + nebulaHash(company, i * 9 + 3) * 0.65) * radius;
    const ry = rx * (0.5 + nebulaHash(company, i * 9 + 4) * 0.6);
    return {
      x: Math.cos(angle) * dist,
      y: Math.sin(angle) * dist,
      rx,
      ry,
      alpha: 0.075 - i * 0.011,
    };
  });
}
