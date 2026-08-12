const FEATURES = [
  {
    title: "Unified contacts",
    body: "LinkedIn and Apollo enrichment merge into one contact record automatically — no manual data entry.",
  },
  {
    title: "Targeted outreach",
    body: "Search and target by employer, with demo vs. live Apollo results.",
  },
  {
    title: "Reply-rate optimization",
    body: "Orbit surfaces what's working in your outreach, so you send fewer, better messages.",
  },
] as const;

export function LandingFeatures() {
  return (
    <section className="relative z-10 px-6 py-20 md:px-10 md:py-28">
      <div className="mx-auto max-w-6xl">
        <h2 className="font-[family-name:var(--font-display)] max-w-xl text-3xl leading-tight tracking-tight text-[#e8f3f1] sm:text-4xl">
          Effortless, by design.
        </h2>
        <p className="mt-3 max-w-lg text-base leading-relaxed text-[#9aada8] sm:text-lg">
          Orbit does the upkeep so you don&apos;t have to.
        </p>

        <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((feature) => (
            <div
              key={feature.title}
              className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 backdrop-blur-sm transition-colors hover:border-white/20"
            >
              <h3 className="font-[family-name:var(--font-display)] text-lg tracking-tight text-[#e8f3f1]">
                {feature.title}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-[#9aada8]">
                {feature.body}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
