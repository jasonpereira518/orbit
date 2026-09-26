"use client";

import { useState } from "react";
import { motion } from "motion/react";
import { CLUSTERS, CLUSTER_CHAINS, CLUSTER_COLORS, DEMO_PEOPLE, personById, tierOf, type ClusterId } from "./demo-cast";
import { useDemo } from "./demo-context";
import { closenessOf } from "./demo-state";

const W = 800;
const H = 480;
const SUN = { x: 400, y: 250 };

/** Deterministic background stars — the same sky on every render and every visitor. */
const FIELD = Array.from({ length: 90 }, (_, i) => {
  const r = (n: number) => {
    const x = Math.sin(i * 12.9898 + n * 78.233) * 43758.5453;
    return x - Math.floor(x);
  };
  return { x: r(1) * W, y: r(2) * H, s: 0.4 + r(3) * 0.9, o: 0.15 + r(4) * 0.45 };
});

/**
 * The haze behind each figure, as the real sky draws it: a soft core at the cluster's
 * centre plus a few offset lobes, so every cluster reads as its own drifting cloud.
 */
const NEBULAE = (Object.keys(CLUSTERS) as ClusterId[]).map((c, ci) => {
  const stars = DEMO_PEOPLE.filter((p) => p.cluster === c).map((p) => p.star);
  const cx = stars.reduce((a, s) => a + s.x, 0) / stars.length;
  const cy = stars.reduce((a, s) => a + s.y, 0) / stars.length;
  const hash = (n: number) => {
    const x = Math.sin((ci + 1) * 91.7 + n * 12.3) * 9301.13;
    return x - Math.floor(x);
  };
  const lobes = Array.from({ length: 4 }, (_, i) => {
    const angle = hash(i * 3) * Math.PI * 2;
    const dist = 18 + hash(i * 3 + 1) * 34;
    return { x: cx + Math.cos(angle) * dist, y: cy + Math.sin(angle) * dist, r: 48 + hash(i * 3 + 2) * 40, o: 0.45 + hash(i * 3 + 5) * 0.4 };
  });
  return { c, cx, cy, lobes, drift: { x: (hash(20) - 0.5) * 16, y: (hash(21) - 0.5) * 12, s: 16 + hash(22) * 8 } };
});

const HALO = { inner: "#6ee7b7", mid: "#7dd3fc", outer: "#fcd34d" } as const;

function chainPath(chain: string[]) {
  return chain
    .map((id, i) => {
      const p = personById(id)!;
      return `${i === 0 ? "M" : "L"}${p.star.x},${p.star.y}`;
    })
    .join(" ");
}

/**
 * The Constellation's sky: you as the sun, each company or school a figure traced through
 * its people, stars sized by closeness. `mini` is the Dashboard's inert preview.
 */
