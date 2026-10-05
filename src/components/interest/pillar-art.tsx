/**
 * The three small pictures on the waitlist's feature pillars: a network gathered around
 * one centre, an orbit with the next stop lit ahead of you, and familiar tools flowing
 * into a hub. Abstract on purpose — the waitlist says what the product is for, never
 * what it looks like.
 *
 * Server-rendered SVG, no JS. Drawn by default; when `<Reveal>` brings the row in, the
 * lines trace themselves once and the points light up in turn (globals.css, `pillar-*`).
 * Hovering a pillar brightens its glow. Nothing loops.
 */
export type PillarArtKind = "network" | "ahead" | "tools";

const TEAL = "rgba(122, 168, 150, 0.45)";
const TEAL_FAINT = "rgba(122, 168, 150, 0.22)";
const GOLD = "#f2c14e";
const INK = "rgba(232, 243, 241, 0.75)";

/** Staggered start for a point that lights up, in seconds. */
const at = (i: number) => ({ animationDelay: `${0.45 + i * 0.07}s` });

function Network({ glow }: { glow: string }) {
  const nodes = [
    [40, 30],
    [52, 72],
    [112, 24],
    [126, 60],
    [86, 12],
    [78, 86],
    [26, 56],
    [138, 38],
  ] as const;
  return (
    <>
      <ellipse cx={80} cy={48} rx={62} ry={40} fill="none" stroke={TEAL_FAINT} strokeDasharray="2 5" />
      {nodes.map(([x, y]) => (
        <path key={`${x}-${y}`} d={`M 80 48 L ${x} ${y}`} pathLength={1} stroke={TEAL} className="pillar-draw" />
      ))}
      {nodes.map(([x, y], i) => (
        <circle key={`n-${x}-${y}`} cx={x} cy={y} r={2.4} fill={INK} className="pillar-pop" style={at(i)} />
      ))}
      <circle cx={80} cy={48} r={16} fill={glow} className="pillar-glow" />
      <circle cx={80} cy={48} r={5} fill={GOLD} className="pillar-pop" style={at(nodes.length)} />
    </>
  );
}

function Ahead({ glow }: { glow: string }) {
  // The orbit x = 80 + 58cosθ, y = 48 + 24sinθ. You are at θ = 160°, the lit stop at 300°;
  // the gold arc between them runs the way the orbit turns.
  const others = [
    [138, 48],
    [80, 72],
  ] as const;
  return (
    <>
      <ellipse cx={80} cy={48} rx={58} ry={24} fill="none" stroke={TEAL} />
      <path
        d="M 25.5 56.2 A 58 24 0 0 1 109 27.2"
        pathLength={1}
        fill="none"
        stroke={GOLD}
        strokeWidth={1.5}
        strokeLinecap="round"
        className="pillar-draw"
        style={{ animationDelay: "0.3s" }}
      />
      {others.map(([x, y], i) => (
        <circle key={`${x}-${y}`} cx={x} cy={y} r={2.2} fill={INK} opacity={0.6} className="pillar-pop" style={at(i)} />
      ))}
      <circle cx={25.5} cy={56.2} r={4.5} fill="#cfe3dd" className="pillar-pop" style={at(0)} />
      <circle cx={109} cy={27.2} r={16} fill={glow} className="pillar-glow" />
      <circle cx={109} cy={27.2} r={9} fill="none" stroke={GOLD} strokeOpacity={0.45} className="pillar-pop" style={at(3)} />
      <circle cx={109} cy={27.2} r={4} fill={GOLD} className="pillar-pop" style={at(3)} />
    </>
  );
}

function Tools({ glow }: { glow: string }) {
  const rows = [18, 48, 78];
  return (
    <>
      {rows.map((y) => (
        <path
          key={y}
          d={`M 40 ${y} C 80 ${y}, 82 48, 114 48`}
          pathLength={1}
          fill="none"
          stroke={TEAL}
          className="pillar-draw"
        />
      ))}
      {/* An envelope, a calendar and an app grid: the everyday tools, not any one brand. */}
      <g className="pillar-pop" style={at(0)}>
        <rect x={22} y={9} width={18} height={18} rx={5} fill="rgba(232,243,241,0.06)" stroke={TEAL} />
        <path d="M 26 14.5 h 10 v 8 h -10 z M 26 14.5 l 5 4 l 5 -4" fill="none" stroke={INK} strokeWidth={1} />
      </g>
      <g className="pillar-pop" style={at(1)}>
        <rect x={22} y={39} width={18} height={18} rx={5} fill="rgba(232,243,241,0.06)" stroke={TEAL} />
        <path d="M 26 44 h 10 v 9 h -10 z M 26 47 h 10 M 29 42.5 v 3 M 33 42.5 v 3" fill="none" stroke={INK} strokeWidth={1} />
      </g>
      <g className="pillar-pop" style={at(2)}>
        <rect x={22} y={69} width={18} height={18} rx={5} fill="rgba(232,243,241,0.06)" stroke={TEAL} />
        {[0, 1].flatMap((r) =>
          [0, 1].map((c) => <rect key={`${r}${c}`} x={26.5 + c * 5.5} y={73.5 + r * 5.5} width={3.5} height={3.5} rx={1} fill={INK} />)
        )}
      </g>
      <circle cx={122} cy={48} r={18} fill={glow} className="pillar-glow" />
      <circle cx={122} cy={48} r={8} fill="none" stroke={GOLD} strokeOpacity={0.5} className="pillar-pop" style={at(4)} />
      <circle cx={122} cy={48} r={3.5} fill={GOLD} className="pillar-pop" style={at(4)} />
    </>
  );
}

export function PillarArt({ kind }: { kind: PillarArtKind }) {
  // One gradient per picture: three SVGs on the page must not share an id.
  const glowId = `pillar-glow-${kind}`;
  const glow = `url(#${glowId})`;
  return (
    <svg viewBox="0 0 160 96" aria-hidden="true" className="h-24 w-full" fill="none" strokeWidth={1}>
      <defs>
        <radialGradient id={glowId}>
          <stop offset="0%" stopColor="rgba(242,193,78,0.45)" />
          <stop offset="100%" stopColor="rgba(242,193,78,0)" />
        </radialGradient>
      </defs>
      {kind === "network" ? <Network glow={glow} /> : kind === "ahead" ? <Ahead glow={glow} /> : <Tools glow={glow} />}
    </svg>
  );
}
