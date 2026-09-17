"use client";

import { memo, useLayoutEffect, useMemo, useRef } from "react";
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
import { useCameraMoving } from "@/components/graph/camera-motion";
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
  /**
   * Unmounted rather than hidden: an invisible label still costs its DOM, style and raster.
   *
   * `labelPinned` (hovered, selected, the sole search hit) always shows. Otherwise the star
   * must have won its place in the chart's collision pass (`labelHidden` false) — labels are
   * drawn in world units, so names that overlap overlap at every zoom, and a dense cluster
   * read as one illegible smear — and search hits show at any zoom while the rest wait for 0.1.
   */
  const showLabel =
    Boolean(data.labelPinned) ||
    (!data.labelHidden && (Boolean(data.spotlight) || zoom >= LABEL_HIDE_BELOW_ZOOM));
  /**
   * Handles only where a figure line ends. React Flow needs them to anchor an edge and
   * measures every one on mount; a scatter star has no edges, so its pair was two DOM
   * nodes and two layout reads apiece for nothing.
   */
  const anchorsLines = data.figureRole === "figure";

  if (isComet) {
    const angleDeg = ((data.orbitAngle ?? 0) * 180) / Math.PI;
    const disc = size + 2;
    const cometRelief = starZoomRelief(disc, zoom);
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
              "pointer-events-none absolute left-1/2 z-10 w-max -translate-x-1/2 text-center group-hover:z-30",
              bright ? "opacity-100" : "opacity-75 group-hover:opacity-100"
            )}
            // Sized like a star's name (see `labelScale` below): comets used to keep an 11px
            // name whatever the camera did, so a drifting contact read smaller than the star
            // beside it.
            style={{
              top: (disc * (1 + cometRelief)) / 2 + 8 * cometRelief,
              fontSize: 11 * cometRelief,
              maxWidth: 104 * cometRelief,
            }}
          >
            <p className="truncate font-medium leading-tight text-[#ffb4a0]">
              {data.label}
            </p>
            {subtitle && (
              <p
                className="truncate leading-tight text-[#ff8a70]/70"
                style={{ fontSize: 9 * cometRelief }}
              >
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
  /**
   * The name is sized in px and placed under the enlarged disc, rather than riding a scaled
   * wrapper. `transform: scale()` magnifies the glyphs the browser already drew — inside the
   * chart's composited viewport that is what made names look soft as you zoomed — where a
   * font-size draws them at the size they are shown at.
   */
  const labelScale = zoomRelief;
  const labelTop = (disc * (1 + labelScale)) / 2 + 8 * labelScale;

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
      </div>
      {showLabel && (
        <div
          className={cn(
            "pointer-events-none absolute left-1/2 z-10 w-max -translate-x-1/2 text-center group-hover:z-30",
            bright
              ? "opacity-100"
              : dimmedScatter
                ? "opacity-65 group-hover:opacity-100"
                : "opacity-85 group-hover:opacity-100"
          )}
          style={{
            top: labelTop,
            fontSize: 11 * labelScale,
            maxWidth: 104 * labelScale,
          }}
        >
          <p
            className={cn(
              "truncate font-medium leading-tight text-white/95",
              data.spotlight && "font-semibold text-white"
            )}
          >
            {data.label}
          </p>
          {subtitle && (
            <p
              className={cn(
                "truncate leading-tight text-white/45",
                data.spotlight && "text-white/70"
              )}
              style={{ fontSize: 9 * labelScale }}
            >
              {subtitle}
            </p>
          )}
        </div>
      )}
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
      // No `title`: the haze spans the whole cluster, so a native tooltip followed the pointer
      // over every star in it. The cluster's name label carries the "Zoom to" hint.
      aria-label={`Zoom to ${data.company} cluster`}
    >
      <div
        className="absolute inset-0"
        style={{ width: size, height: size, background: lobes }}
      />
    </div>
  );
}

/**
 * How much larger a cluster's name is than a star's name, at every zoom. A star's name is 11px
 * enlarged by `zoomRelief` as the camera pulls back; the cluster title follows the same curve
 * (for a typical 12px star), so it stays the bigger of the two however far you zoom.
 */
const CLUSTER_NAME_RATIO = 1.25;
/**
 * The smallest a cluster's name is ever drawn, in screen px. Scaling with the stars alone left
 * the zoomed-out sky's names one or two pixels tall — unreadable, in the one view whose whole
 * point is the clusters. The chart hides names that would overlap (see `clusterNameWinners`).
 */
const CLUSTER_NAME_MIN_SCREEN_PX = 12;
const CLUSTER_NAME_FONT_PX = 11;

/** How much a cluster name is scaled at a zoom: 1.25x a star's name, and never under 12px. */
export function clusterNameScale(zoom: number) {
  const k = Math.max(zoom, 0.01);
  return Math.max(
    CLUSTER_NAME_RATIO * starZoomRelief(TYPICAL_STAR_DISC, k),
    CLUSTER_NAME_MIN_SCREEN_PX / (CLUSTER_NAME_FONT_PX * k)
  );
}

