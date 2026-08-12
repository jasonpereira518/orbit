const STEPS = [
  { title: "Connect", body: "Link your LinkedIn — Orbit reads your existing network." },
  { title: "Enrich", body: "Contacts populate and enrich automatically from LinkedIn and Apollo." },
  { title: "Reach out", body: "Send targeted outreach, filtered by employer." },
  { title: "Follow up", body: "Orbit tracks replies and resurfaces who needs a follow-up." },
] as const;

// Node positions around a circle of radius 42% centered at (50%, 50%),
// at 90°/0°/270°/180° (top, right, bottom, left).
const NODE_POSITIONS = [
  { top: "8%", left: "50%" },
  { top: "50%", left: "92%" },
  { top: "92%", left: "50%" },
  { top: "50%", left: "8%" },
] as const;

export function LandingHowItWorks() {
  return (
    <section className="relative z-10 px-6 py-20 md:px-10 md:py-28">
      <div className="mx-auto max-w-6xl">
        <h2 className="font-[family-name:var(--font-display)] max-w-xl text-3xl leading-tight tracking-tight text-[#e8f3f1] sm:text-4xl">
          How it works
        </h2>

        {/* Circular orbit layout — lg and up */}
        <div className="relative mx-auto mt-16 hidden aspect-square max-w-xl lg:block">
          <svg
            viewBox="0 0 100 100"
            className="absolute inset-0 h-full w-full text-white/10"
            aria-hidden="true"
          >
            <circle cx="50" cy="50" r="42" fill="none" stroke="currentColor" strokeWidth="0.5" />
          </svg>

          <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-center">
            <p className="font-[family-name:var(--font-display)] text-2xl tracking-tight text-[#e8f3f1]">
              Orbit
            </p>
          </div>

          {STEPS.map((step, index) => (
            <div
              key={step.title}
              className="absolute w-48 -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-white/10 bg-[#05070f]/90 p-4 text-center backdrop-blur-sm"
              style={{ top: NODE_POSITIONS[index].top, left: NODE_POSITIONS[index].left }}
            >
              <p className="text-xs font-medium uppercase tracking-wide text-[#6d807c]">
                {String(index + 1).padStart(2, "0")}
              </p>
              <p className="mt-1 font-[family-name:var(--font-display)] text-base text-[#e8f3f1]">
                {step.title}
              </p>
              <p className="mt-1 text-xs leading-relaxed text-[#9aada8]">{step.body}</p>
            </div>
          ))}
        </div>

        {/* Vertical stack — below lg */}
        <ol className="mt-12 space-y-6 lg:hidden">
          {STEPS.map((step, index) => (
            <li key={step.title} className="flex gap-4">
              <span className="font-[family-name:var(--font-display)] text-lg text-[#6d807c]">
                {String(index + 1).padStart(2, "0")}
              </span>
              <div>
                <p className="font-[family-name:var(--font-display)] text-lg text-[#e8f3f1]">
                  {step.title}
                </p>
                <p className="mt-1 text-sm leading-relaxed text-[#9aada8]">{step.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
