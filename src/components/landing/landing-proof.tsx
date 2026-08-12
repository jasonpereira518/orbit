export function LandingProof() {
  return (
    <section className="landing-reveal relative z-10 mx-auto w-full max-w-6xl border-t border-[#e8f3f1]/[0.07] px-6 py-20 md:px-10 md:py-24">
      <p className="text-xs uppercase tracking-[0.18em] text-[#6d807c]">Why it exists</p>

      <div className="mt-10 grid items-center gap-10 lg:grid-cols-2">
        <div>
          <p className="max-w-[22ch] font-[family-name:var(--font-display)] text-[clamp(26px,3.6vw,40px)] font-light leading-[1.3] text-[#e8f3f1]">
            I kept meeting people who could have helped — and losing track before it mattered.
          </p>
          <p className="mt-6 max-w-[46ch] text-base leading-[1.75] text-[#9aada8]">
            Job searching means a lot of conversations in a short window:
            referrals, informational interviews, recruiters. I kept having good
            ones and then letting them go cold. Orbit is the system I built so
            that doesn&apos;t happen — to me, or to you.
          </p>
          <div className="mt-7 flex items-center gap-3">
            <span className="h-[34px] w-[34px] shrink-0 rounded-full bg-[#e8f3f1]/15" />
            <div className="min-w-max">
              <p className="text-sm text-[#e8f3f1]">Jason Pereira</p>
              <p className="whitespace-nowrap text-xs text-[#6d807c]">Building Orbit solo</p>
            </div>
          </div>
        </div>

        <div className="landing-glass rounded-3xl p-8 sm:p-10">
          <p className="font-[family-name:var(--font-display)] text-[clamp(52px,8vw,80px)] font-light leading-none text-landing-accent">
            2.4×
          </p>
          <p className="mt-4 text-base leading-[1.7] text-[#e8f3f1]">
            reply rate on outreach sent through Orbit versus the same lists sent manually.
          </p>
        </div>
      </div>
    </section>
  );
}
