import { BookOpen, LayoutDashboard, NotebookPen } from "lucide-react";
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

const KICKER = "text-xs uppercase tracking-[0.16em] text-[#f2c14e]";
const CARD_TITLE =
  "mt-3 font-[family-name:var(--font-display)] text-2xl leading-snug tracking-tight text-[#e8f3f1] md:text-3xl";
const CARD_BODY = "mt-3 max-w-md text-base leading-relaxed text-[#9aada8]";

// Every visual is aria-hidden, so each body must carry its own claim in
// prose — the card has to read completely with the animation switched off.
const FEATURES = [
  {
    kicker: "No re-introductions",
    title: "Every conversation, still there in six weeks.",
    body: "Recruiters, referrals, informational interviews — LinkedIn scraps and email threads merge into one page per person. You walk into the second call already knowing the first.",
    visual: <ContactsVisual />,
  },
  {
    kicker: "Get in the door",
    title: "See who you already know inside the company.",
    body: "Your people cluster by employer, school, and old team. Search a target company and Orbit shows the shortest warm path in — instead of the apply button.",
    visual: <ConstellationVisual label="Stripe · 6 people you know" />,
  },
  {
    kicker: "Before it goes cold",
    title: "Orbit tells you who to follow up with today.",
    body: "Set a cadence for the people who matter to your search. Orbit queues the nudges, so nothing depends on you remembering on a Tuesday.",
    visual: <RemindersVisual />,
  },
  {
    kicker: "Send fewer, better messages",
    title: "Ask who you know. Send the message. Track the reply.",
    body: "Ask in plain language — “who do I know at Stripe?” — and Orbit answers from your own network. Draft from there, and it tracks who replied and who still owes you one.",
    visual: <AskVisual />,
  },
  {
    kicker: "Nothing to type in",
    title: "Your network is already somewhere. Bring it in once.",
    body: "LinkedIn connections, Gmail threads, calendar invites — import them in one pass and Orbit keeps every record current while you keep searching.",
    visual: <ImportsVisual />,
  },
];

const ALSO_IN_ORBIT = [
  { label: "Dashboard", Icon: LayoutDashboard },
  { label: "Knowledge", Icon: BookOpen },
  { label: "Notes", Icon: NotebookPen },
];

export function SceneFeatures() {
  // lg:pt-10 — the how-it-works pin hands off with the departing globe still
  // filling the top of the frame, so a full py-24 here opened a dead gap.
  return (
    <section
      aria-labelledby="landing-features-heading"
      className="landing-scene scene-features relative z-10 px-6 py-24 md:px-10 lg:pt-10"
    >
      <div className="mx-auto w-full max-w-6xl">
        <div id="landing-features" className="max-w-xl">
          <Reveal className="reveal-celestial">
            <p className={KICKER}>How it helps your search</p>
          </Reveal>
          <Reveal className="reveal-celestial" delay={80}>
            <h2
              id="landing-features-heading"
              className="mt-3 font-[family-name:var(--font-display)] text-[clamp(30px,4.4vw,50px)] font-normal leading-[1.15] tracking-[-0.025em] text-[#e8f3f1]"
            >
              Every person who could help you, remembered.
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
          <div className="mt-16 border-t border-[#e8f3f1]/[0.07] pt-10">
            <p className={KICKER}>Also included</p>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              {ALSO_IN_ORBIT.map(({ label, Icon }) => (
                <span
                  key={label}
                  className="flex items-center gap-2 rounded-full border border-[#e8f3f1]/[0.14] px-3 py-1.5 text-sm text-[#9aada8]"
                >
                  <Icon className="h-3.5 w-3.5 text-[#f2c14e]" aria-hidden />
                  {label}
                </span>
              ))}
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
