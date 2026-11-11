"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { ACCENTS, artLayout, backLayout, cardArtSvg, type CardArt } from "@/lib/cards/card-art";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";
import { cn } from "@/lib/utils";

/** SVG units: only the aspect matters, the art scales to the element. */
const UNITS = { landscape: { width: 1586, height: 1000 }, portrait: { width: 1000, height: 1586 } };
/** The short side in container units, for type that scales with the card. */
const SHORT_SIDE = { landscape: "63.05cqw", portrait: "100cqw" };

const pct = (v: number, of: number) => `${((v / of) * 100).toFixed(3)}%`;
const clamp = (v: number) => Math.max(-1, Math.min(1, v));

type OrientationCtor = typeof DeviceOrientationEvent & { requestPermission?: () => Promise<"granted" | "denied"> };

/**
 * The Orbit Card: the star-chart art under a silver glass sheen, with the name and role laid on
 * top as real text. With `qrSvg` it has a back (the QR in a gold ring) and flips on tap.
 *
 * Tilt follows the pointer on desktop and the phone's orientation on phones (iOS asks on the
 * first tap; refused, a drag tilts it instead). Reduced motion (the one global mechanism:
 * `usePrefersReducedMotion` + theme.css's clamp) leaves a still card that lands drawn.
 */