/** A cluster name's box in layout px at a zoom, bottom-centred on its anchor. */
export function clusterNameSize(label: string, withCount: boolean, zoom: number) {
  const sc = clusterNameScale(zoom);
  return {
    width: (label.length * CLUSTER_NAME_CHAR_W + 16) * sc,
    height: (CLUSTER_NAME_LINE_H + (withCount ? CLUSTER_COUNT_LINE_H : 0) + 4) * sc,
  };
}
const TYPICAL_STAR_DISC = 12;
/** The name's line box and the headcount line's, in unscaled px. */
const CLUSTER_NAME_LINE_H = 15;
const CLUSTER_COUNT_LINE_H = 12;
/** Rough advance of the 11px semibold, letter-spaced name — enough to keep it on screen. */
const CLUSTER_NAME_CHAR_W = 7.4;
/** Below this zoom the name never pins; the whole sky is in view and every name is too. */
export const CLUSTER_NAME_PIN_MIN_ZOOM = 0.3;
/** Screen px kept clear at the top (the chart's search and cluster controls) and the sides. */
const CLUSTER_NAME_PIN_TOP_PX = 64;
const CLUSTER_NAME_PIN_SIDE_PX = 16;

/** A cluster's name, and in the summary view its headcount, before any scaling. */
function ClusterNameText({ data, showCount }: { data: ClusterLabelData; showCount: boolean }) {
  const count = data.count ?? 0;
  const brand = data.nebulaColor;
  return (
    <>
      <span className="relative inline-block whitespace-nowrap text-center text-[1em] font-semibold leading-[1.36] tracking-[0.08em]">
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
      {showCount && (
        <span className="relative whitespace-nowrap text-[0.82em] font-medium leading-[1.2] tabular-nums tracking-[0.06em] text-white/55">
          {count.toLocaleString()} {count === 1 ? "person" : "people"}
        </span>
      )}
    </>
  );
}

function ClusterLabelNodeComponent(props: NodeProps & { data: ClusterLabelData }) {
  const { data } = props;
  // Sixteenth-of-an-octave steps: proportional, so a far-out zoom (where the 12px floor sets the
  // size) does not jump by a quarter at a time the way a fixed 1/40 step did.
  const zoom = useStore((s) =>
    Math.pow(2, Math.round(Math.log2(Math.max(s.transform[2], 0.01)) * 16) / 16)
  );
  const scale = clusterNameScale(zoom);
  const showCount = Boolean(data.summary) && (data.count ?? 0) > 0;

  if (data.pinnable && data.box && data.anchor) {
    return <PinnableClusterName {...props} scale={scale} showCount={showCount} />;
  }

  /**
   * Zoomed out: just the name, as its own node. The node is placed by its bottom-centre
   * (origin [0.5, 1], set by the chart) at the anchor above the cluster, and scaled about that
   * point so it grows upward, away from the stars.
   *
   * Deliberately none of the pinning machinery. A cluster-sized box per name, even an invisible
   * one, halved the frame rate of a pan across a 10,000-person sky of 870 clusters; this is the
   * markup that holds 60.
   */
  return (
    <div
      className="nopan nodrag flex cursor-pointer flex-col items-center px-[0.7em] py-[0.05em]"
      title={`Zoom to ${data.label}`}
      // Drawn at its size rather than scaled up: scaling magnifies glyphs the browser already
      // rasterised, which is why names went soft as the camera came in. It also makes the node's
      // measured box the box you see, so the name really does sit on its anchor.
      style={{ fontSize: 11 * scale }}
    >
      <ClusterNameText data={data} showCount={showCount} />
    </div>
  );
}

/**
 * Zoomed in: the name, kept in view while you look at its cluster.
 *
 * The node spans the whole cluster (`data.box`), so it is on screen whenever any of the cluster
 * is, and it lets pointers through everywhere but the name. The name's home is just above the
 * cluster's top star; once the camera is close enough that home is off the top (or side) of the
 * view, the name slides along the view's edge instead, for as long as the cluster is still on
 * screen, and leaves with it.
 */
