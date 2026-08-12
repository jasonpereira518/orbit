// src/components/landing/landing-proof.tsx
export function LandingProof() {
  return (
    <section className="relative z-10 px-6 py-20 md:px-10 md:py-28">
      <div className="mx-auto max-w-3xl text-center">
        <p className="font-[family-name:var(--font-display)] text-2xl leading-snug tracking-tight text-[#e8f3f1] sm:text-3xl">
          Built by one person who was tired of losing track of people.
        </p>
        <p className="mt-4 text-base leading-relaxed text-[#9aada8] sm:text-lg">
          No sales team, no growth hacks — just a tool built to solve a real
          problem, refined by using it every day.
        </p>
        {/*
          [CONFIRM] If a real reply-rate or usage stat exists, replace the
          paragraph above (or add beneath it) with something like:
          "Orbit users see a {X}% higher reply rate on outreach." Do not
          ship a number here without the user confirming it's real.
        */}
      </div>
    </section>
  );
}
