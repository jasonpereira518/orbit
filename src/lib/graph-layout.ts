import { initialsFromName } from "@/lib/initials";
import {
  buildConstellationFit,
  constellationFitEdges,
  orderConstellationMembers,
  clampScore,
  placementScore,
  type ClusterFit,
  type FitPart,
} from "@/lib/constellation-fit";
import { isCometContact } from "@/lib/comet";
import { scaleForStarCount, type ConstellationShape } from "@/lib/constellation-shapes";
import type { ClusterForm, PartRole } from "@/lib/constellation-parts";
import { arrangeParts, ringLayout } from "@/lib/graph/cluster-anatomy";
import { classifyTitle } from "@/lib/role-function";
import { type BuiltCluster, type ClusterKind } from "@/lib/constellation-clusters";
import { companyFamilyRoot } from "@/lib/company-family";
import { buildClusterAffinity } from "@/lib/constellation-affinity";
import { placeClusterDisks } from "@/lib/graph/disk-placement";
import { buildGalaxyStructure, type GalaxyStructure } from "@/lib/graph/galaxy-structure";
import { peerEdgeToLayoutEdge, type PeerEdge } from "@/lib/network-metrics";
import {
  clusterBrandColor,
  mixWithWhite,
  withAlpha,
} from "@/lib/school-color";
import { hashUnit } from "@/lib/hash";
import { hashUnitStream } from "@/lib/hash-stream";

export { orderConstellationMembers };

/** What each closeness score is called in the inspect panel. */
export const RING_LABELS: Record<number, string> = {
  5: "Core orbit",
  4: "Inner orbit",
  3: "Mid orbit",
  2: "Outer orbit",
  1: "Deep space",
};

export type GraphContactInput = {
  id: string;
  fullName: string;
  preferredName?: string | null;
  company: string | null;
  school?: string | null;
  title: string | null;
  relationshipScore: number;
  closeness?: number;
  closenessTier?: "inner" | "mid" | "outer";
  orbitScore?: number;
  lastInteractionAt: Date | string | null;
  nextFollowUpAt: Date | string | null;
  tags: string[];
  aiSummary: string | null;
  keyFacts: string[] | null;
  metContext?: string | null;
  dateMet?: Date | string | null;
  howMet?: string | null;
  email?: string | null;
  phone?: string | null;
  linkedinUrl?: string | null;
  website?: string | null;
  profileImageUrl?: string | null;
  notes?: string | null;
  sharedInterests?: string[] | null;
  dormant?: boolean;
  /** True only when an `interactions` row exists. See ClosenessCohortResult.interactedIds. */
  hasLoggedInteraction?: boolean;
};

export type GraphNodeData = {
  kind: "user" | "contact";
  label: string;
  fullName?: string;
  preferredName?: string | null;
  initials: string;
  company?: string | null;
  school?: string | null;
  title?: string | null;
  score?: number;
  relationshipScore?: number;
  closeness?: number;
  closenessTier?: "inner" | "mid" | "outer";
  comet?: boolean;
  overdue?: boolean;
  tags?: string[];
  aiSummary?: string | null;
  keyFacts?: string[];
  lastInteractionAt?: string | null;
  /**
   * Whether `lastInteractionAt` describes a real touch. It is stamped on every create
   * and import, so on its own it cannot be labelled "last interaction" honestly.
   */
  hasLoggedInteraction?: boolean;
  nextFollowUpAt?: string | null;
  metContext?: string | null;
  dateMet?: string | null;
  howMet?: string | null;
  email?: string | null;
  phone?: string | null;
  linkedinUrl?: string | null;
  website?: string | null;
  profileImageUrl?: string | null;
  clusterId?: string;
  clusterName?: string;
  clusterKind?: ClusterKind;
  /** Whether this star traces the constellation figure or scatters around it. */
  figureRole?: "figure" | "scatter";
  /** Brand color of the star's cluster (undefined for Deep Space singletons). */
  clusterColor?: string;
  /** Which part of its cluster the star belongs to (see `constellation-parts.ts`). */
  partKey?: string;
  partRole?: PartRole;
  /** In a split company: whether the title puts them in the leadership core's league. */
  leader?: boolean;
  orbitAngle?: number;
  orbitRadius?: number;
  spotlight?: boolean;
  /** The one-and-only search hit — bobs gently so the eye lands on it. */
  spotlightSolo?: boolean;
  /** Hovered, selected or the sole search hit: labelled at every zoom, whatever overlaps it. */
  labelPinned?: boolean;
  /** Lost the label collision pass: its name would overlap a higher-priority one. */
  labelHidden?: boolean;
  /** Hovered or selected: drawn above its neighbours. Set per render by the chart. */
  raised?: boolean;
  /** Newly arrived in the sky: plays the entrance once. Set per render by the chart. */
  entering?: boolean;
};

