import { LandingAuthControls } from "@/components/landing/landing-auth-controls";

export function LandingPricingCta({
  clerkOn,
  demoMode = false,
}: {
  clerkOn: boolean;
  demoMode?: boolean;
}) {
  return (
    <section className="relative z-10 px-6 py-20 md:px-10 md:py-28">
      <div className="mx-auto max-w-3xl text-center">
        <p className="text-sm font-medium uppercase tracking-wide text-[#6d807c]">
          Pricing
        </p>
        <h2 className="mt-3 font-[family-name:var(--font-display)] text-3xl leading-tight tracking-tight text-[#e8f3f1] sm:text-4xl">
          Free to start. No setup required.
        </h2>
        <p className="mt-4 text-base leading-relaxed text-[#9aada8] sm:text-lg">
          Keep every connection in orbit.
        </p>
        <div className="mt-8 flex justify-center">
          <LandingAuthControls
            clerkOn={clerkOn}
            demoMode={demoMode}
            variant="hero"
            showUserButton={false}
          />
        </div>
      </div>
    </section>
  );
}
