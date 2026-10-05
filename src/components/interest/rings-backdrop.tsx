/**
 * The orbit diagram behind the signup card: concentric rings, one gold cadence
 * ring, and a few motes riding them, all turning slowly. Pure SVG + CSS, so it
 * ships in the document and costs nothing to hydrate — deliberately NOT the
 * landing hero's `HeroSolarSystem`, which drags eight planet textures and a rAF
 * loop along with it.
 *
 * The radial mask fades the rings out before they reach the heading above and
 * the copy below; what remains reads as depth behind the card, not as a diagram.
 * Ring colour matches the hero's (`hero-solar-system.tsx`), a shade stronger because
 * the mask and the 720px spread would otherwise fade it to nothing.
 *
 * Each turning set is its OWN <svg>, spun as a whole. A CSS transform on an SVG child
 * (`<g>`) is not composited: Chrome recalculated style and repainted the 720px masked
 * diagram every frame of the page's life, even scrolled thousands of pixels away. A
 * transform on the <svg> box itself runs on the compositor and costs the main thread
 * nothing. Both sets are centred on the viewBox, so turning the whole box is the same turn.
 */
const SVG = "absolute inset-0 size-full";

export function RingsBackdrop() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute left-1/2 top-1/2 -z-10 size-[720px] -translate-x-1/2 -translate-y-1/2 [mask-image:radial-gradient(circle,black_30%,transparent_70%)]"
    >
      <svg viewBox="0 0 440 440" className={`${SVG} interest-rings-spin`}>
        {[78, 132, 186, 220].map((r) => (
          <circle
            key={r}
            cx={220}
            cy={220}
            r={r}
            fill="none"
            stroke="rgba(122, 168, 150, 0.26)"
            strokeWidth={0.5}
          />
        ))}
        <circle
          cx={220}
          cy={220}
          r={156}
          fill="none"
          stroke="rgba(242, 193, 78, 0.32)"
          strokeWidth={0.75}
          strokeDasharray="2 6"
        />
        {/* Motes on the rings: (cx, cy) chosen so each sits exactly on its orbit. */}
        <circle cx={220 + 132} cy={220} r={2} fill="rgba(232, 243, 241, 0.5)" />
        <circle cx={220 - 93} cy={220 - 161} r={2} fill="rgba(232, 243, 241, 0.5)" />
        <circle cx={220 + 110} cy={220 + 190.5} r={2} fill="rgba(242, 193, 78, 0.55)" />
      </svg>
      {/* Inner pair turning the other way — the parallax that makes it read as depth. */}
      <svg viewBox="0 0 440 440" className={`${SVG} interest-rings-spin-reverse`}>
        {[40, 56].map((r) => (
          <circle
            key={r}
            cx={220}
            cy={220}
            r={r}
            fill="none"
            stroke="rgba(122, 168, 150, 0.2)"
            strokeWidth={0.5}
          />
        ))}
        <circle cx={220 + 56} cy={220} r={1.5} fill="rgba(232, 243, 241, 0.4)" />
      </svg>
    </div>
  );
}