export type ClusterLabelData = {
  kind: "clusterLabel";
  label: string;
  count?: number;
  nebulaColor?: string;
  clusterKind?: ClusterKind;
  clusterId?: string;
  /**
   * The zoomed-out summary view is on: the cluster stands in for its members, so its label
   * carries their headcount. Set per render by the chart, not by the layout.
   */
  summary?: boolean;
  /**
   * The node's box, in layout px: the cluster's stars plus room above them for the name. The
   * node spans the whole cluster so it is on screen whenever any of the cluster is — which is
   * what lets the name stay pinned in view while you are zoomed in on it.
   */
  box?: { width: number; height: number };
  /** Where the name's bottom-centre sits, in px from the box's top-left: just above the top star. */
  anchor?: { x: number; y: number };
  /** How the cluster is drawn — see `constellation-parts.ts`. */
  form?: ClusterForm;
  /** A split company's core and petal names, anchored like `anchor`. */
  petalLabels?: Array<{
    key: string;
    label: string;
    role: "core" | "petal";
    count: number;
    anchor: { x: number; y: number };
  }>;
  /** Zoomed in far enough to pin the name in view. Set per render by the chart. */
  pinnable?: boolean;
};

export type NebulaData = {
  kind: "nebula";
  company: string;
  color: string;
  radius: number;
  clusterKind?: ClusterKind;
  clusterId?: string;
};

export type LayoutNode = {
  id: string;
  type: "user" | "contact" | "clusterLabel" | "nebula";
  data: GraphNodeData | ClusterLabelData | NebulaData;
  position: { x: number; y: number };
  draggable?: boolean;
  selectable?: boolean;
  zIndex?: number;
};

export type EdgeKind = "solar" | "constellation" | "knows";

export type LayoutEdge = {
  id: string;
  source: string;
  target: string;
  type: "straight" | "labeled";
  animated?: boolean;
  label?: string;
  data?: {
    kind: EdgeKind;
    company?: string;
    reason?:
      | "company"
      | "role"
      | "school"
      | "event"
      | "howMet"
      | "mention"
      | "sharedTags"
      | "sharedInterests";
    label?: string;
    brandColor?: string;
  };
  style?: Record<string, string | number>;
};

export function displayName(c: {
  fullName: string;
  preferredName?: string | null;
}) {
  const preferred = (c.preferredName || "").trim();
  return preferred || c.fullName;
}


function toIso(value: Date | string | null | undefined) {
  if (!value) return null;
  if (typeof value === "string") return value;
  return value.toISOString();
}

function isOverdue(nextFollowUpAt: Date | string | null | undefined) {
  if (!nextFollowUpAt) return false;
  const d =
    typeof nextFollowUpAt === "string"
      ? new Date(nextFollowUpAt)
      : nextFollowUpAt;
  return d.getTime() < Date.now();
}

type PolarPosition = { x: number; y: number; angle: number; radius: number };

/** Layout px between a cluster's highest star and the bottom of its name — clear of its glow. */
const CLUSTER_LABEL_GAP = 22;
/** Room reserved above that for the name itself, so the node's box contains it. */
const CLUSTER_LABEL_HEAD = 48;
/** Margin around the stars on the other three sides of the box. */
const CLUSTER_LABEL_PAD = 24;

function toPosition(x: number, y: number): PolarPosition {
  return { x, y, angle: Math.atan2(y, x), radius: Math.hypot(x, y) };
}

/**
 * Every star carries an always-visible name + role label (see
 * graph-nodes.tsx), so spacing is driven by label size rather than star
 * size: LABEL_WIDTH horizontally, LABEL_HEIGHT vertically.
 */
const LABEL_WIDTH = 104;
const LABEL_HEIGHT = 30;

/** Clear sky between the sun and the nearest cluster. */
const SUN_CLEAR = 180;
/** Minimum clearance between two cluster footprints. */
const CLUSTER_GAP = LABEL_WIDTH;
/** Scatter field starts this far beyond the figure's extent. */
const SCATTER_CLEAR = 54;
/** Initial width of a cluster's scatter field annulus. */
const SCATTER_FIELD_WIDTH = 110;
/** Headroom beyond the outermost scatter star inside the footprint. */
const FOOT_MARGIN = 34;
/** Clear space between two parts of one company (its core and petals), edge to edge. */
const PART_GAP = 64;
/** Gap between the galaxy's edge and the start of the halo. */
const BACKGROUND_GAP = 90;
/** Minimum distance between any two figure stars after scaling. */
const FIGURE_STAR_MIN = LABEL_WIDTH;
/** How far a tight template may be upscaled to clear FIGURE_STAR_MIN. */
const FIGURE_MAX_UPSCALE = 2.4;

