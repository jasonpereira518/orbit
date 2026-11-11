import Link from "next/link";
import { ConstellationFigure } from "@/components/landing/constellation-figure";
import { FinaleVideo } from "@/components/landing/finale-video";
import { FooterWordmark } from "@/components/landing/footer-wordmark";
import { GlassCard } from "@/components/landing/glass-card";
import { LandingAuthControls } from "@/components/landing/landing-auth-controls";
import { LANDING_CREDITS } from "@/components/landing/landing-credits";
import { WaitlistForm } from "@/components/landing/waitlist-form";
import { MarketingFooter } from "@/components/marketing/marketing-footer";
import { Reveal } from "@/components/motion/reveal";
import { FREE_CONTACT_LIMIT } from "@/lib/plan-limits";
import { cn } from "@/lib/utils";

// All narrative copy is server-rendered here so it ships in the document;
// <Reveal> only choreographs when it becomes visible.

export const HEADING =
  "font-[family-name:var(--font-display)] text-[clamp(30px,4.4vw,52px)] font-normal leading-[1.1] tracking-[-0.025em] text-balance text-[#e8f3f1]";
export const BODY = "mt-4 max-w-md text-base leading-relaxed text-[#e8f3f1]/85 sm:text-lg";

/**
 * Dissolves a photograph into whatever is behind it at its top and bottom edges. A mask, not
 * a gradient to a colour: the page's ground is the starfield, which is not one colour, and a
 * fade to any fixed one leaves a line where it ends.
 */
const EDGE_MASK = "[mask-image:linear-gradient(to_bottom,transparent,black_16%,black_84%,transparent)]";

/** A full-bleed photograph from `public/landing/photos/` (credits: landing-credits.ts). */
function Plate({ name, className }: { name: string; className?: string }) {
  const base = `/landing/photos/${name}-v1`;
  return (
    <picture>
      <source type="image/avif" srcSet={`${base}-1600.avif 1600w, ${base}-2400.avif 2400w`} sizes="100vw" />
      <source type="image/webp" srcSet={`${base}-1600.webp 1600w, ${base}-2400.webp 2400w`} sizes="100vw" />
      <img
        src={`${base}-1600.webp`}
        alt=""
        loading="lazy"
        decoding="async"
        className={cn("absolute inset-0 size-full object-cover", className)}
      />
    </picture>
  );
}

export function SceneConstellations() {
  return (
    <section aria-labelledby="groups-heading" className="landing-scene scene-constellations relative z-10">
      {/* md and up: the whole photograph, uncropped (the box takes its shape), with the copy
        * on the one stretch of it that has no bright star: the middle of the left side. */}
      <div className="relative md:flex md:aspect-[4039/3177] md:items-center">
        <div aria-hidden className={cn("absolute inset-0 hidden md:block", EDGE_MASK)}>
          <Plate name="orion" />
          <ConstellationFigure anchor="center" labelSize={52} />
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_0%_52%,rgba(3,5,12,0.9),rgba(3,5,12,0)_48%)]" />
        </div>
        {/* Gutters on the outer box and the column inside it, as in the hero, so every
          * section's type starts on the same left edge. */}
        <div className="relative w-full px-8 pb-10 pt-24 md:px-10 md:py-0">
          <div className="mx-auto w-full max-w-6xl">
            <div id="groups" className="max-w-md">
              <Reveal className="reveal-celestial">
                <h2 id="groups-heading" className={HEADING}>
                  Every company has someone in it.
                </h2>
              </Reveal>
              <Reveal className="reveal-celestial" delay={80}>
                <p className={BODY}>
                  Orbit groups your people by employer, school and old team. Search the place you
                  want to be and see who you already know there.
                </p>
              </Reveal>
            </div>
          </div>
        </div>
        {/* Phones: the photograph under the copy, cropped to the side Orion is on. */}
        <div aria-hidden className={cn("relative aspect-[4/5] md:hidden", EDGE_MASK)}>
          <Plate name="orion" className="object-right" />
          <ConstellationFigure anchor="right" labelSize={116} />
        </div>
      </div>
    </section>
  );
}

/**
 * What else ships today, as a poster: the name large on the left, one plain fact on the
 * right. Every fact must be true of the Free plan the buttons on this page create
 * (plan-copy.ts lists what each plan includes).
 */
