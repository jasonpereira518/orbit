"use client";

import { memo, useEffect, useMemo, useRef } from "react";
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
import { withAlpha } from "@/lib/school-color";
import {
  STAR_HIT_PAD,
  starVisual,
  zoomRelief as starZoomRelief,
} from "@/lib/graph/star-style";

/**
 * Below this zoom a star's label is not mounted, unless it is pinned (hovered, selected or
 * a search hit).
 *
 * Labels are drawn in world units, so they shrink with the camera: at 0.1 an 11px name is
 * about 3 screen px even after `zoomRelief` enlarges it, and every network of more than
 * ~200 people opens below that. Those specks carried no information and were the largest
 * single raster cost of a zoom frame — a thousand runs of text re-rasterised at every scale
 * step. Above 0.1 nothing changes: a small network's opening view (0.157 at 100 people)
 * labels exactly as it always did.
 */
const LABEL_HIDE_BELOW_ZOOM = 0.1;

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

  // Rings are pure background texture — faint dashes that give the sky some depth. They
  // hold still: the slow spin they used to have was a standing compositor layer the size of
  // the whole sky, re-rastered at every zoom step, for motion nobody could perceive.
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
        <svg
          width={max * 2}
          height={max * 2}
          className="absolute inset-0 overflow-visible"
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
      {/* A gradient rather than `blur-[3px]` on a solid disc: the same soft edge, painted
          once instead of filtered on every raster. */}
      <div
        className={cn(
          "absolute rounded-full",
          selected ? "h-20 w-20" : "h-16 w-16"
        )}
        style={{
          background:
            "radial-gradient(closest-side, rgba(255,255,255,0.55) 0%, rgba(255,255,255,0.35) 70%, transparent 100%)",
        }}
      />
      <div
        className={cn(
          "relative z-10 rounded-full",
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

/**
 * The invisible disc that actually catches the click. It is absolutely positioned, so
 * it does not change the node's measured box or the layout React Flow derives from it.
 * See `STAR_HIT_PAD` in `@/lib/graph/star-style` for why it is sized the way it is.
 */
function StarHitTarget({ disc }: { disc: number }) {
  const hit = disc + STAR_HIT_PAD;
  return (
    <span
      aria-hidden
      className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full"
      style={{ width: hit, height: hit }}
    />
  );
}

function ContactNodeComponent({
  data,
  selected,
}: NodeProps & { data: GraphNodeData }) {
  // Rounded so a pan/zoom gesture does not re-render every star on every frame — the
  // same trick ClusterLabelNodeComponent uses.
  const zoom = useStore((s) => Math.round(s.transform[2] * 20) / 20);
  const {
    isComet,
    dimmedScatter,
    size,
    disc: starDisc,
    glow,
    spotlightBoost,
    alphaScale,
    fill,
    core,
    subtitle,
  } = starVisual(data, Boolean(selected));
  const bright = selected || Boolean(data.spotlight);
  // Unmounted rather than hidden: an invisible label still costs its DOM, style and raster.
  const showLabel = Boolean(data.labelPinned) || zoom >= LABEL_HIDE_BELOW_ZOOM;
  /**
   * Handles only where a figure line ends. React Flow needs them to anchor an edge and
   * measures every one on mount; a scatter star has no edges, so its pair was two DOM
   * nodes and two layout reads apiece for nothing.
   */
  const anchorsLines = data.figureRole === "figure";

  if (isComet) {
    const angleDeg = ((data.orbitAngle ?? 0) * 180) / Math.PI;
    const disc = size + 2;
    return (
      <div
        className={cn(
          "group relative cursor-pointer",
          data.entering && "constellation-planet-enter",
          data.raised && "z-20"
        )}
        style={{ width: disc, height: disc }}
      >
        {anchorsLines && <StarHandles />}
        <StarHitTarget disc={disc} />
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
        {showLabel && (
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
        )}
      </div>
    );
  }

  const disc = starDisc;
  /**
   * The glow is a radial gradient on a wider span behind the disc rather than a blurred
   * `box-shadow` on it. It draws the same falloff — the old shadow's inner blur at 0.32 and
   * its wide spread at 0.1 — but a box-shadow blur is a Gaussian filter re-run over every
   * star at every zoom raster, and at 1,000 stars that was among the largest paint costs of
   * a frame. A gradient is a plain fill.
   */
  const reach = glow * spotlightBoost;
  const halo = Math.round(disc + reach * 6);
  const haloCore = Math.round((disc / halo) * 100);
  /**
   * Applied as a transform on the disc only, so the node's measured box, the label
   * positions and the non-overlap proof in `scripts/smoke-graph-layout.ts` are all
   * untouched. See `zoomRelief` in `@/lib/graph/star-style` for the reasoning.
   */
  const zoomRelief = starZoomRelief(disc, zoom);

  return (
    <div
      className={cn(
        "group relative cursor-pointer",
        data.entering && "constellation-planet-enter",
        data.raised && "z-20",
        data.spotlight && "z-30"
      )}
      style={{ width: disc, height: disc }}
    >
      {anchorsLines && <StarHandles />}
      <StarHitTarget disc={disc} />
      {/* Bob wrapper: the sole search hit hovers gently up and down. */}
      <div
        className={cn(
          "relative h-full w-full",
          data.spotlightSolo && "constellation-bob"
        )}
        style={
          zoomRelief > 1
            ? { transform: `scale(${zoomRelief.toFixed(3)})` }
            : undefined
        }
      >
        <span
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-1/2 rounded-full"
          style={{
            width: halo,
            height: halo,
            marginLeft: -halo / 2,
            marginTop: -halo / 2,
            background: `radial-gradient(closest-side, ${withAlpha(
              fill,
              0.32 * spotlightBoost * alphaScale
            )} ${haloCore}%, ${withAlpha(fill, 0.1 * alphaScale)} ${Math.min(
              92,
              haloCore + 30
            )}%, transparent 100%)`,
          }}
        />
        <div
          className={cn(
            "relative h-full w-full rounded-full transition-transform duration-200",
            selected && "scale-125",
            data.spotlight && "constellation-spotlight-ring",
            data.overdue && "ring-1 ring-[#c4a35a]/80"
          )}
          style={{
            background: `radial-gradient(circle at 35% 30%, #fff 0%, ${core} 50%, transparent 78%)`,
          }}
          title={`${data.label}${data.company ? ` · ${data.company}` : ""}${
            data.school ? ` · ${data.school}` : ""
          }`}
        />
        {showLabel && (
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
        )}
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

function NebulaNodeComponent({ data }: NodeProps & { data: NebulaData }) {
  const r = data.radius;
  const color = data.color;

  // Soft lobes only. The wash used to add two rotated conic "filament" layers under
  // `mask-image`, and blur all three (one by 30% of the radius) inside a breathing
  // animation. Each nebula is a box four radii across, so those filters were the most
  // expensive surfaces in the sky, re-rastered at every zoom — and the spokes they drew were
  // visual noise over the stars a reader is trying to pick out. Offset radial gradients
  // already fade to nothing; they need no blur to read as a cloud.
  const { size, lobes } = useMemo(() => {
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

    return { size, lobes };
  }, [data.company, color, r]);

  return (
    <div
      className="nodrag cursor-pointer"
      style={{ width: size, height: size }}
      title={`Zoom to ${data.company}`}
      aria-label={`Zoom to ${data.company} cluster`}
    >
      <div
        className="absolute inset-0"
        style={{ width: size, height: size, background: lobes }}
      />
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
  const count = data.count ?? 0;

  return (
    <div
      className="nopan nodrag flex cursor-pointer flex-col items-center px-2 py-1"
      title={`Zoom to ${data.label}`}
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
      {/* In the summary view the cluster stands in for its people, so it says how many. */}
      {data.summary && count > 0 && (
        <span className="whitespace-nowrap text-[9px] font-medium tabular-nums tracking-[0.06em] text-white/55">
          {count.toLocaleString()} {count === 1 ? "person" : "people"}
        </span>
      )}
    </div>
  );
}

export type StarDustPoint = {
  id: string;
  x: number;
  y: number;
  /** The star's drawn diameter in layout px (`starVisual().disc`). */
  disc: number;
  color: string;
  alpha: number;
};

export type StarDustData = {
  kind: "starDust";
  points: StarDustPoint[];
  /** World-space box the canvas covers. */
  minX: number;
  minY: number;
  width: number;
  height: number;
};

/** Longest side of the dust canvas's backing store, whatever the sky's size. */
const STAR_DUST_MAX_BACKING_PX = 2048;

/**
 * Everyone in the sky, as one canvas of dots: the summary view's stand-in for the stars.
 *
 * It is a node rather than an overlay so it rides React Flow's viewport transform exactly —
 * a pan moves it in the same composited frame as the clusters over it — and so its `zIndex`
 * can put it beneath them. It is drawn in world units at the camera's current zoom, and
 * redrawn only when that zoom crosses a step or the sky changes: a pan costs it nothing.
 * Each dot is the size the DOM star would have been on screen, relief included, so the
 * switch between views reads as the stars simply losing their names.
 */
function StarDustNodeComponent({ data }: NodeProps & { data: StarDustData }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const zoom = useStore((s) => Math.round(s.transform[2] * 100) / 100);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const scale = Math.min(
      Math.max(zoom, 0.01) * dpr,
      STAR_DUST_MAX_BACKING_PX / Math.max(data.width, data.height)
    );
    canvas.width = Math.max(1, Math.ceil(data.width * scale));
    canvas.height = Math.max(1, Math.ceil(data.height * scale));
    ctx.setTransform(scale, 0, 0, scale, -data.minX * scale, -data.minY * scale);
    ctx.clearRect(data.minX, data.minY, data.width, data.height);
    // At least a pixel and a half on screen, or a dim dot vanishes into the backing store.
    const minRadius = 0.75 / Math.max(zoom, 0.01);
    for (const p of data.points) {
      const r = Math.max(minRadius, (p.disc * starZoomRelief(p.disc, zoom)) / 2);
      ctx.globalAlpha = p.alpha;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }, [data, zoom]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="constellation-star-dust pointer-events-none block"
      style={{ width: data.width, height: data.height }}
    />
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
export const StarDustNode = memo(StarDustNodeComponent);
export const LabeledEdge = memo(LabeledEdgeComponent);
