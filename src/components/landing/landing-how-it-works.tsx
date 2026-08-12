"use client";

import { useEffect, useRef } from "react";

const STEPS = [
  {
    kicker: "Step 01 · you",
    title: "Connect",
    body: "Link LinkedIn and Apollo once.",
    dot: "#e8f3f1",
    glow: "0 0 20px rgba(232,243,241,.7)",
  },
  {
    kicker: "Step 02 · automatic",
    title: "Contacts populate",
    body: "Records fill in and enrich themselves.",
    dot: "#f2c14e",
    glow: "none",
  },
  {
    kicker: "Step 03 · you",
    title: "Send outreach",
    body: "Target by employer, send from Orbit.",
    dot: "#f2c14e",
    glow: "none",
  },
  {
    kicker: "Step 04 · automatic",
    title: "Replies come back",
    body: "Orbit tracks them and resurfaces who's due.",
    dot: "#9aada8",
    glow: "none",
  },
] as const;

// 12 / 3 / 6 / 9 o'clock, matching STEPS in order.
const NODE_POSITIONS = [
  { top: "0%", left: "50%" },
  { top: "50%", left: "100%" },
  { top: "100%", left: "50%" },
  { top: "50%", left: "0%" },
] as const;

function prefersReducedMotion() {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function LandingHowItWorks() {
  const ringRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (prefersReducedMotion()) return;

    const ring = ringRef.current;
    if (!ring) return;

    let raf = 0;

    function onScroll() {
      raf = requestAnimationFrame(() => {
        const rect = ring!.getBoundingClientRect();
        const p =
          (window.innerHeight - rect.top) / (window.innerHeight + rect.height);
        const clamped = Math.min(Math.max(p, 0), 1);
        const rotation = clamped * 34 - 17;
        ring!.style.setProperty("--ring-rotation", String(rotation));
      });
    }

    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <section className="landing-reveal relative z-10 mx-auto w-full max-w-6xl border-t border-[#e8f3f1]/[0.07] px-6 py-20 md:px-10 md:py-24">
      <p className="text-xs uppercase tracking-[0.18em] text-[#6d807c]">How it works</p>
      <h2 className="mt-3 max-w-[18ch] font-[family-name:var(--font-display)] text-[clamp(30px,4.4vw,50px)] font-normal leading-[1.15] tracking-[-0.025em] text-[#e8f3f1]">
        Four steps, three of which run without you.
      </h2>

      <div
        ref={ringRef}
        className="relative mx-auto mt-16 hidden aspect-square w-full max-w-[760px] lg:block"
        style={{
          transform: "rotate(calc(var(--ring-rotation, 0) * 1deg))",
          transition: "transform .18s linear",
        }}
      >
        <div
          aria-hidden="true"
          className="absolute inset-[6%] rounded-full border border-dashed border-[#e8f3f1]/[0.13]"
        />
        <div
          aria-hidden="true"
          className="absolute inset-[24%] rounded-full border border-[#e8f3f1]/[0.07]"
        />
        <div
          aria-hidden="true"
          className="absolute inset-[34%] rounded-full"
          style={{ background: "radial-gradient(circle, rgba(242,193,78,.16), transparent 70%)" }}
        />

        <div
          aria-hidden="true"
          className="absolute left-1/2 top-1/2 h-[78px] w-[78px] -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{
            background:
              "radial-gradient(circle at 46% 42%, #fffdf2 6%, #ffe89a 34%, #f5c451 62%, #eba92c 100%)",
            boxShadow: "0 0 60px 14px rgba(245,196,81,0.35)",
          }}
        />
        <div
          data-counter-rotate
          className="absolute left-1/2 top-1/2 mt-14 -translate-x-1/2 translate-y-1/2 text-center"
          style={{ transform: "translate(-50%, 55px) rotate(calc(var(--ring-rotation, 0) * -1deg))" }}
        >
          <p className="font-[family-name:var(--font-display)] text-[19px] text-[#e8f3f1]">Orbit</p>
          <p className="text-xs text-[#6d807c]">the record keeps itself</p>
        </div>

        {STEPS.map((step, index) => (
          <div
            key={step.title}
            data-counter-rotate
            className="absolute w-[42%] max-w-[230px] text-center"
            style={{
              top: NODE_POSITIONS[index].top,
              left: NODE_POSITIONS[index].left,
              transform: "translate(-50%, -50%) rotate(calc(var(--ring-rotation, 0) * -1deg))",
            }}
          >
            <span
              aria-hidden="true"
              className="mx-auto block h-3 w-3 rounded-full"
              style={{ background: step.dot, boxShadow: step.glow }}
            />
            <p className="mt-2 text-[11px] uppercase tracking-[0.16em] text-[#6d807c]">{step.kicker}</p>
            <p className="mt-1 font-[family-name:var(--font-display)] text-[19px] text-[#e8f3f1]">{step.title}</p>
            <p className="mt-1 text-[13px] leading-[1.6] text-[#9aada8]">{step.body}</p>
          </div>
        ))}
      </div>

      <ol className="mt-12 space-y-6 lg:hidden">
        {STEPS.map((step) => (
          <li key={step.title} className="flex gap-4">
            <span
              aria-hidden="true"
              className="mt-1.5 h-3 w-3 shrink-0 rounded-full"
              style={{ background: step.dot, boxShadow: step.glow }}
            />
            <div>
              <p className="text-[11px] uppercase tracking-[0.16em] text-[#6d807c]">{step.kicker}</p>
              <p className="mt-1 font-[family-name:var(--font-display)] text-[19px] text-[#e8f3f1]">
                {step.title}
              </p>
              <p className="mt-1 text-[13px] leading-[1.6] text-[#9aada8]">{step.body}</p>
            </div>
          </li>
        ))}
      </ol>

      <p className="mt-8 text-center text-sm text-[#6d807c]">
        The loop keeps running whether or not you open the app.
      </p>
    </section>
  );
}
