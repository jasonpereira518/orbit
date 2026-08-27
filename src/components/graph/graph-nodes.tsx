"use client";

import { memo, useMemo } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  Handle,
  Position,
  getStraightPath,
  useInternalNode,
  useStore,
  type EdgeProps,
  type NodeProps,
} from "@xyflow/react";
import { cn } from "@/lib/utils";
import {
  RING_LABELS,
  type ClusterLabelData,
  type GraphNodeData,
  type NebulaData,
  type OrbitRingsData,
} from "@/lib/graph-layout";
import { mixWithWhite, withAlpha } from "@/lib/school-color";

/** Invisible handles pinned to the star center so edges meet the nodes. */
function StarHandles() {
  return (
    <>
      <Handle
        type="target"
        position={Position.Top}
        isConnectable={false}
        className="!pointer-events-none !left-1/2 !top-1/2 !h-px !w-px !min-h-0 !min-w-0 !-translate-x-1/2 !-translate-y-1/2 !border-0 !bg-transparent !opacity-0"
      />
      <Handle
        type="source"
        position={Position.Bottom}
        isConnectable={false}
        className="!pointer-events-none !left-1/2 !top-1/2 !h-px !w-px !min-h-0 !min-w-0 !-translate-x-1/2 !-translate-y-1/2 !border-0 !bg-transparent !opacity-0"
      />
    </>
  );
}

function OrbitRingsNodeComponent({
  data,
}: NodeProps & { data: OrbitRingsData }) {
  const max = Math.max(...data.radii, 1);
  const labels = [5, 4, 3, 2, 1] as const;

  // Rings are pure background texture — faint dashes that give the sky some
  // depth. The inner rotation (--galaxy-rot, driven by the ambient-motion
  // loop) sweeps the dashes along the disk as one body; labels stay put.
  return (
    <div className="pointer-events-none" style={{ width: 1, height: 1 }}>
      <div
        className="absolute"
        style={{
          left: -max,
          top: -max,
          width: max * 2,
          height: max * 2,
        }}
      >
        <div
          className="absolute inset-0"
          style={{ transform: "rotate(var(--galaxy-rot, 0rad))" }}
        >
          <svg
            width={max * 2}
            height={max * 2}
            className="overflow-visible"
            aria-hidden
          >
            {data.radii.map((r, i) => (
              <circle
                key={r}
                cx={max}
                cy={max}
                r={r}
                fill="none"
                stroke="rgba(255,255,255,0.08)"
                strokeWidth={1}
                strokeDasharray={i % 2 === 0 ? "2 16" : "1 12"}
                opacity={0.7}
              />
            ))}
          </svg>
        </div>
      </div>
      {data.showLabels &&
        data.radii.map((r, i) => {
          const score = labels[i];
          return (
            <span
              key={`label-${r}`}
              className="absolute whitespace-nowrap text-[9px] uppercase tracking-[0.16em] text-white/30"
              style={{
                left: 6,
                top: -r - 6,
                transform: "translateY(-50%)",
              }}
            >
              {RING_LABELS[score]}
            </span>
          );
        })}
    </div>
  );
}

function SunNodeComponent({
  data,
  selected,
}: NodeProps & { data: GraphNodeData }) {
  return (
    <div className="relative flex items-center justify-center">
      <Handle
        type="source"
        position={Position.Top}
        className="!opacity-0"
        isConnectable={false}
      />
      <div
        className={cn(
          "constellation-corona-outer absolute rounded-full",
          selected ? "h-52 w-52" : "h-44 w-44"
        )}
        style={{
          background:
            "radial-gradient(circle, rgba(255,248,220,0.42) 0%, rgba(255,200,100,0.18) 35%, rgba(255,160,60,0.06) 55%, transparent 72%)",
        }}
      />
      <div
        className={cn(
          "constellation-corona absolute rounded-full bg-white/50 blur-[3px]",
          selected ? "h-20 w-20" : "h-16 w-16"
        )}
      />
      <div
        className={cn(
          "constellation-sun-core relative z-10 rounded-full",
          "bg-[radial-gradient(circle_at_35%_30%,_#ffffff_0%,_#fff6d6_28%,_#f5c86a_65%,_#e09030_100%)]",
          "shadow-[0_0_32px_10px_rgba(255,240,200,0.65),0_0_72px_22px_rgba(255,170,60,0.35),0_0_100px_40px_rgba(255,140,40,0.15)]",
          selected && "ring-2 ring-white/80"
        )}
        style={{ width: 22, height: 22 }}
        title={data.label}
      />
      <p className="absolute top-8 whitespace-nowrap text-[11px] font-medium tracking-wide text-white/95 drop-shadow-[0_0_8px_rgba(0,0,0,0.8)]">
        {data.label}
      </p>
    </div>
  );
}

