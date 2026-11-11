import { Reveal } from "@/components/motion/reveal";
import { HEADING } from "@/components/landing/landing-scenes";

/**
 * The three steps, in the order they happen. Each band holds a real crop of the product,
 * in its dark theme: scripts/dev/capture-landing.mjs takes them from the app in demo mode,
 * whose people are fictional. There are two of each, the app's desktop layout and its phone
 * layout, so the crop a phone gets is the app as a phone shows it, not a desktop one shrunk
 * until its text is a few pixels. `wide` and `phone` are the crops' own sizes and hold the
 * layout before the image loads; update them when the capture script reports new ones.
 *
 * Each band steps the ground a shade towards teal: three fields butted together, no cards.
 * This is the page's one deliberate change of ground (the direction contract says so).
 */
const STEPS = [
  {
    title: "Bring your people in.",
    body: "Upload LinkedIn's Connections.csv, connect Gmail, Google Contacts and your calendar, or add notes by hand.",
    shot: "step-import",
    alt: "Orbit's Capture screen, with tabs for notes, voice memos, a notes library, Drive and OneDrive, and imports.",
    wide: [808, 179],
    phone: [438, 203],
    field: "bg-[#06131a]",
  },
  {
    title: "Orbit keeps the record.",
    body: "One page per person, with every email, meeting and note.",
    shot: "step-person",
    alt: "A person's page in Orbit: closeness, last touch three months ago, and where things stand with them.",
    wide: [788, 375],
    phone: [398, 245],
    field: "bg-[#091c21]",
  },
  {
    title: "Each week, a short list.",
    body: "Who to follow up with today, and why.",
    shot: "step-today",
    alt: "Orbit's Reminders screen showing three follow-ups due today, each with the person's name.",
    wide: [562, 379],
    phone: [396, 359],
    field: "bg-[#0d2728]",
  },
] as const;

export function LandingHowItWorks() {
  return (
    <section aria-labelledby="how-heading" className="landing-scene scene-how relative z-10">
      {/* Gutters on the outer box and the column inside it, as in the hero, so every
        * section's type starts on the same left edge. */}
      <div className="w-full px-8 pb-12 pt-24 md:px-10 md:pt-32">
        <div className="mx-auto w-full max-w-6xl">
          <Reveal className="reveal-celestial">
            <h2 id="how-heading" className={HEADING}>
              <span id="how">How it works</span>
            </h2>
          </Reveal>
        </div>
      </div>
      <ol>
        {STEPS.map((step, i) => (
          <li key={step.shot} className={`${step.field} px-8 py-14 md:px-10 md:py-20`}>
            <div className="mx-auto grid w-full max-w-6xl items-center gap-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:gap-14">
              <Reveal className="reveal-celestial">
                <p className="font-[family-name:var(--font-display)] text-5xl leading-none text-[#f2c14e]" aria-hidden>
                  {i + 1}
                </p>
                <h3 className="mt-4 font-[family-name:var(--font-display)] text-[clamp(1.5rem,2.4vw,2rem)] leading-tight tracking-[-0.02em] text-[#e8f3f1]">
                  {step.title}
                </h3>
                <p className="mt-3 max-w-sm text-base leading-relaxed text-[#e8f3f1]/85">{step.body}</p>
              </Reveal>
              {/* Never wider than the crop itself: the product's own text stays at its size. */}
              <Reveal className="reveal-celestial" delay={80}>
                <picture>
                  <source
                    media="(max-width: 767px)"
                    type="image/avif"
                    srcSet={`/landing/shots/${step.shot}-phone-v1-860.avif`}
                    width={step.phone[0]}
                    height={step.phone[1]}
                  />
                  <source
                    media="(max-width: 767px)"
                    type="image/webp"
                    srcSet={`/landing/shots/${step.shot}-phone-v1-860.webp`}
                    width={step.phone[0]}
                    height={step.phone[1]}
                  />
                  <source
                    type="image/avif"
                    srcSet={`/landing/shots/${step.shot}-v1-800.avif 800w, /landing/shots/${step.shot}-v1-1600.avif 1600w`}
                    sizes={`${step.wide[0]}px`}
                  />
                  <img
                    src={`/landing/shots/${step.shot}-v1-800.webp`}
                    alt={step.alt}
                    width={step.wide[0]}
                    height={step.wide[1]}
                    loading="lazy"
                    decoding="async"
                    className="block h-auto w-full rounded-xl"
                    style={{ maxWidth: step.wide[0] }}
                  />
                </picture>
              </Reveal>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