/**
 * Two stars may not sit inside each other's label boxes: they need either
 * horizontal room for a label, or enough vertical room that a label clears
 * the star below it.
 */
const LABEL_CLEAR_X = LABEL_WIDTH + 8;
const LABEL_CLEAR_Y = LABEL_HEIGHT + 14;

function labelClear(
  a: { x: number; y: number },
  b: { x: number; y: number }
) {
  return (
    Math.abs(a.x - b.x) >= LABEL_CLEAR_X || Math.abs(a.y - b.y) >= LABEL_CLEAR_Y
  );
}

const GRID_OFFSET = 2 ** 20;
const GRID_STRIDE = 2 ** 21;

/**
 * The placed stars, bucketed so a clearance test looks at neighbours rather than everyone.
 *
 * Cells are exactly one label-clearance box wide and tall. Two stars conflict only when they
 * are closer than LABEL_CLEAR_X horizontally AND LABEL_CLEAR_Y vertically, so any conflict
 * sits in the candidate's cell or one of its eight neighbours — the answer is the same as
 * testing every placed star with `labelClear`, which is what this replaced. That linear scan
 * ran for every candidate of every star, and all of a network's unclustered contacts share
 * one field, so it grew with the square of the network.
 */
class ClearanceGrid {
  private cells = new Map<number, Array<{ x: number; y: number }>>();

  /**
   * One number per cell rather than a `"cx,cy"` string: the test below looks up nine cells per
   * candidate, and building and hashing those strings was most of the layout's time at 10,000
   * contacts. Exact for |cx|, |cy| < 2^20 cells — over a hundred million world px either way.
   */
  private static key(cx: number, cy: number) {
    return (cx + GRID_OFFSET) * GRID_STRIDE + (cy + GRID_OFFSET);
  }

  add(p: { x: number; y: number }) {
    const k = ClearanceGrid.key(
      Math.floor(p.x / LABEL_CLEAR_X),
      Math.floor(p.y / LABEL_CLEAR_Y)
    );
    const cell = this.cells.get(k);
    if (cell) cell.push(p);
    else this.cells.set(k, [p]);
  }

  /** True when `labelClear(candidate, p)` holds for every star added so far. */
  clear(candidate: { x: number; y: number }) {
    const cx = Math.floor(candidate.x / LABEL_CLEAR_X);
    const cy = Math.floor(candidate.y / LABEL_CLEAR_Y);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const cell = this.cells.get(ClearanceGrid.key(cx + dx, cy + dy));
        if (!cell) continue;
        for (const p of cell) {
          if (!labelClear(candidate, p)) return false;
        }
      }
    }
    return true;
  }
}

/**
 * Scatter members organically through an annulus — no rings, no lattice.
 * Seeded rejection sampling: each member tries hash-driven spots until one
 * clears every already-placed star's label box; when an annulus fills up it
 * widens and the sampling continues. Deterministic and guaranteed to leave
 * breathing room between nodes.
 */
function scatterField(
  ids: string[],
  seedPrefix: string,
  inner: number,
  initialWidth: number,
  avoid: Array<{ x: number; y: number }>
): { placed: Array<{ id: string; x: number; y: number }>; outer: number } {
  const placed: Array<{ id: string; x: number; y: number }> = [];
  const occupied = new ClearanceGrid();
  for (const p of avoid) occupied.add(p);
  let outer = inner + initialWidth;

  for (const id of ids) {
    let spot: { x: number; y: number } | null = null;
    let attempt = 0;
    let rounds = 0;
    // The same values as hashUnit(seedPrefix + ":" + id, salt), hashing the string once per star.
    const hash = hashUnitStream(`${seedPrefix}:${id}`);
    while (!spot && rounds < 200) {
      for (let tries = 0; tries < 24 && !spot; tries++, attempt++) {
        const u = hash(attempt * 2 + 1);
        const v = hash(attempt * 2 + 2);
        const angle = u * Math.PI * 2;
        // sqrt() → uniform density over the annulus
        const radius = Math.sqrt(
          inner * inner + v * (outer * outer - inner * inner)
        );
        const candidate = {
          x: Math.cos(angle) * radius,
          y: Math.sin(angle) * radius,
        };
        if (occupied.clear(candidate)) {
          spot = candidate;
        }
      }
      if (!spot) {
        outer += 40;
        rounds += 1;
      }
    }
    // Practically unreachable — the annulus grows until a spot clears.
    if (!spot) {
      outer += LABEL_CLEAR_X;
      spot = { x: outer, y: 0 };
    }
    placed.push({ id, ...spot });
    occupied.add(spot);
  }

  const maxR = placed.reduce((m, p) => Math.max(m, Math.hypot(p.x, p.y)), inner);
  return { placed, outer: Math.max(outer, maxR) };
}