function PinnableClusterName({
  data,
  width,
  height,
  positionAbsoluteX,
  positionAbsoluteY,
  scale,
  showCount,
}: NodeProps & { data: ClusterLabelData; scale: number; showCount: boolean }) {
  const box = data.box ?? { width: width ?? 0, height: height ?? 0 };
  const anchor = data.anchor ?? { x: box.width / 2, y: 0 };

  // A string, so a pan re-renders only a name that is actually pinned: every other one
  // computes "0|0" frame after frame and stays put.
  const pin = useStore((s) => {
    const [tx, ty, k] = s.transform;
    const sc = clusterNameScale(k);
    const nameH = (CLUSTER_NAME_LINE_H + (showCount ? CLUSTER_COUNT_LINE_H : 0)) * sc;
    const halfW = (data.label.length * CLUSTER_NAME_CHAR_W * sc) / 2;

    const viewTop = (CLUSTER_NAME_PIN_TOP_PX - ty) / k - positionAbsoluteY;
    const viewLeft = (CLUSTER_NAME_PIN_SIDE_PX - tx) / k - positionAbsoluteX;
    const viewRight = (s.width - CLUSTER_NAME_PIN_SIDE_PX - tx) / k - positionAbsoluteX;

    // Down, never below the box: past that the cluster is leaving and the name goes with it.
    const dy = Math.min(Math.max(0, viewTop - (anchor.y - nameH)), box.height - anchor.y);
    // Across, within the view where it fits and never beyond the cluster's own edges.
    let x = anchor.x;
    if (viewRight - viewLeft > halfW * 2) {
      x = Math.min(Math.max(x, viewLeft + halfW), viewRight - halfW);
    }
    x = Math.min(Math.max(x, 0), box.width);
    const px = (v: number) => Math.round(v * k) / k;
    return `${px(x - anchor.x)}|${px(dy)}`;
  });
  const [dx, dy] = pin.split("|").map(Number);
  const pinned = dx !== 0 || dy !== 0;

  return (
    <div className="pointer-events-none relative" style={{ width: box.width, height: box.height }}>
      <div
        className="nopan nodrag pointer-events-auto absolute flex w-max cursor-pointer flex-col items-center px-[0.7em] py-[0.05em]"
        title={`Zoom to ${data.label}`}
        style={{
          left: anchor.x + dx,
          top: anchor.y + dy,
          // Bottom-centre on the anchor, so the name grows upward, away from the stars. Sized in
          // px rather than scaled, so the glyphs are drawn at the size they are read at.
          transform: "translate(-50%, -100%)",
          fontSize: 11 * scale,
        }}
      >
        {/* Pinned over the stars, it needs a ground to stay legible. Solid, not blurred. */}
        {pinned && (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-full bg-[#05070c]/75"
          />
        )}
        <ClusterNameText data={data} showCount={showCount} />
      </div>
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
  // Quarter-octave steps: a camera flight crosses a few of these, not one per frame. Redrawing
  // at every 0.01 of zoom repainted thousands of dots on most frames of a search's flight in.
  const zoom = useStore((s) =>
    Math.pow(2, Math.round(Math.log2(Math.max(s.transform[2], 0.01)) * 4) / 4)
  );

  /**
   * Held still while the camera moves. Redrawing means filling thousands of dots and handing
   * the whole backing store to the GPU again; at 10,000 contacts that was a 100ms frame at
   * every zoom step of a pinch. The canvas rides the viewport's transform meanwhile, like the
   * rest of the sky, and is redrawn at its proper scale the moment the camera stops.
   */
  const moving = useCameraMoving();
  const drawnOnce = useRef(false);

  // A layout effect, so the dots are drawn before the frame that shows the canvas is painted.
  // As an ordinary effect the canvas painted empty first — a blank frame each time the summary
  // began, and at every zoom step on the way, where the redraw clears it.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    // Never skip the first draw: the canvas can appear mid-gesture, and an empty one is a hole.
    if (moving && drawnOnce.current) return;
    drawnOnce.current = true;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const scale = Math.min(
      Math.max(zoom, 0.01) * dpr,
      STAR_DUST_MAX_BACKING_PX / Math.max(data.width, data.height)
    );
    const w = Math.max(1, Math.ceil(data.width * scale));
    const h = Math.max(1, Math.ceil(data.height * scale));
    // Resizing reallocates and clears the backing store; do it only when the size changed.
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    ctx.setTransform(scale, 0, 0, scale, -data.minX * scale, -data.minY * scale);
    ctx.clearRect(data.minX, data.minY, data.width, data.height);
    // At least a pixel and a half on screen, or a dim dot vanishes into the backing store.
    const minRadius = 0.75 / Math.max(zoom, 0.01);
    // One path and one fill per colour and strength rather than per dot: a sky has a handful of
    // those and thousands of dots, and a search redraws all of them on each keystroke.
    const batches = new Map<string, StarDustPoint[]>();
    for (const p of data.points) {
      const key = `${p.color}|${p.alpha.toFixed(2)}`;
      const batch = batches.get(key);
      if (batch) batch.push(p);
      else batches.set(key, [p]);
    }
    for (const batch of batches.values()) {
      ctx.globalAlpha = batch[0].alpha;
      ctx.fillStyle = batch[0].color;
      ctx.beginPath();
      for (const p of batch) {
        const r = Math.max(minRadius, (p.disc * starZoomRelief(p.disc, zoom)) / 2);
        ctx.moveTo(p.x + r, p.y);
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      }
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }, [data, zoom, moving]);

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