const ALSO = [
  { name: "Ask who you know", fact: "In Orbit, or from Claude or ChatGPT. Free on every plan." },
  { name: "Knowledge", fact: "One searchable record of what you know about each person." },
  { name: "Notes", fact: "Scan or paste them, and Orbit pulls the people out." },
];

export function SceneAlso() {
  return (
    <section aria-labelledby="features-heading" className="landing-scene scene-features relative z-10 overflow-hidden">
      <div aria-hidden className={cn("absolute inset-0", EDGE_MASK)}>
        <Plate name="carina" />
        {/* The cliffs are bright orange; the type needs the upper sky held down too. */}
        <div className="absolute inset-0 bg-[#03050c]/50" />
      </div>
      <div className="relative w-full px-8 py-28 md:px-10 md:py-44">
        <div className="mx-auto w-full max-w-6xl">
        {/* The list is its own headline; a small label over 80px lines would be an eyebrow.
          * The heading stays for the outline and the header's "Also in Orbit" link. */}
        <h2 id="features-heading" className="sr-only">
          Also in Orbit
        </h2>
        <ul id="features" className="flex flex-col gap-8 md:gap-4">
          {ALSO.map((item, i) => (
            <Reveal key={item.name} as="li" className="reveal-celestial" delay={i * 80}>
              <div className="flex flex-col gap-2 md:flex-row md:items-baseline md:justify-between md:gap-10">
                <span className="font-[family-name:var(--font-display)] text-[clamp(2.5rem,7vw,5.25rem)] font-light leading-[0.98] tracking-[-0.03em] text-[#e8f3f1] md:whitespace-nowrap">
                  {item.name}
                </span>
                <span className="max-w-xs text-base leading-relaxed text-[#e8f3f1]/90 md:text-right">{item.fact}</span>
              </div>
            </Reveal>
          ))}
        </ul>
        </div>
      </div>
    </section>
  );
}

/** The price, printed on a ticket: Orbit's own boarding-pass artefact, in the page's light ink. */
export function ScenePrice() {
  return (
    <section aria-labelledby="price-heading" className="landing-scene scene-price relative z-10 px-8 py-24 md:px-10 md:py-32">
      <Reveal className="reveal-celestial">
        <div className="landing-ticket relative mx-auto grid w-full max-w-4xl rounded-3xl bg-[#e8f3f1] text-[#0f3d3e] md:grid-cols-[7fr_3fr]">
          <div className="p-8 md:p-12">
            <h2
              id="price-heading"
              className="font-[family-name:var(--font-display)] text-[clamp(2.25rem,5vw,3.75rem)] leading-[1.03] tracking-[-0.03em] text-balance"
            >
              Free for your first {FREE_CONTACT_LIMIT} contacts.
            </h2>
            <p className="mt-4 max-w-md text-base leading-relaxed text-[#0f3d3e]/85">
              Import everyone, see who has gone quiet, and follow up. When you outgrow it, there
              are two paid plans.
            </p>
          </div>
          <div className="flex items-center justify-between gap-6 border-t border-dashed border-[#0f3d3e]/35 p-8 md:flex-col md:items-start md:border-l md:border-t-0 md:p-10">
            <p className="font-[family-name:var(--font-display)] text-6xl leading-none">$0</p>
            <Link
              href="/pricing"
              className="inline-flex min-h-11 items-center justify-center rounded-full bg-[#0f3d3e] px-6 py-3 text-sm font-medium text-[#e8f3f1] transition-colors hover:bg-[#0b2e2f]"
            >
              See pricing
            </Link>
          </div>
        </div>
      </Reveal>
    </section>
  );
}