/** The halo's width scale never exceeds this fraction of the disk's radius, nor drops below the floor. */
const HALO_SCALE_FRACTION = 0.2;
const HALO_MIN_SCALE = 160;
/** How far into the exponential's tail a halo star may fall: -ln(1 - 0.95) is about three scales. */
const HALO_TAIL = 0.95;
/** Room a halo star's label needs, doubled so the band is comfortably loose. */
const HALO_ROOM = 2;

/**
 * Unaffiliated stars, drifting beyond the galaxy's edge and thinning with distance.
 *
 * The old deep-space rim was a uniform annulus, which drew a perfect dotted circle. Here the
 * radius falls off exponentially from `inner`, so the halo is densest where the galaxy ends
 * and fades into empty sky, with noise on the angle. Same seeded rejection sampling against
 * label boxes as `scatterField`; when the band fills up it widens.
 *
 * How far it fades is sized from what has to fit, not from the galaxy: the home view frames
 * the farthest star, so a halo that trailed off to twice the disk's radius shrank the whole
 * sky. The stars need `count` label boxes, doubled for slack, spread round a ring of radius
 * `inner`; that area over the ring's length is the band's width, and the exponential's scale
 * is a third of it because the tail is cut at three scales. It is clamped between a floor
 * (a thin halo would draw a ring again) and a fraction of the disk's radius (a huge network
 * needs no more sky than that). The widening fallback still applies if a band fills.
 */
function haloField(
  ids: string[],
  inner: number
): Array<{ id: string; x: number; y: number }> {
  const placed: Array<{ id: string; x: number; y: number }> = [];
  const occupied = new ClearanceGrid();
  const width = (ids.length * LABEL_CLEAR_X * LABEL_CLEAR_Y * HALO_ROOM) / (2 * Math.PI * inner);
  let scale = Math.min(
    inner * HALO_SCALE_FRACTION,
    Math.max(HALO_MIN_SCALE, width / 3)
  );

  for (const id of ids) {
    let spot: { x: number; y: number } | null = null;
    let attempt = 0;
    const hash = hashUnitStream(`halo:${id}`);
    for (let rounds = 0; !spot && rounds < 200; rounds++) {
      for (let tries = 0; tries < 24 && !spot; tries++, attempt++) {
        const u = hash(attempt * 2 + 1);
        const v = hash(attempt * 2 + 2);
        const radius = inner - Math.log(1 - u * HALO_TAIL) * scale;
        const angle = v * Math.PI * 2;
        const candidate = { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
        if (occupied.clear(candidate)) spot = candidate;
      }
      if (!spot) scale *= 1.15;
    }
    // Practically unreachable — the band widens until a spot clears.
    if (!spot) spot = { x: inner + scale, y: 0 };
    placed.push({ id, ...spot });
    occupied.add(spot);
  }
  return placed;
}

/** One part's local geometry: its figure stars plus a scatter field. */
export type PartGeometry = {
  part: FitPart;
  /** Where the part's own origin sits in the cluster's local space. */
  center: { x: number; y: number };
  /** Cluster-local, already offset by `center` (index ↔ part.figureMemberIds). */
  figureLocal: Array<{ x: number; y: number }>;
  scatterLocal: Array<{ id: string; x: number; y: number }>;
  /** The part's own footprint radius about `center`. */
  foot: number;
};

/** One cluster's local geometry: its parts and the disk that holds them all. */
export type ClusterGeometry = {
  cluster: BuiltCluster;
  fit: ClusterFit;
  parts: PartGeometry[];
  /** Footprint radius: everything the cluster draws stays inside this disk. */
  foot: number;
};

type LocalPart = Omit<PartGeometry, "part" | "center">;

/**
 * A figure and its scatter, in the part's own space. The asterism renders at its natural scale
 * with a mild seeded tilt — never warped — and is scaled up only if a template packs two stars
 * closer than FIGURE_STAR_MIN (or, with `clearNames`, than their name boxes need). Overflow
 * members scatter through an annulus fully outside the figure's extent, which guarantees
 * clearance from every figure star and line by construction.
 */
function figureGeometry(
  shape: ConstellationShape,
  figureMemberIds: string[],
  scatterIds: string[],
  seed: string,
  clearNames = false
): LocalPart {
  const count = figureMemberIds.length;
  const baseScale = scaleForStarCount(count);
  let scale = baseScale;
  const rotation = (hashUnit(seed, 11) - 0.5) * Math.PI * 0.5;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);

  const stars = shape.stars.slice(0, count);
  if (count > 1) {
    let minDist = Infinity;
    for (let i = 0; i < stars.length; i++) {
      for (let j = i + 1; j < stars.length; j++) {
        minDist = Math.min(minDist, Math.hypot(stars[i].x - stars[j].x, stars[i].y - stars[j].y));
      }
    }
    if (minDist > 0 && minDist * scale < FIGURE_STAR_MIN) {
      // Open the figure up until its tightest pair clears a label, but never
      // so far that one cluster swallows the sky.
      scale = Math.min(FIGURE_STAR_MIN / minDist, baseScale * FIGURE_MAX_UPSCALE);
    }
  }

  if (clearNames && count > 1) {
    // FIGURE_STAR_MIN is a circle, but a name is a LABEL_WIDTH x LABEL_HEIGHT box: a pair 106px
    // apart along a tilted diagonal can still have overlapping names. Open the figure just far
    // enough that no two name boxes touch. Only petal-company parts ask for this: every other
    // cluster keeps the scale it has always had, so a plain constellation never moves. This
    // deliberately ignores FIGURE_MAX_UPSCALE: the bump is measured at no more than ~4.1% and the
    // templates are fixed, so it cannot run away. Do not cap it, or a clash could come back.
    let need = 0;
    for (let i = 0; i < stars.length; i++) {
      for (let j = i + 1; j < stars.length; j++) {
        const dx = Math.abs((stars[i].x - stars[j].x) * cos - (stars[i].y - stars[j].y) * sin);
        const dy = Math.abs((stars[i].x - stars[j].x) * sin + (stars[i].y - stars[j].y) * cos);
        if (dx < 1e-9 && dy < 1e-9) continue;
        need = Math.max(need, Math.min(LABEL_WIDTH / (dx || Infinity), LABEL_HEIGHT / (dy || Infinity)));
      }
    }
    if (need * (1 + 1e-6) > scale) scale = need * (1 + 1e-6);
  }

  const figureLocal = stars.map((s) => ({
    x: (s.x * cos - s.y * sin) * scale,
    y: (s.x * sin + s.y * cos) * scale,
  }));
  const figureExtent = figureLocal.reduce((m, p) => Math.max(m, Math.hypot(p.x, p.y)), scale * 0.3);

  const { placed: scatterLocal, outer } = scatterField(
    scatterIds,
    seed,
    figureExtent + SCATTER_CLEAR,
    SCATTER_FIELD_WIDTH,
    figureLocal
  );
  const outermost = scatterLocal.length > 0 ? outer : figureExtent;
  return { figureLocal, scatterLocal, foot: outermost + FOOT_MARGIN };
}

