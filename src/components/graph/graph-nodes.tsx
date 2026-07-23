"use client";

import { memo } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  Handle,
  Position,
  getStraightPath,
  useInternalNode,
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

  return (
    <div className="pointer-events-none" style={{ width: 0, height: 0 }}>
      <div
        className={cn(
          "absolute",
          data.motionEnabled && "constellation-rings-spin"
        )}
        style={{ left: -max, top: -max, width: max * 2, height: max * 2 }}
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
  // Fixed 22×22 box so nodeOrigin [0.5,0.5] pins the disc (not the corona) at flow (0,0)
  return (
    <div className="relative" style={{ width: 22, height: 22 }}>
      <Handle
        type="source"
        position={Position.Top}
        className="!opacity-0 !h-0 !w-0 !min-h-0 !min-w-0 !border-0"
        isConnectable={false}
      />
      <div
        className={cn(
          "constellation-corona-outer pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full",
          selected ? "h-52 w-52" : "h-44 w-44"
        )}
        style={{
          background:
            "radial-gradient(circle, rgba(255,248,220,0.42) 0%, rgba(255,200,100,0.18) 35%, rgba(255,160,60,0.06) 55%, transparent 72%)",
        }}
      />
      <div
        className={cn(
          "constellation-corona pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/50 blur-[3px]",
          selected ? "h-20 w-20" : "h-16 w-16"
        )}
      />
      <div
        className={cn(
          "constellation-sun-core absolute inset-0 z-10 rounded-full",
          "bg-[radial-gradient(circle_at_35%_30%,_#ffffff_0%,_#fff6d6_28%,_#f5c86a_65%,_#e09030_100%)]",
          "shadow-[0_0_32px_10px_rgba(255,240,200,0.65),0_0_72px_22px_rgba(255,170,60,0.35),0_0_100px_40px_rgba(255,140,40,0.15)]",
          selected && "ring-2 ring-white/80"
        )}
        title={data.label}
      />
      <p className="pointer-events-none absolute left-1/2 top-[28px] -translate-x-1/2 whitespace-nowrap text-[11px] font-medium tracking-wide text-white/95 drop-shadow-[0_0_8px_rgba(0,0,0,0.8)]">
        {data.label}
      </p>
    </div>
  );
}

function starSize(score: number) {
  return 5 + score * 2.2;
}

function ContactNodeComponent({
  data,
  selected,
}: NodeProps & { data: GraphNodeData }) {
  const score = data.score || 2;
  const size = starSize(score);
  const labelMode = data.labelMode ?? "hover";
  const glow = Math.max(4, score * 3);
  const bright =
    labelMode === "always" || selected || Boolean(data.spotlight);
  const isComet = Boolean(data.comet);

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
        {labelMode !== "never" && (
          <div
            className={cn(
              "pointer-events-none absolute left-1/2 top-full z-10 mt-2 w-max max-w-[130px] -translate-x-1/2 text-center transition-opacity duration-200",
              bright ? "opacity-100" : "opacity-50 group-hover:opacity-100"
            )}
          >
            <p className="truncate text-[11px] font-medium leading-tight text-[#ffb4a0]">
              {data.label}
            </p>
            {data.company && (
              <p className="truncate text-[9px] text-[#ff8a70]/70">
                {data.company}
              </p>
            )}
          </div>
        )}
      </div>
    );
  }

  const fill = "#ffffff";
  const spotlightBoost = data.spotlight ? 1.55 : 1;
  const disc = size * (data.spotlight ? 1.15 : 1);

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
          "relative h-full w-full rounded-full transition-transform duration-200",
          selected && "scale-125",
          data.spotlight && "constellation-spotlight-ring",
          data.overdue && "ring-1 ring-[#c4a35a]/80"
        )}
        style={{
          background: `radial-gradient(circle at 35% 30%, #fff 0%, ${fill} 50%, transparent 78%)`,
          boxShadow: `0 0 ${glow * spotlightBoost}px ${
            (glow / 2) * spotlightBoost
          }px ${withAlpha(fill, 0.55 * spotlightBoost)}, 0 0 ${
            glow * 2 * spotlightBoost
          }px ${glow * spotlightBoost}px ${withAlpha(fill, 0.2)}`,
        }}
        title={`${data.label}${data.company ? ` · ${data.company}` : ""}${
          data.school ? ` · ${data.school}` : ""
        }`}
      />
      {labelMode !== "never" && (
        <div
          className={cn(
            "pointer-events-none absolute left-1/2 top-full z-10 mt-2 w-max max-w-[130px] -translate-x-1/2 text-center transition-opacity duration-200",
            bright ? "opacity-100" : "opacity-40 group-hover:opacity-100"
          )}
        >
          <p className="truncate text-[11px] font-medium leading-tight text-white/95">
            {data.label}
          </p>
          {data.company && (
            <p
              className={cn(
                "truncate text-[9px] text-white/45 transition-opacity duration-200",
                bright ? "opacity-100" : "opacity-0 group-hover:opacity-100"
              )}
            >
              {data.company}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function NebulaNodeComponent({ data }: NodeProps & { data: NebulaData }) {
  const r = data.radius;
  return (
    <div className="pointer-events-none" style={{ width: 0, height: 0 }}>
      <div
        className="constellation-nebula absolute rounded-full"
        style={{
          left: -r,
          top: -r,
          width: r * 2,
          height: r * 2,
          background: `radial-gradient(circle at 40% 35%, ${withAlpha(
            data.color,
            0.28
          )} 0%, ${withAlpha(data.color, 0.12)} 40%, ${withAlpha(
            data.color,
            0.04
          )} 65%, transparent 78%)`,
          boxShadow: `0 0 ${r * 0.4}px ${withAlpha(data.color, 0.15)}`,
        }}
      />
    </div>
  );
}

function ClusterLabelNodeComponent({
  data,
}: NodeProps & { data: ClusterLabelData }) {
  const brand = data.nebulaColor;
  return (
    <div className="pointer-events-none">
      <p
        className="whitespace-nowrap text-center text-[10px] font-semibold uppercase tracking-[0.18em]"
        style={
          brand
            ? {
                color: brand,
                textShadow: `0 0 12px ${withAlpha(brand, 0.55)}, 0 0 28px ${withAlpha(brand, 0.25)}`,
              }
            : { color: "rgba(255,255,255,0.55)" }
        }
      >
        {data.label}
      </p>
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
