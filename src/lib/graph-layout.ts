import { daysAgo } from "@/lib/duplicates";

/** Score 5 nearest → 1 farthest. Wider spacing for star-chart readability. */
export const RING_RADII = [160, 260, 360, 470, 580] as const;

/** Score 5 = Intimate (nearest) … Score 1 = Distant (farthest) */
export const RING_LABELS: Record<number, string> = {
  5: "Intimate",
  4: "Close",
  3: "Familiar",
  2: "Acquaintance",
  1: "Distant",
};

export type GraphContactInput = {
  id: string;
  fullName: string;
  preferredName?: string | null;
  company: string | null;
  title: string | null;
  relationshipScore: number;
  /** Derived closeness 0–1 when available */
  closeness?: number;
  closenessTier?: "inner" | "mid" | "outer";
  /** Ring placement score (closeness-derived when present) */
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
  notes?: string | null;
  sharedInterests?: string[] | null;
};

export type GraphNodeData = {
  kind: "user" | "contact";
  label: string;
  fullName?: string;
  preferredName?: string | null;
  initials: string;
  company?: string | null;
  title?: string | null;
  score?: number;
  relationshipScore?: number;
  closeness?: number;
  closenessTier?: "inner" | "mid" | "outer";
  dormant?: boolean;
  overdue?: boolean;
  tags?: string[];
  aiSummary?: string | null;
  keyFacts?: string[];
  lastInteractionAt?: string | null;
  nextFollowUpAt?: string | null;
  metContext?: string | null;
  dateMet?: string | null;
  howMet?: string | null;
  email?: string | null;
  phone?: string | null;
  linkedinUrl?: string | null;
  orbitAngle?: number;
  orbitRadius?: number;
  spotlight?: boolean;
  labelMode?: "always" | "hover" | "never";
  motionEnabled?: boolean;
  motionPaused?: boolean;
};

export type OrbitRingsData = {
  kind: "rings";
  radii: number[];
  showLabels?: boolean;
  motionEnabled?: boolean;
};

export type ClusterLabelData = {
  kind: "clusterLabel";
  label: string;
};

export type LayoutNode = {
  id: string;
  type: "user" | "contact" | "orbitRings" | "clusterLabel";
  data: GraphNodeData | OrbitRingsData | ClusterLabelData;
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
  type: "straight";
  animated?: boolean;
  data?: {
    kind: EdgeKind;
    company?: string;
    reason?: "company" | "howMet" | "mention" | "sharedTags" | "sharedInterests";
  };
  style?: Record<string, string | number>;
};

export type GroupingMode = "score" | "company";

function clampScore(score: number | null | undefined) {
  return Math.min(5, Math.max(1, score || 2));
}

function placementScore(c: GraphContactInput) {
  return clampScore(c.orbitScore ?? c.relationshipScore);
}

/** Score 5 nearest → radius index 0; score 1 farthest. */
export function ringRadiusForScore(score: number) {
  const s = clampScore(score);
  return RING_RADII[5 - s];
}

export function displayName(c: {
  fullName: string;
  preferredName?: string | null;
}) {
  const preferred = (c.preferredName || "").trim();
  return preferred || c.fullName;
}