export function OrbitCard({
  art,
  name,
  role,
  firstName,
  qrSvg,
  side = "front",
  orientation = "landscape",
  entrance = false,
  nameAs: Name = "span",
  className,
}: {
  art: CardArt;
  name: string;
  role: string | null;
  firstName: string;
  /** The server-made QR SVG (fill `currentColor`). Gives the card a back. */
  qrSvg?: string;
  /** The side facing up at first. */
  side?: "front" | "back";
  orientation?: "landscape" | "portrait";
  /** Stars pop and the constellation draws in once, on mount. */
  entrance?: boolean;
  /** The page's heading, where the card is the page. Never inside a flippable card. */
  nameAs?: "h1" | "span";
  className?: string;
}) {
  const reduced = usePrefersReducedMotion();
  const sceneRef = useRef<HTMLDivElement>(null);
  const [flipped, setFlipped] = useState(side === "back");
  const flippable = Boolean(qrSvg);
  const units = UNITS[orientation];
  const { width: W, height: H } = units;

  // The art SVG is built from numbers and fixed colours only — no user text reaches it
  // (lib/cards/card-art.ts, held by scripts/smoke-card-art.ts) — so inlining it is safe.
  const frontSvg = useMemo(() => ({ __html: cardArtSvg(art, { ...units, part: "front" }) }), [art, units]);
  const backSvg = useMemo(() => (flippable ? { __html: cardArtSvg(art, { ...units, part: "back" }) } : null), [art, units, flippable]);

  const front = artLayout(W, H);
  const back = backLayout(W, H);

  // --- Tilt: CSS variables on the scene, so a pointer move never re-renders. ---------------
  const tilt = (x: number, y: number) => {
    const el = sceneRef.current;
    if (!el) return;
    el.style.setProperty("--tilt-x", clamp(x).toFixed(3));
    el.style.setProperty("--tilt-y", clamp(y).toFixed(3));
  };
  const orienting = useRef(false);
  const asked = useRef(false);
  const dragging = useRef(false);
  const onOrientation = useRef<((e: DeviceOrientationEvent) => void) | null>(null);

  useEffect(() => {
    if (reduced || typeof DeviceOrientationEvent === "undefined") return;
    let base: number | null = null;
    const handler = (e: DeviceOrientationEvent) => {
      if (e.beta == null || e.gamma == null) return;
      // However the phone is held when it starts is level.
      base ??= e.beta;
      orienting.current = true;
      tilt((e.beta - base) / 20, e.gamma / 20);
    };
    onOrientation.current = handler;
    // iOS needs a tap first (see `askForOrientation`); everywhere else it simply starts.
    if (typeof (DeviceOrientationEvent as OrientationCtor).requestPermission !== "function") {
      window.addEventListener("deviceorientation", handler);
    }
    return () => {
      window.removeEventListener("deviceorientation", handler);
      onOrientation.current = null;
      orienting.current = false;
      tilt(0, 0);
    };
  }, [reduced]);

  // A touch's pointerup carries the user activation iOS's permission prompt needs.
  const askForOrientation = (e: PointerEvent) => {
    dragging.current = false;
    if (e.pointerType !== "mouse" && !orienting.current) tilt(0, 0);
    const ask = typeof DeviceOrientationEvent === "undefined" ? undefined : (DeviceOrientationEvent as OrientationCtor).requestPermission;
    if (reduced || asked.current || e.pointerType === "mouse" || typeof ask !== "function") return;
    asked.current = true;
    ask.call(DeviceOrientationEvent)
      .then((answer) => {
        if (answer === "granted" && onOrientation.current) window.addEventListener("deviceorientation", onOrientation.current);
      })
      // Refused or unavailable: dragging tilts it instead.
      .catch(() => undefined);
  };

  const follow = (e: PointerEvent) => {
    if (reduced) return;
    if (e.pointerType !== "mouse" && (!dragging.current || orienting.current)) return;
    const r = e.currentTarget.getBoundingClientRect();
    tilt(((e.clientY - r.top) / r.height) * 2 - 1, ((e.clientX - r.left) / r.width) * 2 - 1);
  };

  const shortSide = SHORT_SIDE[orientation];
  const ink = ACCENTS[art.accent].ink;
  const sheen = (
    <span
      aria-hidden
      className="pointer-events-none absolute -inset-1/2 block mix-blend-screen transition-[translate,rotate] duration-150 ease-out"
      style={{
        // ONE silver band, never a rainbow; it slides and turns with the tilt.
        background:
          "linear-gradient(105deg, transparent 38%, rgba(232,238,245,0) 42%, rgba(232,238,245,0.38) 50%, rgba(232,238,245,0) 58%, transparent 62%)",
        translate: "calc(var(--tilt-y, 0) * 22% - 6%) calc(var(--tilt-x, 0) * 10%)",
        rotate: "calc(var(--tilt-x, 0) * 8deg)",
      }}
    />
  );
  const face = "absolute inset-0 block overflow-hidden rounded-[calc(var(--s)*0.06)] backface-hidden";
  const artLayer = "absolute inset-0 block [&>svg]:block [&>svg]:size-full";

  const card = (
    <span
      className="relative block size-full transform-3d transition-transform duration-700 ease-[var(--ease-house)]"
      style={{ transform: flipped ? "rotateY(180deg)" : undefined }}
    >
      <span className={face} aria-hidden={flipped || undefined}>
        <span className={artLayer} dangerouslySetInnerHTML={frontSvg} />
        <span
          className="absolute flex flex-col items-start"
          style={{ left: pct(front.inset + 0.08 * front.s, W), right: pct(front.inset + 0.2 * front.s, W), bottom: pct(front.inset + 0.08 * front.s, H) }}
        >
          <Name className="line-clamp-2 bg-[linear-gradient(100deg,#f6e7b8_0%,#d4b469_45%,#fff3cf_72%,#d4b469_100%)] bg-clip-text pb-[0.06em] font-[family-name:var(--font-display)] text-[length:calc(var(--s)*0.12)] leading-[1.08] tracking-[-0.01em] text-transparent forced-colors:bg-none forced-colors:text-[CanvasText]">
            {name}
          </Name>
          {role && (
            <span className="mt-[calc(var(--s)*0.015)] block max-w-full truncate text-[length:calc(var(--s)*0.058)] text-[#cfd8dc]">
              {role}
            </span>
          )}
        </span>
        <span
          aria-hidden
          className="absolute font-medium text-[length:calc(var(--s)*0.036)] tracking-[0.42em] text-white/55"
          style={{ right: pct(front.inset + 0.06 * front.s, W), bottom: pct(front.inset + 0.07 * front.s, H) }}
        >
          ORBIT
        </span>
        {sheen}
      </span>

      {flippable && backSvg && (
        <span className={cn(face, "[transform:rotateY(180deg)]")} aria-hidden={!flipped || undefined}>
          <span className={artLayer} dangerouslySetInnerHTML={backSvg} />
          <span
            role="img"
            aria-label={`QR code for ${firstName}’s card`}
            className="absolute block p-[2.5%] [&>svg]:block [&>svg]:size-full"
            style={{
              left: pct(back.cx - back.tile / 2, W),
              top: pct(back.cy - back.tile / 2, H),
              width: pct(back.tile, W),
              height: pct(back.tile, H),
              color: ink,
            }}
            // The QR SVG is the server's own `qrcode` output for the card's URL.
            dangerouslySetInnerHTML={{ __html: qrSvg! }}
          />
          <span
            className="absolute inset-x-0 block px-[8%] text-center text-[length:calc(var(--s)*0.055)] text-[#cfd8dc]"
            style={{ bottom: pct(0.04 * back.s + 0.06 * back.s, H) }}
          >
            Scan to save {firstName}’s contact
          </span>
          {sheen}
        </span>
      )}
    </span>
  );

  return (
    <div
      ref={sceneRef}
      className={cn("relative w-full touch-pan-y select-none perspective-[1200px] [container-type:inline-size]", className)}
      style={{ "--s": shortSide } as CSSProperties}
      onPointerMove={follow}
      onPointerDown={(e) => {
        if (e.pointerType !== "mouse") dragging.current = true;
      }}
      onPointerUp={askForOrientation}
      onPointerCancel={() => {
        dragging.current = false;
      }}
      onPointerLeave={(e) => {
        if (e.pointerType === "mouse") tilt(0, 0);
      }}
    >
      <div
        className={cn(
          "relative w-full transition-transform duration-150 ease-out transform-3d",
          orientation === "landscape" ? "aspect-[1.586/1]" : "aspect-[1/1.586]",
          entrance && "oc-enter"
        )}
        style={{ transform: "rotateX(calc(var(--tilt-x, 0) * -9deg)) rotateY(calc(var(--tilt-y, 0) * 12deg))" }}
      >
        <span className="absolute inset-0 block rounded-[calc(var(--s)*0.06)] shadow-[0_28px_60px_-24px_rgba(0,0,0,0.75)]" aria-hidden />
        {flippable ? (
          <button
            type="button"
            onClick={() => setFlipped((f) => !f)}
            aria-label={flipped ? `Show ${firstName}’s name side` : "Show the QR code"}
            className="absolute inset-0 block cursor-pointer rounded-[calc(var(--s)*0.06)] outline-none focus-visible:ring-3 focus-visible:ring-[#d4b469]/70"
          >
            {card}
          </button>
        ) : (
          <div className="absolute inset-0">{card}</div>
        )}
      </div>
    </div>
  );
}
