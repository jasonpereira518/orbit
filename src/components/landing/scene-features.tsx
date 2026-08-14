import { BookOpen, LayoutDashboard, Send } from "lucide-react";
import {
  AskVisual,
  ConstellationVisual,
  ContactsVisual,
  ImportsVisual,
  RemindersVisual,
} from "@/components/landing/feature-visuals";
import { Reveal } from "@/components/motion/reveal";
import { cn } from "@/lib/utils";

// The features scene: every app feature, told in the narrative's voice.
// Five alternating .landing-glass cards pair server-rendered copy with a
// scroll-scrubbed preview (feature-visuals.tsx — each card animates its
// own story as it crosses the viewport), then a chip strip covers the
// remaining nav features.

const KICKER = "text-xs uppercase tracking-[0.16em] text-[#c4a35a]";
const CARD_TITLE =
  "mt-3 font-[family-name:var(--font-display)] text-2xl leading-snug tracking-tight text-[#e8f3f1] md:text-3xl";
const CARD_BODY = "mt-3 max-w-md text-base leading-relaxed text-[#9aada8]";

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
    visual: <ConstellationVisual label="Northwind · 6 people" />,
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
            <p className={KICKER}>The Features</p>
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