function starSize(score: number) {
  return 5 + score * 2.2;
}

/**
 * The line under a person's name: their role, or their company when we don't
 * know what they do. Never both — one quiet line keeps the sky readable.
 */
function starSubtitle(data: GraphNodeData) {
  return (data.title || "").trim() || (data.company || "").trim() || null;
}

function ContactNodeComponent({
  data,
  selected,
}: NodeProps & { data: GraphNodeData }) {
  const score = data.score || 2;
  const size = starSize(score);
  const glow = Math.max(3, score * 2.2);
  const bright = selected || Boolean(data.spotlight);
  const isComet = Boolean(data.comet);
  const isScatter = data.figureRole === "scatter";
  // Scatter stars stay faint until hovered/selected/spotlit, then pop to full.
  const dimmedScatter = isScatter && !selected && !data.spotlight;
  const subtitle = starSubtitle(data);

  if (isComet) {
    const angleDeg = ((data.orbitAngle ?? 0) * 180) / Math.PI;
    const disc = size + 2;
    return (
      <div
        className={cn(
          "constellation-planet-enter group relative",
          data.motionPaused && "z-20"
        )}
        style={{ width: disc, height: disc }}
      >
        <StarHandles />
        <div
          className={cn(
            "constellation-comet relative",
            selected && "scale-110",
            data.spotlight && "constellation-spotlight-ring"
          )}
          style={{
            width: disc,
            height: disc,
            transform: `rotate(${angleDeg + 180}deg)`,
          }}
          title={`${data.label}${data.company ? ` · ${data.company}` : ""} · drifting`}
        >
          <span className="constellation-comet-trail" />
          <span
            className="constellation-comet-head"
            style={{
              width: disc,
              height: disc,
            }}
          />
        </div>
        <div
          className={cn(
            "pointer-events-none absolute left-1/2 top-full z-10 mt-2 w-max max-w-[104px] -translate-x-1/2 text-center transition-opacity duration-200 group-hover:z-30",
            bright ? "opacity-100" : "opacity-75 group-hover:opacity-100"
          )}
        >
          <p className="truncate text-[11px] font-medium leading-tight text-[#ffb4a0]">
            {data.label}
          </p>
          {subtitle && (
            <p className="truncate text-[9px] leading-tight text-[#ff8a70]/70">
              {subtitle}
            </p>
          )}
        </div>
      </div>
    );
  }

  // Figure stars carry a pastel wash of their cluster's brand color; scatter
  // stars stay white and quiet until emphasized. Glow is deliberately soft —
  // the sky should read as a chart, not a light show.
  const tint = !isScatter ? data.clusterColor : undefined;
  const fill = tint ? mixWithWhite(tint, 0.35) : "#ffffff";
  const core = tint ? mixWithWhite(tint, 0.85) : "#ffffff";
  const spotlightBoost = data.spotlight ? 1.9 : 1;
  const alphaScale = dimmedScatter ? 0.55 : 1;
  const baseDisc = dimmedScatter ? Math.max(4, size * 0.6) : size;
  const disc = baseDisc * (data.spotlight ? 1.3 : 1);

  return (
    <div
      className={cn(
        "constellation-planet-enter group relative",
        data.motionPaused && "z-20",
        data.spotlight && "z-30"
      )}
      style={{ width: disc, height: disc }}
    >
      <StarHandles />
      {/* Bob wrapper: the sole search hit hovers gently up and down. */}
      <div
        className={cn(
          "relative h-full w-full",
          data.spotlightSolo && "constellation-bob"
        )}
      >
        <div
          className={cn(
            "relative h-full w-full rounded-full transition-transform duration-200",
            selected && "scale-125",
            data.spotlight && "constellation-spotlight-ring",
            data.overdue && "ring-1 ring-[#c4a35a]/80"
          )}
          style={{
            background: `radial-gradient(circle at 35% 30%, #fff 0%, ${core} 50%, transparent 78%)`,
            boxShadow: `0 0 ${glow * spotlightBoost}px ${
              (glow / 2) * spotlightBoost
            }px ${withAlpha(fill, 0.32 * spotlightBoost * alphaScale)}, 0 0 ${
              glow * 2 * spotlightBoost
            }px ${glow * spotlightBoost}px ${withAlpha(fill, 0.1 * alphaScale)}`,
          }}
          title={`${data.label}${data.company ? ` · ${data.company}` : ""}${
            data.school ? ` · ${data.school}` : ""
          }`}
        />
        <div
          className={cn(
            "pointer-events-none absolute left-1/2 top-full z-10 mt-2 w-max max-w-[104px] -translate-x-1/2 text-center transition-opacity duration-200 group-hover:z-30",
            bright
              ? "opacity-100"
              : dimmedScatter
                ? "opacity-65 group-hover:opacity-100"
                : "opacity-85 group-hover:opacity-100"
          )}
        >
          <p
            className={cn(
              "truncate text-[11px] font-medium leading-tight text-white/95",
              data.spotlight && "font-semibold text-white"
            )}
          >
            {data.label}
          </p>
          {subtitle && (
            <p
              className={cn(
                "truncate text-[9px] leading-tight text-white/45",
                data.spotlight && "text-white/70"
              )}
            >
              {subtitle}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/** Stable 0..1 from a string, so each cluster's wash keeps its shape. */
function nebulaHash(seed: string, salt: number) {
  let h = (2166136261 ^ salt) >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h ^ seed.charCodeAt(i)) >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h % 10000) / 10000;
}

/** Ejecta spokes of uneven width and brightness. */
function nebulaFilaments(
  seed: string,
  color: string,
  count: number,
  salt: number,
  maxAlpha: number,
  minWidth: number,
  maxWidth: number
) {
  const stops: string[] = [];
  for (let i = 0; i < count; i++) {
    const center =
      (i / count) * 360 + nebulaHash(seed, i * 7 + salt) * (360 / count);
    const width =
      minWidth + nebulaHash(seed, i * 7 + salt + 1) * (maxWidth - minWidth);
    const alpha = maxAlpha * (0.4 + nebulaHash(seed, i * 7 + salt + 2) * 0.6);
    stops.push(
      `transparent ${(center - width).toFixed(1)}deg`,
      `${withAlpha(color, alpha)} ${center.toFixed(1)}deg`,
      `transparent ${(center + width).toFixed(1)}deg`
    );
  }
  return `conic-gradient(from 0deg, ${stops.join(", ")})`;
}

/** Fades spokes out well inside the box so no rim is ever drawn. */
const INNER_FILAMENT_MASK =
  "radial-gradient(closest-side, rgba(0,0,0,0.25) 0%, rgba(0,0,0,0.9) 15%, rgba(0,0,0,0.5) 38%, rgba(0,0,0,0.15) 58%, transparent 74%)";
const OUTER_FILAMENT_MASK =
  "radial-gradient(closest-side, transparent 20%, rgba(0,0,0,0.55) 42%, rgba(0,0,0,0.3) 62%, rgba(0,0,0,0.1) 80%, transparent 96%)";

function NebulaNodeComponent({ data }: NodeProps & { data: NebulaData }) {
  const r = data.radius;
  const color = data.color;

  const { size, lobes, inner, outer, innerAngle, outerAngle } = useMemo(() => {
    const seed = data.company;
    // Box runs well past the stars so the wash dissolves before any boundary
    const size = r * 4;
    const pct = (v: number) => 50 + (v / size) * 100;

    // Offset, unequal lobes — overlapping ellipses read as blown-out debris
    const lobes = Array.from({ length: 5 }, (_, i) => {
      const angle = nebulaHash(seed, i * 9 + 1) * Math.PI * 2;
      const dist = (0.06 + nebulaHash(seed, i * 9 + 2) * 0.45) * r;
      const rx = (0.5 + nebulaHash(seed, i * 9 + 3) * 0.65) * r;
      const ry = rx * (0.5 + nebulaHash(seed, i * 9 + 4) * 0.6);
      const alpha = 0.075 - i * 0.011;
      return `radial-gradient(ellipse ${rx.toFixed(0)}px ${ry.toFixed(0)}px at ${pct(
        Math.cos(angle) * dist
      ).toFixed(1)}% ${pct(Math.sin(angle) * dist).toFixed(1)}%, ${withAlpha(
        color,
        alpha
      )} 0%, ${withAlpha(color, alpha * 0.45)} 36%, transparent 72%)`;
    }).join(", ");

    return {
      size,
      lobes,
      // Two layers with different reach so arms vary in length
      inner: nebulaFilaments(seed, color, 11, 3, 0.1, 4, 15),
      outer: nebulaFilaments(seed, color, 5, 41, 0.06, 2, 8),
      innerAngle: nebulaHash(seed, 77) * 360,
      outerAngle: nebulaHash(seed, 91) * 360,
    };
  }, [data.company, color, r]);

  return (
    <div
      className="nodrag cursor-pointer"
      style={{ width: size, height: size }}
      title={`Zoom to ${data.company}`}
      aria-label={`Zoom to ${data.company} cluster`}
    >
      <div
        className="constellation-nebula absolute inset-0"
        style={{ width: size, height: size }}
      >
        <div
          className="absolute inset-0"
          style={{
            background: lobes,
            filter: `blur(${(r * 0.3).toFixed(0)}px)`,
          }}
        />
        <div
          className="absolute inset-0"
          style={{
            background: inner,
            transform: `rotate(${innerAngle.toFixed(1)}deg)`,
            maskImage: INNER_FILAMENT_MASK,
            WebkitMaskImage: INNER_FILAMENT_MASK,
            filter: `blur(${(r * 0.05).toFixed(0)}px)`,
          }}
        />
        <div
          className="absolute inset-0"
          style={{
            background: outer,
            transform: `rotate(${outerAngle.toFixed(1)}deg)`,
            maskImage: OUTER_FILAMENT_MASK,
            WebkitMaskImage: OUTER_FILAMENT_MASK,
            filter: `blur(${(r * 0.07).toFixed(0)}px)`,
          }}
        />
      </div>
    </div>
  );
}

function ClusterLabelNodeComponent({
  data,
}: NodeProps & { data: ClusterLabelData }) {
  // Round zoom so labels don't re-render on every pan/zoom frame
  const zoom = useStore((s) => Math.round(s.transform[2] * 40) / 40);
  // Partially counteract viewport zoom so names stay readable when zoomed out,
  // while still shrinking a little as you zoom in on a constellation.
  const inv = 1 / Math.max(zoom, 0.08);
  const scale = Math.min(2.8, Math.max(0.7, Math.pow(inv, 0.85)));
  const brand = data.nebulaColor;

  return (
    <div
      className="nopan nodrag cursor-pointer px-2 py-1"
      title={`Zoom to ${data.label}`}
      aria-label={`Zoom to ${data.label} cluster`}
      style={{
        transform: `scale(${scale})`,
        transformOrigin: "center center",
      }}
    >
      <span className="relative inline-block whitespace-nowrap text-center text-[11px] font-semibold tracking-[0.08em]">
        {brand ? (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 translate-x-[0.75px] translate-y-[0.75px] select-none"
            style={{ color: brand }}
          >
            {data.label}
          </span>
        ) : null}
        <span className="relative text-white">{data.label}</span>
      </span>
    </div>
  );
}

function nodeCenter(node: ReturnType<typeof useInternalNode>) {
  if (!node) return null;
  const w = node.measured.width ?? 0;
  const h = node.measured.height ?? 0;
  return {
    x: node.internals.positionAbsolute.x + w / 2,
    y: node.internals.positionAbsolute.y + h / 2,
  };
}

function LabeledEdgeComponent({
  id,
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  style,
  data,
  markerEnd,
}: EdgeProps) {
  // Draw through star centers (nodeOrigin [0.5,0.5] stores center as
  // position; positionAbsolute is the measured top-left).
  const sourceCenter = nodeCenter(useInternalNode(source));
  const targetCenter = nodeCenter(useInternalNode(target));
  const sx = sourceCenter?.x ?? sourceX;
  const sy = sourceCenter?.y ?? sourceY;
  const tx = targetCenter?.x ?? targetX;
  const ty = targetCenter?.y ?? targetY;

  const [edgePath, labelX, labelY] = getStraightPath({
    sourceX: sx,
    sourceY: sy,
    targetX: tx,
    targetY: ty,
  });
  const edgeData = data as
    | {
        label?: string;
        kind?: string;
        reason?: string;
      }
    | undefined;
  const label = edgeData?.label || "";
  const kind = edgeData?.kind;
  const showLabel =
    Boolean(label) && (kind === "constellation" || kind === "knows");

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          ...style,
          stroke:
            (typeof style?.stroke === "string" && style.stroke) ||
            "rgba(255, 255, 255, 0.75)",
          strokeLinecap: "round",
        }}
      />
      {showLabel && (
        <EdgeLabelRenderer>
          <div
            className="constellation-edge-label nodrag nopan pointer-events-none"
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const OrbitRingsNode = memo(OrbitRingsNodeComponent);
export const SunNode = memo(SunNodeComponent);
export const ContactNode = memo(ContactNodeComponent);
export const ClusterLabelNode = memo(ClusterLabelNodeComponent);
export const NebulaNode = memo(NebulaNodeComponent);
export const LabeledEdge = memo(LabeledEdgeComponent);