/** A school: members on rings, the overflow scattered outside them. */
function ringGeometry(figureMemberIds: string[], scatterIds: string[], seed: string): LocalPart {
  const { positions, radius } = ringLayout(figureMemberIds.length, seed);
  const { placed: scatterLocal, outer } = scatterField(
    scatterIds,
    seed,
    radius + SCATTER_CLEAR,
    SCATTER_FIELD_WIDTH,
    positions
  );
  const outermost = scatterLocal.length > 0 ? outer : radius;
  return { figureLocal: positions, scatterLocal, foot: outermost + FOOT_MARGIN };
}

/**
 * Build a cluster's local geometry, part by part.
 *
 * A cluster that is not split is one part built exactly as it always was (same seed, so the
 * same tilt and scatter). A petal company builds each part — the leadership core and every
 * function petal — the same way under its own seed, then `arrangeParts` seats the core at the
 * origin and the petals round it on disjoint footprints.
 */
export function buildClusterGeometry(
  fit: ClusterFit,
  /**
   * People seated in this cluster's field without being members of it: loners from the same
   * company family (see `familySatellites`). Placed after the members, so further out — in the
   * largest petal, for a company that is split.
   */
  satelliteIds: string[] = []
): ClusterGeometry {
  const { cluster, form, parts } = fit;
  const roomiest = parts.reduce(
    (best, p, i) =>
      p.role !== "core" && p.figureMemberIds.length + p.scatterMemberIds.length >
        best.size
        ? { i, size: p.figureMemberIds.length + p.scatterMemberIds.length }
        : best,
    { i: 0, size: -1 }
  ).i;

  const built = parts.map((part, i) => {
    const seed = form === "petal" ? `${cluster.id}#${part.key}` : cluster.id;
    const scatterIds = [...part.scatterMemberIds, ...(i === roomiest ? satelliteIds : [])];
    return form === "ring"
      ? ringGeometry(part.figureMemberIds, scatterIds, seed)
      : figureGeometry(part.shape, part.figureMemberIds, scatterIds, seed, form === "petal");
  });

  if (form !== "petal") {
    return {
      cluster,
      fit,
      parts: [{ part: parts[0], center: { x: 0, y: 0 }, ...built[0] }],
      foot: built[0].foot,
    };
  }

  const coreIndex = parts.findIndex((p) => p.role === "core");
  const arranged = arrangeParts(
    coreIndex >= 0 ? { key: parts[coreIndex].key, foot: built[coreIndex].foot } : null,
    parts
      .map((p, i) => ({ key: p.key, foot: built[i].foot, role: p.role }))
      .filter((p) => p.role === "petal")
      .map(({ key, foot }) => ({ key, foot })),
    PART_GAP,
    cluster.id
  );
  return {
    cluster,
    fit,
    foot: arranged.foot,
    parts: parts.map((part, i) => {
      const center = arranged.centers.get(part.key)!;
      return {
        part,
        center,
        foot: built[i].foot,
        figureLocal: built[i].figureLocal.map((p) => ({ x: center.x + p.x, y: center.y + p.y })),
        scatterLocal: built[i].scatterLocal.map((p) => ({ id: p.id, x: center.x + p.x, y: center.y + p.y })),
      };
    }),
  };
}