export function SkyChart({ mini = false }: { mini?: boolean }) {
  const { state, dispatch, reduced } = useDemo();
  const [hover, setHover] = useState<string | null>(null);
  const query = state.skyQuery.trim().toLowerCase();
  const inCluster = (c: ClusterId | null) => mini || state.cluster === "all" || state.cluster === c;
  const selected = mini ? null : personById(state.star);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="block h-full w-full" role={mini ? "img" : "group"} aria-label="Constellation of your network">
      <defs>
        <radialGradient id="demo-sun" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#fff7d6" />
          <stop offset="45%" stopColor="#f2c14e" />
          <stop offset="100%" stopColor="#f2c14e" stopOpacity="0" />
        </radialGradient>
        {NEBULAE.map((n) => (
          <radialGradient key={n.c} id={`demo-neb-${n.c}${mini ? "-m" : ""}`}>
            <stop offset="0%" stopColor={CLUSTER_COLORS[n.c]} stopOpacity={0.34} />
            <stop offset="50%" stopColor={CLUSTER_COLORS[n.c]} stopOpacity={0.12} />
            <stop offset="100%" stopColor={CLUSTER_COLORS[n.c]} stopOpacity={0} />
          </radialGradient>
        ))}
      </defs>

      {FIELD.map((s, i) => (
        <circle key={i} cx={s.x} cy={s.y} r={s.s} fill="#dfe8ff" opacity={s.o} />
      ))}

      {[95, 175, 255].map((r) => (
        <circle key={r} cx={SUN.x} cy={SUN.y} r={r} fill="none" stroke="#7cc3e2" strokeOpacity={0.09} strokeDasharray="2 6" />
      ))}

      {NEBULAE.map((n) => (
        <g key={n.c} opacity={inCluster(n.c) ? 1 : 0.25} style={{ transition: "opacity 300ms" }}>
          <motion.g
            animate={reduced || mini ? undefined : { x: [0, n.drift.x, 0], y: [0, n.drift.y, 0] }}
            transition={{ duration: n.drift.s, repeat: Infinity, ease: "easeInOut" }}
          >
            <circle cx={n.cx} cy={n.cy} r={120} fill={`url(#demo-neb-${n.c}${mini ? "-m" : ""})`} />
            {n.lobes.map((l, i) => (
              <circle key={i} cx={l.x} cy={l.y} r={l.r} fill={`url(#demo-neb-${n.c}${mini ? "-m" : ""})`} opacity={l.o} />
            ))}
          </motion.g>
        </g>
      ))}

      {selected && (
        <line x1={SUN.x} y1={SUN.y} x2={selected.star.x} y2={selected.star.y} stroke="#f2c14e" strokeOpacity={0.35} strokeDasharray="3 5" />
      )}

      {(Object.keys(CLUSTERS) as ClusterId[]).map((c) => (
        <g key={c} opacity={inCluster(c) ? 1 : 0.18} style={{ transition: "opacity 300ms" }}>
          <path d={chainPath(CLUSTER_CHAINS[c])} fill="none" stroke="#9fc4ff" strokeOpacity={0.35} strokeWidth={1.2} />
          {!mini && (
            <text
              x={CLUSTERS[c].labelAt.x}
              y={CLUSTERS[c].labelAt.y}
              textAnchor="middle"
              fill="#96a8c4"
              fontSize={11}
              letterSpacing={2}
              style={{ textTransform: "uppercase" }}
            >
              {CLUSTERS[c].label}
            </text>
          )}
        </g>
      ))}

      <circle cx={SUN.x} cy={SUN.y} r={mini ? 34 : 30} fill="url(#demo-sun)" />
      <circle cx={SUN.x} cy={SUN.y} r={mini ? 9 : 8} fill="#fff4cc" />
      {!mini && (
        <text x={SUN.x} y={SUN.y + 26} textAnchor="middle" fill="#f2c14e" fontSize={11} letterSpacing={1.5}>
          YOU
        </text>
      )}

      {DEMO_PEOPLE.map((p) => {
        const c = closenessOf(state, p);
        const r = 2.6 + c / 24;
        const lit = inCluster(p.cluster);
        const match = query.length > 1 && [p.name, p.company, p.title, ...p.tags].some((f) => f.toLowerCase().includes(query));
        const active = hover === p.id || state.star === p.id;
        const halo = HALO[tierOf(c)];
        return (
          <g
            key={p.id}
            data-demo-target={mini ? undefined : `star-${p.id}`}
            opacity={lit ? 1 : 0.18}
            style={{ transition: "opacity 300ms", cursor: mini ? undefined : "pointer" }}
            role={mini ? undefined : "button"}
            tabIndex={mini ? undefined : 0}
            aria-label={mini ? undefined : `${p.name}, ${p.company}`}
            onPointerEnter={mini ? undefined : () => setHover(p.id)}
            onPointerLeave={mini ? undefined : () => setHover(null)}
            onClick={mini ? undefined : () => dispatch({ type: "star", id: p.id })}
            onKeyDown={
              mini
                ? undefined
                : (e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      dispatch({ type: "star", id: p.id });
                    }
                  }
            }
          >
            <circle cx={p.star.x} cy={p.star.y} r={r * 3.2} fill={halo} opacity={active ? 0.28 : 0.12} />
            {(match || state.star === p.id) && !mini && (
              <circle cx={p.star.x} cy={p.star.y} r={r + 6} fill="none" stroke="#f2c14e" strokeWidth={1.4} />
            )}
            <circle cx={p.star.x} cy={p.star.y} r={r} fill="#f4f8ff" />
            {!mini && <circle cx={p.star.x} cy={p.star.y} r={16} fill="transparent" />}
            {!mini && (
              <text
                x={p.star.x}
                y={p.star.y + r + 14}
                textAnchor="middle"
                fill={match ? "#f2c14e" : active ? "#e4ebf6" : "#96a8c4"}
                fontSize={active ? 12 : 10.5}
                fontWeight={active ? 500 : 400}
                style={{ transition: "fill 200ms", paintOrder: "stroke" }}
                stroke="#070b15"
                strokeWidth={3}
                strokeOpacity={0.7}
              >
                {p.name}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
