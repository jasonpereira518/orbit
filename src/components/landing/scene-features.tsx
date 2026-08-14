import { BookOpen, LayoutDashboard, Send } from "lucide-react";
import { Reveal } from "@/components/motion/reveal";
import { cn } from "@/lib/utils";

// The toolkit scene: every app feature, told in the narrative's voice.
// Five alternating .landing-glass cards each pair copy with a small
// pure-CSS/JSX preview (aria-hidden — decorative, never a full app
// mockup), then a chip strip covers the remaining nav features.

const KICKER = "text-xs uppercase tracking-[0.16em] text-[#c4a35a]";
const CARD_TITLE =
  "mt-3 font-[family-name:var(--font-display)] text-2xl leading-snug tracking-tight text-[#e8f3f1] md:text-3xl";
const CARD_BODY = "mt-3 max-w-md text-base leading-relaxed text-[#9aada8]";

function ContactsVisual() {
  return (
    <div className="relative h-[195px] w-full lg:h-[200px]" aria-hidden>
      <div className="absolute left-0 top-0 w-[118px] -rotate-6 rounded-2xl border border-[#e8f3f1]/10 bg-[#05070f]/70 px-2.5 py-2 lg:top-3.5 lg:w-[154px] lg:px-3.5 lg:py-3">
        <p className="text-[10px] uppercase tracking-wide text-[#6d807c] lg:text-[11px]">LinkedIn</p>
        <p className="mt-1.5 text-xs text-[#e8f3f1] lg:text-sm">Priya Raman</p>
        <p className="text-[11px] text-[#9aada8] lg:text-xs">Head of Growth</p>
      </div>
      <div className="absolute left-7 top-[98px] w-[118px] rotate-3 rounded-2xl border border-[#e8f3f1]/10 bg-[#05070f]/70 px-2.5 py-2 lg:left-11 lg:top-[104px] lg:w-[154px] lg:px-3.5 lg:py-3">
        <p className="text-[10px] uppercase tracking-wide text-[#6d807c] lg:text-[11px]">Gmail</p>
        <p className="mt-1.5 text-xs text-[#e8f3f1] lg:text-sm">priya@northwind.io</p>
        <p className="text-[11px] text-[#9aada8] lg:text-xs">Northwind · last week</p>
      </div>
      <div className="absolute right-0 top-12 w-[136px] rounded-2xl border border-[#c4a35a]/35 bg-[#c4a35a]/[0.07] p-3 shadow-[0_0_40px_rgba(196,163,90,0.14)] lg:top-11 lg:w-[190px] lg:p-4">
        <div className="h-[24px] w-[24px] rounded-full bg-[#e8f3f1]/15 lg:h-[30px] lg:w-[30px]" />
        <p className="mt-2 text-xs text-[#e8f3f1] lg:text-sm">Priya Raman</p>
        <p className="text-[11px] text-[#9aada8] lg:text-xs">Northwind</p>
        <p className="mt-2 text-[10px] uppercase tracking-wide text-[#c4a35a] lg:text-[11px]">One record</p>
      </div>
    </div>
  );
}

function ConstellationVisual() {
  const stars: Array<[number, number, number]> = [
    [28, 96, 2.6],
    [62, 58, 2.2],
    [104, 76, 3.4],
    [142, 40, 2.4],
    [168, 88, 2.8],
    [122, 116, 2.0],
  ];
  const chains = [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 4],
    [2, 5],
  ];
  return (
    <div className="relative mx-auto w-full max-w-[320px]" aria-hidden>
      <svg viewBox="0 0 200 150" className="h-auto w-full">
        {chains.map(([a, b], i) => (
          <line
            key={i}
            x1={stars[a]![0]}
            y1={stars[a]![1]}
            x2={stars[b]![0]}
            y2={stars[b]![1]}
            stroke="rgba(89,157,231,0.55)"
            strokeWidth={1.1}
            strokeLinecap="round"
          />
        ))}
        {stars.map(([x, y, r], i) => (
          <circle key={i} cx={x} cy={y} r={r} fill="#c5d4d1" />
        ))}
      </svg>
      <span className="absolute bottom-0 left-1/2 -translate-x-1/2 rounded-full bg-[#05070f]/70 px-2.5 py-1 text-[10px] uppercase tracking-[0.2em] text-[#c4a35a]">
        Northwind · 6 people
      </span>
    </div>
  );
}