/**
 * People who belong near a cluster they are not in.
 *
 * A company needs two people to become a constellation, so the one person at Google DeepMind
 * was scattered across the rim of the sky with everyone unclustered — nowhere near Google. Any
 * contact outside a constellation whose company is a known family (see `companyFamilyRoot`)
 * is seated in the outer field of that family's largest cluster instead. They are placed there,
 * not added to it: the cluster's name, headcount and search hits still mean its own members.
 */
function familySatellites(
  contacts: GraphContactInput[],
  eligible: BuiltCluster[]
): Map<string, string[]> {
  const inConstellation = new Set(eligible.flatMap((c) => c.contactIds));
  const headByRoot = new Map<string, BuiltCluster>();
  for (const cluster of eligible) {
    if (cluster.kind !== "company") continue;
    const root = companyFamilyRoot(cluster.name);
    if (!root) continue;
    const head = headByRoot.get(root);
    if (!head || cluster.count > head.count) headByRoot.set(root, cluster);
  }
  const satellites = new Map<string, string[]>();
  if (headByRoot.size === 0) return satellites;
  for (const c of [...contacts].sort((a, b) => a.id.localeCompare(b.id))) {
    if (inConstellation.has(c.id)) continue;
    const root = companyFamilyRoot(c.company);
    const head = root ? headByRoot.get(root) : undefined;
    if (!head) continue;
    const list = satellites.get(head.id);
    if (list) list.push(c.id);
    else satellites.set(head.id, [c.id]);
  }
  return satellites;
}

/**
 * The galaxy:
 * - Sun at the center inside a clear core.
 * - Each company / role / school cluster draws its asterism, undistorted, with overflow
 *   members ringed around it, inside a footprint disk.
 * - Disks are placed by relatedness — family, alumni, shared tags — so near means related
 *   (`constellation-affinity.ts`, `graph/disk-placement.ts`), with the biggest clusters
 *   anchoring the middle. Nothing overlaps: stars, figures, lines and disks keep their distance.
 * - Everyone no cluster claimed drifts in a halo beyond the disk, thinning outward.
 * - `galaxy` is the backdrop's shape data: core, disk edge and dust filaments.
 */
export type HybridGraphLayout = {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  galaxy: GalaxyStructure;
};

