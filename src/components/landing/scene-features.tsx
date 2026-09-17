import { BookOpen, NotebookPen } from "lucide-react";
import {
  AskVisual,
  ConstellationVisual,
  ContactsVisual,
  ImportsVisual,
  RemindersVisual,
} from "@/components/landing/feature-visuals";
import { GlassCard } from "@/components/landing/glass-card";
import { Reveal } from "@/components/motion/reveal";
import { cn } from "@/lib/utils";

// The features scene: every app feature, told in the narrative's voice.
// Three full-width alternating cards carry the story, then two smaller
// cards sit side by side as a coda, then a chip strip covers the remaining
// nav features. Each card pairs server-rendered copy with a scroll-scrubbed
// preview (feature-visuals.tsx — each animates its own story as it crosses
// the viewport).
//
// It used to be five identical alternating cards, and by the third the eye
// stopped reading: same size, same rhythm, same left-right swing. The split
// spends the full-width treatment on the three features that ARE the story,
// and lets the two supporting ones arrive together, lighter.

const KICKER = "text-xs uppercase tracking-[0.16em] text-[#f2c14e]";
const CARD_TITLE =
  "mt-3 font-[family-name:var(--font-display)] text-2xl leading-snug tracking-tight text-[#e8f3f1] md:text-3xl";
const CARD_BODY = "mt-3 max-w-md text-base leading-relaxed text-[#9aada8]";
/** One step down from CARD_TITLE, so the pair reads as a coda rather than as
 * two more chapters. */
const CODA_TITLE =
  "mt-3 font-[family-name:var(--font-display)] text-xl leading-snug tracking-tight text-[#e8f3f1] md:text-2xl";

type Feature = {
  kicker: string;
  title: string;
  body: string;
  visual: React.ReactNode;
};

// Every visual is aria-hidden, so each body must carry its own claim in
// prose — the card has to read completely with the animation switched off.

/** The story: remember them, find the way in, don't let it go cold. */
const NARRATIVE: Feature[] = [
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
];

/**
 * How the story gets acted on. Paired rather than given full-width cards of
 * their own: both visuals are fluid stacks capped at 340px, so they read at
 * half width without retuning — unlike the three above, whose previews are
 * built around a wide box.
 */
const CODA: Feature[] = [
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
  { label: "Knowledge", Icon: BookOpen },
  { label: "Notes", Icon: NotebookPen },
];

export function SceneFeatures() {
  // lg:pt-10 — the how-it-works pin hands off with the departing globe still
  // filling the top of the frame, so a full py-24 here opened a dead gap.
  return (
    <section
      aria-labelledby="features-heading"
      className="landing-scene scene-features relative z-10 px-8 py-24 md:px-10 lg:pt-10"
    >
      <div className="mx-auto w-full max-w-6xl">
        <div id="features" className="max-w-xl">
          <Reveal className="reveal-celestial">
            <p className={KICKER}>How it helps your search</p>
          </Reveal>
          <Reveal className="reveal-celestial" delay={80}>
            <h2
              id="features-heading"
              className="mt-3 font-[family-name:var(--font-display)] text-[clamp(30px,4.4vw,50px)] font-normal leading-[1.15] tracking-[-0.025em] text-[#e8f3f1]"
            >
              Every person who could help you, remembered.
            </h2>
          </Reveal>
        </div>

        <div className="mt-12 space-y-6">
          {NARRATIVE.map((feature, i) => (
            <Reveal key={feature.kicker} className="reveal-celestial">
              <GlassCard className="rounded-3xl p-5 md:p-8 lg:p-10">
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
              </GlassCard>
            </Reveal>
          ))}

          {/* Two-up only from lg, the same breakpoint the cards above split into
            * columns. At md each tile would squeeze its preview well under its
            * 340px cap, so below lg the pair stacks like everything else. */}
          <div className="grid gap-6 lg:grid-cols-2">
            {CODA.map((feature, i) => (
              <Reveal
                key={feature.kicker}
                className="reveal-celestial h-full"
                delay={i * 100}
              >
                <GlassCard className="flex h-full flex-col rounded-2xl p-5 md:p-6">
                  {/* A floor under the preview so both titles start on the same
                    * line — the two previews are very different heights, and
                    * without it the pair reads as misaligned rather than as a set.
                    * It has to clear the TALLER preview: the Ask stack measures
                    * 175px in Chrome, and a floor under that let it push its title
                    * 15px below its neighbour's. The extra headroom absorbs line-height
                    * differences between browsers rather than aligning to the pixel.
                    * Only from lg: stacked, there is no neighbour to align with, and
                    * the floor just strands the short Imports preview in empty space. */}
                  <div className="flex items-center justify-center lg:min-h-48">
                    {feature.visual}
                  </div>
                  <div className="mt-6">
                    <p className={KICKER}>{feature.kicker}</p>
                    <h3 className={CODA_TITLE}>{feature.title}</h3>
                    <p className={CARD_BODY}>{feature.body}</p>
                  </div>
                </GlassCard>
              </Reveal>
            ))}
          </div>
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
