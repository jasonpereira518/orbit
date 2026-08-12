import { WaitlistForm } from "@/components/landing/waitlist-form";

export function LandingWaitlist({
  clerkOn,
  demoMode = false,
}: {
  clerkOn: boolean;
  demoMode?: boolean;
}) {
  return (
    <section className="landing-reveal relative z-10 mx-auto w-full max-w-6xl overflow-x-hidden border-t border-[#e8f3f1]/[0.07] px-6 py-20 md:px-10 md:py-24">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute bottom-[-420px] left-1/2 z-[-1] h-[900px] w-[900px] -translate-x-1/2 rounded-full"
        style={{ background: "radial-gradient(circle, rgba(242,193,78,0.14), transparent 62%)" }}
      />

      <div className="relative grid items-center gap-11 lg:grid-cols-2">
        <div>
          <h2 className="max-w-[14ch] font-[family-name:var(--font-display)] text-[clamp(34px,5.2vw,58px)] font-normal leading-[1.1] tracking-[-0.03em] text-[#e8f3f1]">
            Get in before everyone else.
          </h2>
          <p className="mt-5 max-w-[40ch] text-base leading-[1.7] text-[#9aada8] sm:text-lg">
            Early access is free. There is nothing to import and nothing to maintain.
          </p>
        </div>

        <div className="landing-glass rounded-3xl p-8">
          <p className="text-xs uppercase tracking-[0.16em] text-landing-accent">Waitlist</p>
          <p className="mt-2 text-base text-[#e8f3f1]">Join and you&apos;ll get in as spots open.</p>
          <div className="mt-5">
            <WaitlistForm clerkOn={clerkOn} demoMode={demoMode} />
          </div>
          <p className="mt-4 text-xs text-[#6d807c]">No credit card. No setup.</p>
        </div>
      </div>
    </section>
  );
}