export function SceneFinale({
  clerkOn,
  demoMode = false,
  signedIn = false,
}: {
  clerkOn: boolean;
  demoMode?: boolean;
  signedIn?: boolean;
}) {
  return (
    <section id="cta" aria-labelledby="cta-heading" className="landing-scene scene-finale relative z-10 px-8 md:px-10">
      {/* Home: the lights are everyone down there. Full-bleed (the negative margins undo the
        * section's gutters); the video masks itself out at its top and bottom edges. */}
      <div className="relative -mx-8 overflow-hidden md:-mx-10">
        {/* The scrim holds the lights down under the type, on the left where the type is. It
          * sits inside the video's own mask, so the two dissolve together and neither leaves
          * a line where it stops. */}
        <FinaleVideo className={EDGE_MASK}>
          <div aria-hidden className="absolute inset-0 bg-[linear-gradient(to_right,rgba(3,5,12,0.6),rgba(3,5,12,0.1)_70%)]" />
        </FinaleVideo>
        <div className="relative w-full px-8 pb-28 pt-40 md:px-10 md:pb-40 md:pt-56">
          <div className="mx-auto w-full max-w-6xl">
          <Reveal className="reveal-celestial">
            <h2
              id="cta-heading"
              className="font-[family-name:var(--font-display)] text-[clamp(2.75rem,8vw,6rem)] font-light leading-[1] tracking-[-0.03em] text-white"
            >
              Keep the door open.
            </h2>
          </Reveal>
          <Reveal className="reveal-celestial" delay={100}>
            <p className={BODY}>
              Free for your first {FREE_CONTACT_LIMIT} contacts. Connect LinkedIn and Gmail once,
              and Orbit keeps track from there.
            </p>
          </Reveal>
          <Reveal className="reveal-celestial w-full sm:w-auto" delay={200}>
            <div className="mt-8 w-full sm:w-auto">
              <LandingAuthControls
                clerkOn={clerkOn}
                demoMode={demoMode}
                signedIn={signedIn}
                variant="hero"
                mobileVisible
                primaryOnly
                primaryLabel="Create your free account"
              />
            </div>
          </Reveal>
          </div>
        </div>
      </div>

      <div className="mx-auto grid w-full max-w-6xl gap-12 py-20 lg:grid-cols-2 lg:gap-20">
          {/* The button above creates a FREE account, so no answer may promise a Pro feature
            * as if it came with it (plan-copy.ts lists what each plan includes). */}
          <Reveal className="reveal-celestial">
            <h3 className="font-[family-name:var(--font-display)] text-2xl text-[#e8f3f1]">Before you connect anything</h3>
            <dl className="mt-6 grid gap-6">
              <div>
                <dt className="font-[family-name:var(--font-display)] text-lg text-[#e8f3f1]">Do I need to type everyone in?</dt>
                <dd className="mt-1.5 text-base leading-relaxed text-[#e8f3f1]/85">
                  No. Upload LinkedIn&apos;s Connections.csv and your whole network arrives at once,
                  one page per person. Add anyone else by hand, or from your notes.
                </dd>
              </div>
              <div>
                <dt className="font-[family-name:var(--font-display)] text-lg text-[#e8f3f1]">What does it read?</dt>
                <dd className="mt-1.5 text-base leading-relaxed text-[#e8f3f1]/85">
                  Your Gmail, Google Contacts and calendar, so it can build a timeline for the
                  people you actually talk to. Sending is a separate permission it uses only when
                  you press send.{" "}
                  <Link href="/privacy" className="underline underline-offset-4 transition-opacity hover:opacity-80">
                    The full list is in the privacy policy
                  </Link>
                  .
                </dd>
              </div>
            </dl>
          </Reveal>

        <Reveal className="reveal-celestial" delay={120}>
          <GlassCard className="rounded-3xl p-6 text-left md:p-8">
            {/* Secondary path only. The app is live, so this is a mailing list, not a
              * waitlist, and must not compete with the button above. */}
            <p className="text-lg text-[#e8f3f1]">Not ready to sign up?</p>
            <p className="mt-1 text-sm text-[#e8f3f1]/85">Get the occasional note on what&apos;s new in Orbit.</p>
            <div className="mt-4">
              <WaitlistForm />
            </div>
            <p className="mt-3 text-sm text-[#9aada8]">No commitments. Interest list only.</p>
          </GlassCard>
        </Reveal>
      </div>

      <MarketingFooter className="max-w-4xl" />

      {/* The CC BY 4.0 items require a visible credit; the rest are credited as their
        * owners ask. Nothing here may read as an endorsement. */}
      <p className="mx-auto max-w-4xl pb-10 text-sm leading-relaxed text-[#9aada8]">
        Images:{" "}
        {LANDING_CREDITS.map((item, i) => (
          <span key={item.source}>
            {i > 0 && "; "}
            <a
              href={item.source}
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-4 transition-opacity hover:opacity-80"
            >
              {item.title}
            </a>
            , {item.credit}
            {item.licence === "CC BY 4.0" && " (CC BY 4.0)"}
          </span>
        ))}
        . Used with thanks; no endorsement is implied.
      </p>

      {/* Landing only: the other marketing pages end on the plain footer. Nothing may
        * follow it, since its bottom edge is the page's. */}
      <FooterWordmark className="relative z-10 mx-auto max-w-6xl" />
    </section>
  );
}