export function initialsFromName(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function companyKey(company: string | null | undefined) {
  const trimmed = (company || "").trim();
  return trimmed || "__none__";
}

function normalizePhrase(value: string | null | undefined) {
  return (value || "").trim().toLowerCase().replace(/\s+/g, " ");
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

function pairKey(a: string, b: string) {
  return a < b ? `${a}::${b}` : `${b}::${a}`;
}

function contactCorpus(c: GraphContactInput) {
  return [
    c.aiSummary || "",
    ...(c.keyFacts || []),
    c.notes || "",
    ...(c.sharedInterests || []),
  ]
    .join(" ")
    .toLowerCase();
}

function nameAliases(c: GraphContactInput) {
  const names = new Set<string>();
  const full = c.fullName.trim();
  const preferred = (c.preferredName || "").trim();
  if (full.length >= 3) names.add(full.toLowerCase());
  if (preferred.length >= 3) names.add(preferred.toLowerCase());
  const parts = full.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    const last = parts[parts.length - 1];
    if (last.length >= 4) names.add(last.toLowerCase());
  }
  return [...names];
}

function mentionsOther(a: GraphContactInput, b: GraphContactInput) {
  const text = contactCorpus(a);
  if (!text) return false;
  return nameAliases(b).some((alias) => {
    if (alias.length < 3) return false;
    return text.includes(alias);
  });
}

function sharedCount(a: string[], b: string[]) {
  const setB = new Set(b.map((t) => t.toLowerCase()));
  let n = 0;
  for (const t of a) {
    if (setB.has(t.toLowerCase())) n += 1;
  }
  return n;
}

function addStraightEdge(
  edges: LayoutEdge[],
  seen: Set<string>,
  source: string,
  target: string,
  data: NonNullable<LayoutEdge["data"]>,
  style: Record<string, string | number>
) {
  if (source === target) return;
  const key = pairKey(source, target);
  if (seen.has(key)) return;
  seen.add(key);
  edges.push({
    id: `${data.kind}-${key}`,
    source,
    target,
    type: "straight",
    animated: false,
    data,
    style,
  });
}

/**
 * Hybrid constellation layout:
 * - Global angular sectors by company (aligned across rings)
 * - Radius from relationship score
 * - Straight solar rays + polygon company constellations + derived knows links
 */
export function buildHybridGraphLayout(
  contacts: GraphContactInput[],
  userName: string,
  options?: { grouping?: GroupingMode }
): { nodes: LayoutNode[]; edges: LayoutEdge[] } {
  const grouping = options?.grouping ?? "score";

  const companyCounts = new Map<string, number>();
  for (const c of contacts) {
    const key = companyKey(c.company);
    companyCounts.set(key, (companyCounts.get(key) || 0) + 1);
  }

  const companies = [...companyCounts.keys()].sort((a, b) => {
    if (a === "__none__") return 1;
    if (b === "__none__") return -1;
    const byCount = (companyCounts.get(b) || 0) - (companyCounts.get(a) || 0);
    if (byCount !== 0) return byCount;
    return a.localeCompare(b);
  });

  const total = Math.max(contacts.length, 1);
  const gap = grouping === "company" ? 0.08 : 0.055;
  const usable = Math.PI * 2 - gap * companies.length;
  const sectors = new Map<string, { start: number; end: number; mid: number }>();
  let cursor = -Math.PI / 2;

  for (const key of companies) {
    const share = (companyCounts.get(key) || 1) / total;
    const span = Math.max(
      usable * share,
      grouping === "company" ? 0.14 : 0.1
    );
    const start = cursor;
    const end = cursor + span;
    sectors.set(key, { start, end, mid: (start + end) / 2 });
    cursor = end + gap;
  }

  const ringBuckets = new Map<string, GraphContactInput[]>();
  for (const c of contacts) {
    const key = `${companyKey(c.company)}::${placementScore(c)}`;
    const list = ringBuckets.get(key) || [];
    list.push(c);
    ringBuckets.set(key, list);
  }

  const positions = new Map<
    string,
    { x: number; y: number; angle: number; radius: number }
  >();

  for (const [bucketKey, group] of ringBuckets) {
    const [coKey, scoreStr] = bucketKey.split("::");
    const sector = sectors.get(coKey)!;
    const score = Number(scoreStr);
    let radius = ringRadiusForScore(score);

    if (grouping === "company" && coKey !== "__none__") {
      const midBand = (RING_RADII[1] + RING_RADII[2]) / 2;
      radius = radius * 0.35 + midBand * 0.65;
    }

    const sorted = [...group].sort((a, b) =>
      displayName(a).localeCompare(displayName(b))
    );
    const n = sorted.length;
    const pad = grouping === "company" ? 0.1 : 0.16;
    const innerStart = sector.start + (sector.end - sector.start) * pad;
    const innerEnd = sector.end - (sector.end - sector.start) * pad;
    const span = Math.max(innerEnd - innerStart, 0.02);

    sorted.forEach((c, i) => {
      const t = n === 1 ? 0.5 : i / (n - 1);
      const jitter = ((c.id.charCodeAt(0) % 7) - 3) * 0.006;
      const angle = innerStart + span * t + jitter;
      const rJitter = ((c.id.charCodeAt(1) || 0) % 5) - 2;
      const r = radius + rJitter;
      positions.set(c.id, {
        x: Math.cos(angle) * r,
        y: Math.sin(angle) * r,
        angle,
        radius: r,
      });
    });
  }

  const clusterLabelNodes: LayoutNode[] = companies
    .filter((key) => key !== "__none__" && (companyCounts.get(key) || 0) >= 2)
    .map((key) => {
      const sector = sectors.get(key)!;
      const labelR = (RING_RADII[1] + RING_RADII[2]) / 2;
      return {
        id: `cluster-${key}`,
        type: "clusterLabel" as const,
        data: { kind: "clusterLabel" as const, label: key },
        position: {
          x: Math.cos(sector.mid) * labelR,
          y: Math.sin(sector.mid) * labelR,
        },
        draggable: false,
        selectable: false,
        zIndex: 1,
      };
    });

  const nodes: LayoutNode[] = [
    {
      id: "rings",
      type: "orbitRings",
      data: {
        kind: "rings",
        radii: [...RING_RADII],
        showLabels: true,
        motionEnabled: false,
      },
      position: { x: 0, y: 0 },
      draggable: false,
      selectable: false,
      zIndex: -1,
    },
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
    ...clusterLabelNodes,
    ...contacts.map((c) => {
      const pos = positions.get(c.id) || {
        x: 0,
        y: 0,
        angle: 0,
        radius: RING_RADII[2],
      };
      const score = placementScore(c);
      const dormant = daysAgo(c.lastInteractionAt) > 45;
      const name = displayName(c);
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
          title: c.title,
          score,
          relationshipScore: clampScore(c.relationshipScore),
          closeness: c.closeness,
          closenessTier: c.closenessTier,
          dormant,
          overdue: isOverdue(c.nextFollowUpAt),
          tags: c.tags,
          aiSummary: c.aiSummary,
          keyFacts: c.keyFacts || [],
          lastInteractionAt: toIso(c.lastInteractionAt),
          nextFollowUpAt: toIso(c.nextFollowUpAt),
          metContext: c.metContext ?? null,
          dateMet: toIso(c.dateMet ?? null),
          howMet: c.howMet ?? null,
          email: c.email ?? null,
          phone: c.phone ?? null,
          linkedinUrl: c.linkedinUrl ?? null,
          orbitAngle: pos.angle,
          orbitRadius: pos.radius,
        },
        position: { x: pos.x, y: pos.y },
        zIndex: 5,
      };
    }),
  ];

  const seenPairs = new Set<string>();
  const edges: LayoutEdge[] = [];

  // Solar rays — faint straight spokes (background hierarchy)
  for (const c of contacts) {
    const score = placementScore(c);
    const dormant = daysAgo(c.lastInteractionAt) > 45;
    edges.push({
      id: `solar-${c.id}`,
      source: "me",
      target: c.id,
      type: "straight",
      animated: false,
      data: { kind: "solar" },
      style: {
        stroke: "rgba(255, 255, 255, 0.55)",
        strokeWidth: Math.max(0.5, 0.45 + score * 0.1),
        opacity: dormant ? 0.08 : 0.12 + score * 0.025,
      },
    });
  }

  // Company constellations — angular chain + close small polygons
  const byCompany = new Map<string, GraphContactInput[]>();
  for (const c of contacts) {
    const key = companyKey(c.company);
    if (key === "__none__") continue;
    const list = byCompany.get(key) || [];
    list.push(c);
    byCompany.set(key, list);
  }

  for (const [key, group] of byCompany) {
    if (group.length < 2) continue;
    const ordered = [...group].sort((a, b) => {
      const aa = positions.get(a.id)?.angle ?? 0;
      const bb = positions.get(b.id)?.angle ?? 0;
      return aa - bb;
    });

    for (let i = 0; i < ordered.length - 1; i++) {
      addStraightEdge(
        edges,
        seenPairs,
        ordered[i].id,
        ordered[i + 1].id,
        { kind: "constellation", company: key, reason: "company" },
        {
          stroke: "rgba(255, 255, 255, 0.85)",
          strokeWidth: 1.05,
          opacity: 0.7,
        }
      );
    }

    if (ordered.length >= 3 && ordered.length <= 8) {
      addStraightEdge(
        edges,
        seenPairs,
        ordered[ordered.length - 1].id,
        ordered[0].id,
        { kind: "constellation", company: key, reason: "company" },
        {
          stroke: "rgba(255, 255, 255, 0.75)",
          strokeWidth: 1,
          opacity: 0.55,
        }
      );
    }
  }

  // Same howMet / event
  const byHowMet = new Map<string, GraphContactInput[]>();
  for (const c of contacts) {
    const key = normalizePhrase(c.howMet);
    if (!key || key.length < 3) continue;
    const list = byHowMet.get(key) || [];
    list.push(c);
    byHowMet.set(key, list);
  }
  for (const group of byHowMet.values()) {
    if (group.length < 2) continue;
    const ordered = [...group].sort((a, b) =>
      displayName(a).localeCompare(displayName(b))
    );
    for (let i = 0; i < ordered.length - 1; i++) {
      addStraightEdge(
        edges,
        seenPairs,
        ordered[i].id,
        ordered[i + 1].id,
        { kind: "knows", reason: "howMet" },
        {
          stroke: "rgba(255, 236, 200, 0.9)",
          strokeWidth: 0.95,
          opacity: 0.65,
        }
      );
    }
  }

  // Mentions + shared tags/interests
  for (let i = 0; i < contacts.length; i++) {
    for (let j = i + 1; j < contacts.length; j++) {
      const a = contacts[i];
      const b = contacts[j];
      if (mentionsOther(a, b) || mentionsOther(b, a)) {
        addStraightEdge(
          edges,
          seenPairs,
          a.id,
          b.id,
          { kind: "knows", reason: "mention" },
          {
            stroke: "rgba(255, 255, 255, 0.8)",
            strokeWidth: 0.9,
            opacity: 0.6,
          }
        );
        continue;
      }

      const tagOverlap = sharedCount(a.tags || [], b.tags || []);
      if (tagOverlap >= 2) {
        addStraightEdge(
          edges,
          seenPairs,
          a.id,
          b.id,
          { kind: "knows", reason: "sharedTags" },
          {
            stroke: "rgba(220, 230, 255, 0.75)",
            strokeWidth: 0.85,
            opacity: 0.4,
          }
        );
        continue;
      }

      const interestOverlap = sharedCount(
        a.sharedInterests || [],
        b.sharedInterests || []
      );
      if (interestOverlap >= 2) {
        addStraightEdge(
          edges,
          seenPairs,
          a.id,
          b.id,
          { kind: "knows", reason: "sharedInterests" },
          {
            stroke: "rgba(220, 230, 255, 0.7)",
            strokeWidth: 0.8,
            opacity: 0.35,
          }
        );
      }
    }
  }

  return { nodes, edges };
}