function RemindersVisual() {
  return (
    <div className="w-full max-w-[340px]" aria-hidden>
      <p className="text-[10px] uppercase tracking-[0.16em] text-[#6d807c]">Today</p>
      <div className="mt-2 space-y-2">
        <div className="flex items-center gap-3 rounded-xl border border-[#e8f3f1]/10 bg-[#05070f]/60 px-3.5 py-2.5">
          <span className="h-6 w-6 shrink-0 rounded-full bg-[#0f3d3e] text-center text-[10px] leading-6 text-[#e8f3f1]">
            SC
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs text-[#e8f3f1]">Sarah Chen</p>
            <p className="text-[10px] text-[#9aada8]">Monthly check-in</p>
          </div>
          <span className="shrink-0 rounded-full bg-[#c4a35a]/15 px-2 py-0.5 text-[10px] text-[#c4a35a]">
            Due
          </span>
        </div>
        <div className="flex items-center gap-3 rounded-xl border border-[#e8f3f1]/10 bg-[#05070f]/60 px-3.5 py-2.5">
          <span className="h-6 w-6 shrink-0 rounded-full bg-[#2d3a48] text-center text-[10px] leading-6 text-[#e8f3f1]">
            MW
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs text-[#e8f3f1]">Marcus Webb</p>
            <p className="text-[10px] text-[#9aada8]">3 weeks quiet</p>
          </div>
          <span className="shrink-0 rounded-full bg-[#ff6b4a]/15 px-2 py-0.5 text-[10px] text-[#ff6b4a]">
            Drifting
          </span>
        </div>
        <div className="flex items-center gap-3 rounded-xl bg-[#e8f3f1]/[0.035] px-3.5 py-2.5 opacity-50">
          <span className="h-6 w-6 shrink-0 rounded-full bg-[#e8f3f1]/10" />
          <div className="flex-1 space-y-1.5">
            <div className="h-2 w-1/2 rounded-full bg-[#e8f3f1]/10" />
            <div className="h-2 w-1/3 rounded-full bg-[#e8f3f1]/10" />
          </div>
        </div>
      </div>
    </div>
  );
}

function AskVisual() {
  return (
    <div className="w-full max-w-[340px] space-y-3" aria-hidden>
      <div className="flex items-center gap-3 rounded-2xl border border-[#e8f3f1]/[0.14] bg-[#05070f]/60 px-4 py-3">
        <p className="flex-1 text-sm text-[#e8f3f1]">Who do I know at Stripe?</p>
        <span className="h-6 w-6 shrink-0 rounded-full bg-[#c4a35a]/25" />
      </div>
      <div className="ml-6 flex items-center gap-2.5 rounded-2xl bg-[#e8f3f1]/[0.05] px-4 py-3">
        <span className="h-5 w-5 rounded-full bg-[#599de7]/40" />
        <span className="-ml-4 h-5 w-5 rounded-full bg-[#c4a35a]/40" />
        <p className="text-xs text-[#9aada8]">
          Two people — Elena via AWS, Tom from your MIT cluster.
        </p>
      </div>
    </div>
  );
}

function ImportsVisual() {
  return (
    <div className="w-full max-w-[340px]" aria-hidden>
      <div className="flex flex-wrap gap-2">
        {["LinkedIn", "Gmail", "Calendar"].map((src) => (
          <span
            key={src}
            className="flex items-center gap-1.5 rounded-full border border-[#e8f3f1]/[0.14] px-3 py-1 text-[11px] text-[#9aada8]"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-[#c4a35a]" />
            {src}
          </span>
        ))}
      </div>
      <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-[#e8f3f1]/10">
        <div className="h-full w-[70%] rounded-full bg-[#c4a35a]/70" />
      </div>
      <p className="mt-2 text-xs text-[#9aada8]">
        <span className="text-[#e8f3f1]">114 contacts</span> and counting
      </p>
    </div>
  );
}

const FEATURES = [
  {
    kicker: "Contacts",
    title: "Every person, one living record.",
    body: "Notes, last conversations, and where you met — LinkedIn scraps and email threads merge into a single page per person.",
    visual: <ContactsVisual />,
  },
  {
    kicker: "Constellation",
    title: "See your network as a sky.",
    body: "Your people cluster into constellations by company, school, and old team — one glance shows the shape of your world.",
    visual: <ConstellationVisual />,
  },
  {
    kicker: "Reminders",
    title: "A cadence for everyone who matters.",
    body: "Set how often you want to show up. Orbit queues the nudges, so staying close stops depending on memory.",
    visual: <RemindersVisual />,
  },
  {
    kicker: "Capture + Chat",
    title: "Jot it down, ask anything later.",
    body: "Type a quick note after a call and Orbit files it — then ask your network questions in plain language when you need a name.",
    visual: <AskVisual />,
  },
  {
    kicker: "Imports",
    title: "Everyone flows in from where they already are.",
    body: "LinkedIn connections, Gmail threads, calendar invites — bring them in once and Orbit keeps the records fresh.",
    visual: <ImportsVisual />,
  },
];

const ALSO_IN_ORBIT = [
  { label: "Dashboard", Icon: LayoutDashboard },
  { label: "Outreach", Icon: Send },
  { label: "Knowledge", Icon: BookOpen },
];

export function SceneFeatures() {
  return (
    <section
      aria-labelledby="landing-features"
      className="landing-scene relative z-10 px-6 py-24 md:px-10"
      style={{ "--scene-size": "1900px" } as React.CSSProperties}
    >
      <div className="mx-auto w-full max-w-6xl">
        <div className="max-w-xl">
          <Reveal className="reveal-celestial">
            <p className={KICKER}>The toolkit</p>
          </Reveal>
          <Reveal className="reveal-celestial" delay={80}>
            <h2
              id="landing-features"
              className="mt-3 font-[family-name:var(--font-display)] text-[clamp(30px,4.4vw,50px)] font-normal leading-[1.15] tracking-[-0.025em] text-[#e8f3f1]"
            >
              Everything your network needs, in one place.
            </h2>
          </Reveal>
        </div>

        <div className="mt-12 space-y-6">
          {FEATURES.map((feature, i) => (
            <Reveal key={feature.kicker} className="reveal-celestial">
              <div className="landing-glass rounded-3xl p-6 md:p-8 lg:p-10">
                <div className="grid items-center gap-8 lg:grid-cols-2 lg:gap-12">
                  <div className={cn(i % 2 === 1 && "lg:order-2")}>
                    <p className={KICKER}>{feature.kicker}</p>
                    <h3 className={CARD_TITLE}>{feature.title}</h3>
                    <p className={CARD_BODY}>{feature.body}</p>
                  </div>
                  <div
                    className={cn(
                      "flex justify-center lg:justify-end",
                      i % 2 === 1 && "lg:order-1 lg:justify-start"
                    )}
                  >
                    {feature.visual}
                  </div>
                </div>
              </div>
            </Reveal>
          ))}
        </div>

        <Reveal className="reveal-celestial">
          <div className="mt-10 flex flex-wrap items-center gap-3">
            <p className="text-sm text-[#6d807c]">Also in Orbit:</p>
            {ALSO_IN_ORBIT.map(({ label, Icon }) => (
              <span
                key={label}
                className="flex items-center gap-2 rounded-full border border-[#e8f3f1]/[0.14] px-3 py-1.5 text-sm text-[#9aada8]"
              >
                <Icon className="h-3.5 w-3.5 text-[#c4a35a]" aria-hidden />
                {label}
              </span>
            ))}
          </div>
        </Reveal>
      </div>
    </section>
  );
}
