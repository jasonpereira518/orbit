const FEATURES = [
  {
    kicker: "01 — Automatic",
    title: "Unified contacts",
    body: "LinkedIn and Apollo enrichment merge into a single contact record. Titles, employers and emails arrive already filled in — there is no form for you to keep feeding.",
  },
  {
    kicker: "02 — Assembled for you",
    title: "Targeted outreach",
    body: "Name an employer and Orbit builds the list. Demo results while you explore, live Apollo results the moment you're ready to send.",
  },
  {
    kicker: "03 — Learned over time",
    title: "Reply-rate optimization",
    body: "Orbit reads what comes back and surfaces what's working, so the next message is shorter, better aimed, and one of fewer.",
  },
] as const;

function ContactsVisual() {
  return (
    <div className="relative h-[200px] w-full" aria-hidden="true">
      <div className="absolute left-0 top-3.5 w-[154px] -rotate-6 rounded-2xl border border-[#e8f3f1]/10 bg-[#05070f]/70 px-3.5 py-3">
        <p className="text-[11px] uppercase tracking-wide text-[#6d807c]">LinkedIn</p>
        <p className="mt-1.5 text-sm text-[#e8f3f1]">Priya Raman</p>
        <p className="text-xs text-[#9aada8]">Head of Growth</p>
      </div>
      <div className="absolute left-11 top-[104px] w-[154px] rotate-3 rounded-2xl border border-[#e8f3f1]/10 bg-[#05070f]/70 px-3.5 py-3">
        <p className="text-[11px] uppercase tracking-wide text-[#6d807c]">Apollo</p>
        <p className="mt-1.5 text-sm text-[#e8f3f1]">priya@northwind.io</p>
        <p className="text-xs text-[#9aada8]">Northwind · 240 emp.</p>
      </div>
      <div className="absolute right-0 top-11 w-[190px] rounded-2xl border border-[#f2c14e]/35 bg-[#f2c14e]/[0.07] p-4 shadow-[0_0_40px_rgba(242,193,78,0.14)]">
        <div className="h-[30px] w-[30px] rounded-full bg-[#e8f3f1]/15" />
        <p className="mt-2 text-sm text-[#e8f3f1]">Priya Raman</p>
        <p className="text-xs text-[#9aada8]">Northwind</p>
        <p className="mt-2 text-[11px] uppercase tracking-wide text-landing-accent">One record</p>
      </div>
    </div>
  );
}

function OutreachVisual() {
  return (
    <div className="w-full" aria-hidden="true">
      <div className="flex items-center gap-2.5 rounded-xl border border-[#e8f3f1]/[0.12] bg-[#05070f]/60 px-4 py-3">
        <span className="h-3.5 w-3.5 shrink-0 rounded-full border border-[#9aada8]" />
        <p className="text-sm">
          <span className="text-[#9aada8]">employer: </span>
          <span className="text-[#e8f3f1]">Northwind</span>
        </p>
        <span className="ml-auto rounded-full border border-[#f2c14e]/40 px-2 py-0.5 text-[11px] text-landing-accent">
          Live
        </span>
      </div>
      <div className="mt-3 space-y-2.5">
        {[100, 100, 50].map((opacity, i) => (
          <div
            key={i}
            className="flex items-center gap-3 rounded-xl bg-[#e8f3f1]/[0.035] px-3.5 py-3"
            style={{ opacity: opacity / 100 }}
          >
            <span className="h-6 w-6 shrink-0 rounded-full bg-[#e8f3f1]/10" />
            <div className="flex-1 space-y-1.5">
              <div className="h-2 rounded-full bg-[#e8f3f1]/10" style={{ width: "50%" }} />
              <div className="h-2 rounded-full bg-[#e8f3f1]/10" style={{ width: "38%" }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ReplyRateVisual() {
  const bars = [
    { h: 26, color: "rgba(232,243,241,0.12)" },
    { h: 38, color: "rgba(232,243,241,0.14)" },
    { h: 34, color: "rgba(232,243,241,0.12)" },
    { h: 56, color: "rgba(242,193,78,0.30)" },
    { h: 72, color: "rgba(242,193,78,0.45)" },
    { h: 96, color: "#f2c14e" },
  ];
  return (
    <div className="flex h-[170px] w-full items-end gap-2.5" aria-hidden="true">
      {bars.map((bar, i) => (
        <div
          key={i}
          className="flex-1 rounded-t-lg rounded-b-[3px]"
          style={{
            height: `${bar.h}%`,
            background: bar.color,
            boxShadow: i === bars.length - 1 ? "0 0 30px rgba(242,193,78,0.35)" : undefined,
          }}
        />
      ))}
    </div>
  );
}

const VISUALS = [ContactsVisual, OutreachVisual, ReplyRateVisual];

export function LandingFeatures() {
  return (
    <section className="landing-reveal relative z-10 mx-auto w-full max-w-6xl border-t border-[#e8f3f1]/[0.07] px-6 py-20 md:px-10 md:py-24">
      <p className="text-xs uppercase tracking-[0.18em] text-[#6d807c]">What Orbit does</p>
      <h2 className="mt-3 max-w-[16ch] font-[family-name:var(--font-display)] text-[clamp(30px,4.4vw,50px)] font-normal leading-[1.15] tracking-[-0.025em] text-[#e8f3f1]">
        It keeps itself up to date.
      </h2>

      <div className="mt-12 flex flex-col gap-7">
        {FEATURES.map((feature, index) => {
          const Visual = VISUALS[index];
          const reversed = index === 1;
          return (
            <div
              key={feature.title}
              className="landing-glass grid items-center gap-9 rounded-3xl p-7 sm:p-10 lg:grid-cols-2"
            >
              <div className={reversed ? "lg:order-2" : undefined}>
                <p className="text-xs uppercase tracking-[0.16em] text-landing-accent">{feature.kicker}</p>
                <h3 className="mt-3 font-[family-name:var(--font-display)] text-[clamp(24px,2.8vw,32px)] font-normal tracking-tight text-[#e8f3f1]">
                  {feature.title}
                </h3>
                <p className="mt-3 max-w-[44ch] text-base leading-[1.7] text-[#9aada8]">{feature.body}</p>
              </div>
              <div className={reversed ? "lg:order-1" : undefined}>
                <Visual />
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