export function buildHybridGraphLayout(
  contacts: GraphContactInput[],
  userName: string
): HybridGraphLayout {
  const steps = buildHybridGraphLayoutSteps(contacts, userName);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

/**
 * `buildHybridGraphLayout`, one phase at a time: it yields between phases so a caller can give
 * the main thread back in between (`src/lib/graph/sky-layout.ts`). At 10,000 contacts the whole
 * layout is ~100ms in one piece — a long task on its own — and no slice is more than ~15ms.
 * Drained without pausing, it is exactly the synchronous layout.
 */
export function* buildHybridGraphLayoutSteps(
  contacts: GraphContactInput[],
  userName: string
): Generator<void, HybridGraphLayout, void> {
  // `clusterBrandColor` normalises, looks up and mixes a colour on every call, and a layout asks
  // about each cluster once for itself and again for every line of its figure. Scoped to this
  // one layout, so it neither outlives it nor ships to pages that never lay out a sky.
  const brandMemo = new Map<string, string>();
  const brandOf = (name: string, kind?: string) => {
    const key = `${kind ?? ""}|${name}`;
    let color = brandMemo.get(key);
    if (color === undefined) {
      color = clusterBrandColor(name, kind);
      brandMemo.set(key, color);
    }
    return color;
  };

  const fit = buildConstellationFit(contacts);
  const { byContactId, fits } = fit;
  yield;

  const eligible = fit.clusters.filter((c) => fits.has(c.id));
  const satellites = familySatellites(contacts, eligible);
  const geoms = eligible.map((cluster) =>
    buildClusterGeometry(fits.get(cluster.id)!, satellites.get(cluster.id))
  );
  yield;

  const affinity = buildClusterAffinity(contacts, byContactId, eligible);
  yield;
  const { centers, diskRadius } = yield* placeClusterDisks(
    geoms.map((g) => ({ id: g.cluster.id, foot: g.foot, size: g.cluster.count })),
    affinity,
    { sunClear: SUN_CLEAR, gap: CLUSTER_GAP }
  );

  const positions = new Map<string, PolarPosition>();
  const figureIds = new Set<string>();
  const partOf = new Map<string, { key: string; role: PartRole }>();

  for (const geom of geoms) {
    const center = centers.get(geom.cluster.id)!;
    for (const g of geom.parts) {
      const role = { key: g.part.key, role: g.part.role };
      g.part.figureMemberIds.forEach((id, i) => {
        const p = g.figureLocal[i] || { x: 0, y: 0 };
        figureIds.add(id);
        partOf.set(id, role);
        positions.set(id, toPosition(center.x + p.x, center.y + p.y));
      });
      // A Set, not `includes`: a non-split cluster or a ring school is one part holding its whole
      // scatter list, so a list scan per star is quadratic in a slice that must stay short.
      // Family satellites are seated in the scatter field without belonging to the part, so they
      // must not be given its part info.
      const own = new Set(g.part.scatterMemberIds);
      for (const p of g.scatterLocal) {
        if (own.has(p.id)) partOf.set(p.id, role);
        positions.set(p.id, toPosition(center.x + p.x, center.y + p.y));
      }
    }
  }

  // Everyone no constellation claimed drifts in a halo beyond the galaxy's edge.
  const background = contacts
    .filter((c) => !positions.has(c.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (background.length > 0) {
    const inner = Math.max(diskRadius, SUN_CLEAR) + BACKGROUND_GAP;
    for (const p of haloField(background.map((c) => c.id), inner)) {
      positions.set(p.id, toPosition(p.x, p.y));
    }
  }

  const galaxy = buildGalaxyStructure(centers, affinity, {
    sunClear: SUN_CLEAR,
    diskRadius,
  });

  yield;
  const clusterNodes: LayoutNode[] = [];
  const clusterColorById = new Map<string, string>();
  for (const geom of geoms) {
    const cluster = geom.cluster;
    const color = brandOf(cluster.name, cluster.kind);
    clusterColorById.set(cluster.id, color);

    const memberPositions = cluster.contactIds
      .map((id) => positions.get(id))
      .filter((p): p is PolarPosition => Boolean(p));
    if (memberPositions.length === 0) continue;

    const cx =
      memberPositions.reduce((s, p) => s + p.x, 0) / memberPositions.length;
    const cy =
      memberPositions.reduce((s, p) => s + p.y, 0) / memberPositions.length;
    const starExtent = memberPositions.reduce(
      (m, p) => Math.max(m, Math.hypot(p.x - cx, p.y - cy)),
      80
    );
    const nebulaRadius = Math.max(90, starExtent + 70);

    clusterNodes.push({
      id: `nebula-${cluster.id}`,
      type: "nebula",
      data: {
        kind: "nebula",
        company: cluster.name,
        color,
        radius: nebulaRadius,
        clusterKind: cluster.kind,
        clusterId: cluster.id,
      },
      position: { x: cx, y: cy },
      draggable: false,
      selectable: true,
      zIndex: 0,
    });

    // The name sits centred just above the cluster's highest star, so it reads as the
    // constellation's title. It used to hang outside the footprint on the side facing away from
    // the sun, which could be the bottom of the figure or off the screen entirely once the
    // camera framed the cluster.
    let top = Infinity;
    let bottom = -Infinity;
    let left = Infinity;
    let right = -Infinity;
    for (const p of memberPositions) {
      top = Math.min(top, p.y);
      bottom = Math.max(bottom, p.y);
      left = Math.min(left, p.x);
      right = Math.max(right, p.x);
    }
    const boxLeft = left - CLUSTER_LABEL_PAD;
    const boxTop = top - CLUSTER_LABEL_GAP - CLUSTER_LABEL_HEAD;
    const boxWidth = right + CLUSTER_LABEL_PAD - boxLeft;
    const boxHeight = bottom + CLUSTER_LABEL_PAD - boxTop;
    const petalLabels =
      geom.fit.form === "petal"
        ? geom.parts
            .filter((g) => g.part.label && g.part.role !== "main")
            .map((g) => {
              const pts = [...g.part.figureMemberIds, ...g.part.scatterMemberIds]
                .map((id) => positions.get(id))
                .filter((p): p is PolarPosition => Boolean(p));
              const pLeft = Math.min(...pts.map((p) => p.x));
              const pRight = Math.max(...pts.map((p) => p.x));
              const pTop = Math.min(...pts.map((p) => p.y));
              return {
                key: g.part.key,
                label: g.part.label!,
                role: g.part.role as "core" | "petal",
                count: g.part.figureMemberIds.length + g.part.scatterMemberIds.length,
                anchor: {
                  x: (pLeft + pRight) / 2 - boxLeft,
                  y: pTop - CLUSTER_LABEL_GAP - boxTop,
                },
              };
            })
        : undefined;
    clusterNodes.push({
      id: `cluster-${cluster.id}`,
      type: "clusterLabel",
      data: {
        kind: "clusterLabel",
        label: cluster.name,
        count: cluster.count,
        nebulaColor: color,
        clusterKind: cluster.kind,
        clusterId: cluster.id,
        box: { width: boxWidth, height: boxHeight },
        anchor: { x: (left + right) / 2 - boxLeft, y: CLUSTER_LABEL_HEAD },
        form: geom.fit.form,
        petalLabels,
      },
      // The name's anchor. The chart sets the node's origin so its box lands around it.
      position: { x: (left + right) / 2, y: top - CLUSTER_LABEL_GAP },
      draggable: false,
      selectable: true,
      zIndex: 7,
    });
  }

  const nodes: LayoutNode[] = [
    {
      id: "me",
      type: "user",
      data: {
        kind: "user",
        label: userName || "You",
        initials: initialsFromName(userName || "You"),
      },
      position: { x: 0, y: 0 },
      draggable: false,
      zIndex: 10,
    },
    ...clusterNodes,
    ...contacts.map((c) => {
      const pos = positions.get(c.id) || toPosition(0, 320);
      const score = placementScore(c);
      // The payload's own decision when it made one (graph-data.ts caps comets per cluster);
      // the raw day threshold only for callers that never set it.
      const dormant = c.dormant ?? isCometContact(c.lastInteractionAt);
      const name = displayName(c);
      const cluster = byContactId.get(c.id);
      return {
        id: c.id,
        type: "contact" as const,
        data: {
          kind: "contact" as const,
          label: name,
          fullName: c.fullName,
          preferredName: c.preferredName,
          initials: initialsFromName(name),
          company: c.company,
          school: c.school ?? null,
          title: c.title,
          score,
          relationshipScore: clampScore(c.relationshipScore),
          closeness: c.closeness,
          closenessTier: c.closenessTier,
          comet: dormant,
          overdue: isOverdue(c.nextFollowUpAt),
          tags: c.tags,
          aiSummary: c.aiSummary,
          keyFacts: c.keyFacts || [],
          lastInteractionAt: toIso(c.lastInteractionAt),
          hasLoggedInteraction: c.hasLoggedInteraction === true,
          nextFollowUpAt: toIso(c.nextFollowUpAt),
          metContext: c.metContext ?? null,
          dateMet: toIso(c.dateMet ?? null),
          howMet: c.howMet ?? null,
          email: c.email ?? null,
          phone: c.phone ?? null,
          linkedinUrl: c.linkedinUrl ?? null,
          website: c.website ?? null,
          profileImageUrl: c.profileImageUrl ?? null,
          clusterId: cluster?.id,
          clusterName: cluster?.name,
          clusterKind: cluster?.kind,
          figureRole: figureIds.has(c.id)
            ? ("figure" as const)
            : ("scatter" as const),
          clusterColor: cluster ? clusterColorById.get(cluster.id) : undefined,
          partKey: partOf.get(c.id)?.key,
          partRole: partOf.get(c.id)?.role,
          leader:
            partOf.get(c.id) && partOf.get(c.id)!.role !== "main"
              ? classifyTitle(c.title).isLeader
              : undefined,
          orbitAngle: pos.angle,
          orbitRadius: pos.radius,
        },
        position: { x: pos.x, y: pos.y },
        zIndex: dormant ? 6 : 5,
      };
    }),
  ];

  // Constellation path edges only — brand-tinted lines along each figure,
  // synthesized from the same fit that placed the stars.
  yield;
  const edges: LayoutEdge[] = [];
  for (const fitEdge of constellationFitEdges(fit)) {
    const reason =
      fitEdge.clusterKind === "school"
        ? "school"
        : fitEdge.clusterKind === "role"
          ? "role"
          : "company";
    const peer: PeerEdge = {
      source: fitEdge.source,
      target: fitEdge.target,
      kind: "constellation",
      reason,
      company: fitEdge.clusterName,
    };
    const layoutEdge = peerEdgeToLayoutEdge(peer);
    const brand = brandOf(fitEdge.clusterName, reason);
    edges.push({
      ...layoutEdge,
      type: "labeled",
      label: undefined,
      style: {
        ...layoutEdge.style,
        stroke: withAlpha(mixWithWhite(brand, 0.55), 0.8),
      },
      data: layoutEdge.data
        ? {
            kind: layoutEdge.data.kind,
            company: layoutEdge.data.company,
            reason: layoutEdge.data.reason,
            brandColor: brand,
          }
        : undefined,
    });
  }

  return { nodes, edges, galaxy };
}
