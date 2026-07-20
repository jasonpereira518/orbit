"use client";

import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { cn } from "@/lib/utils";
import {
  RING_LABELS,
  type ClusterLabelData,
  type GraphNodeData,
  type OrbitRingsData,
} from "@/lib/graph-layout";

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
              stroke="rgba(255,255,255,0.14)"
              strokeWidth={1}
              strokeDasharray={i % 2 === 0 ? "2 14" : "1 10"}
              opacity={0.55}
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
          selected ? "h-40 w-40" : "h-36 w-36"
        )}
        style={{
          background:
            "radial-gradient(circle, rgba(255,248,220,0.35) 0%, rgba(255,220,150,0.12) 40%, transparent 70%)",
        }}
      />
      <div
        className={cn(
          "constellation-corona absolute rounded-full bg-white/40 blur-[2px]",
          selected ? "h-16 w-16" : "h-14 w-14"
        )}
      />
      <div
        className={cn(
          "relative z-10 rounded-full",
          "bg-[radial-gradient(circle_at_35%_30%,_#ffffff_0%,_#fff6d6_35%,_#f0d48a_70%,_#c4a35a_100%)]",
          "shadow-[0_0_28px_8px_rgba(255,240,200,0.55),0_0_60px_16px_rgba(196,163,90,0.25)]",
          selected && "ring-1 ring-white/70"
        )}
        style={{ width: 18, height: 18 }}
        title={data.label}
      />
      <p className="absolute top-7 whitespace-nowrap text-[11px] font-medium tracking-wide text-white/90">
        {data.label}
      </p>
    </div>
  );
}

function starSize(score: number) {
  return 5 + score * 2.2;
}

function starColor(
  score: number,
  dormant: boolean | undefined,
  overdue?: boolean
) {
  if (dormant) return "rgba(180, 190, 200, 0.55)";
  if (overdue) return "#f0d48a";
  if (score >= 5) return "#fff8e7";
  if (score >= 4) return "#ffffff";
  if (score >= 3) return "#e8f0ff";
  return "#d7e0ea";
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

  return (
    <div
      className={cn(
        "constellation-planet-enter group relative flex flex-col items-center",
        data.dormant && "opacity-45",
        data.motionPaused && "z-20"
      )}
    >
      <Handle
        type="target"
        position={Position.Top}
        className="!opacity-0"
        isConnectable={false}
      />
      <Handle
        type="source"
        position={Position.Bottom}
        className="!opacity-0"
        isConnectable={false}
      />
      <div
        className={cn(
          "relative rounded-full transition-transform duration-200",
          selected && "scale-125",
          data.spotlight && "constellation-spotlight-ring",
          data.overdue && !data.dormant && "ring-1 ring-[#c4a35a]/80"
        )}
        style={{
          width: size,
          height: size,
          background: `radial-gradient(circle at 35% 30%, #fff 0%, ${starColor(score, data.dormant, data.overdue)} 55%, transparent 80%)`,
          boxShadow: data.dormant
            ? `0 0 ${glow}px ${glow / 3}px rgba(180,190,200,0.25)`
            : `0 0 ${glow}px ${glow / 2}px ${starColor(score, false, data.overdue)}66`,
        }}
        title={`${data.label}${data.company ? ` · ${data.company}` : ""}`}
      />
      {labelMode !== "never" && (
        <div
          className={cn(
            "pointer-events-none mt-2 max-w-[130px] text-center transition-opacity duration-200",
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
                bright
                  ? "opacity-100"
                  : "opacity-0 group-hover:opacity-100"
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

function ClusterLabelNodeComponent({
  data,
}: NodeProps & { data: ClusterLabelData }) {
  return (
    <div className="pointer-events-none">
      <p className="whitespace-nowrap text-center text-[10px] font-medium uppercase tracking-[0.14em] text-white/45">
        {data.label}
      </p>
    </div>
  );
}

export const OrbitRingsNode = memo(OrbitRingsNodeComponent);
export const SunNode = memo(SunNodeComponent);
export const ContactNode = memo(ContactNodeComponent);
export const ClusterLabelNode = memo(ClusterLabelNodeComponent);
