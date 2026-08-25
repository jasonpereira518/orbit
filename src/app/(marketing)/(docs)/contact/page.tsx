import type { Metadata } from "next";
import Link from "next/link";
import { auth } from "@clerk/nextjs/server";
import {
  ArrowUpRight,
  Bug,
  Globe,
  Lightbulb,
  MessageSquare,
  ShieldCheck,
} from "lucide-react";
import { isContactFormEnabled } from "@/actions/contact";
import { LandingAuthControls } from "@/components/landing/landing-auth-controls";
import { ContactForm } from "@/components/marketing/contact-form";
import { FaqList, type FaqItem } from "@/components/marketing/faq-list";
import { DocHero } from "@/components/marketing/marketing-doc";
import { Reveal } from "@/components/motion/reveal";
import { isClerkConfigured, isDemoMode } from "@/lib/auth";
import { FREE_CONTACT_LIMIT } from "@/lib/plan-limits";

export const metadata: Metadata = {
  title: "Contact — Orbit",
  description:
    "Send a message to the person who builds Orbit: bug reports, feature requests, privacy questions, and everything else.",
};

const PERSONAL_SITE = "https://jasonpereira.live/";
const REPO_URL = "https://github.com/jasonpereira518/orbit";
const ISSUES_URL = "https://github.com/jasonpereira518/orbit/issues/new";

const HEADING =
  "font-[family-name:var(--font-display)] font-normal leading-[1.15] tracking-[-0.025em] text-[#e8f3f1]";

const CHANNELS = [
  {
    icon: Globe,
    label: "Elsewhere",
    title: "jasonpereira.live",
    body: "The rest of what Jason works on, and every other way to get hold of him.",
    href: PERSONAL_SITE,
    cta: "Open the site",
    external: true,
  },
  {
    icon: Bug,
    label: "Bugs & ideas",
    title: "GitHub issues",
    body: "Orbit is open on GitHub. Bug reports and feature requests filed as issues get tracked in public rather than lost in a thread.",
    href: ISSUES_URL,
    cta: "Open an issue",
    external: true,
  },
  {
    icon: ShieldCheck,
    label: "Your data",
    title: "Settings → Data and privacy",
    body: "Exporting or deleting your Orbit data doesn't need a request — the controls are already in the app and run instantly.",
    href: "/settings",
    cta: "Open Settings",
    external: false,
  },
] as const;

const TOPICS = [
  {
    icon: Bug,
    title: "Something is broken",
    body: "Say what you did, what happened, and what you expected. Roughly when it happened is usually enough to find it in the logs.",
  },
  {
    icon: Lightbulb,
    title: "Orbit should do X",
    body: "Describe the moment in your job search where you wanted it, not the feature itself — that's what shapes how it gets built.",
  },
  {
    icon: ShieldCheck,
    title: "A privacy or data question",
    body: "Ask about anything in the privacy policy, or about a record you want corrected or removed.",
  },
  {
    icon: MessageSquare,
    title: "Something else",
    body: "Press, partnerships, a question about the stack, or just telling me the landing page renders badly on your phone.",
  },
] as const;

const FAQ: readonly FaqItem[] = [
  {
    q: "How do I export my data?",
    a: (
      <>
        Go to <Link href="/settings">Settings → Data and privacy</Link> and
        request the JSON export. It covers contacts, interactions, reminders,
        tags, imports, and AI suggestions, on every plan including Free. A few
        categories — chat history, outreach records, embeddings — may fall
        outside it; ask if you need those too.
      </>
    ),
  },
  {
    q: "How do I delete everything?",
    a: (
      <>
        The same Settings panel has a control that permanently deletes all Orbit
        application data for your account. Deleting your Clerk account also
        triggers removal through the account lifecycle webhook. Details are in
        the <Link href="/privacy">privacy policy</Link>.
      </>
    ),
  },
  {
    q: "Which AI provider does Orbit send my notes to?",
    a: (
      <>
        Whichever one you choose in Settings — Google Gemini, OpenAI, or
        Anthropic — running on an API key you supply, so the request lands on
        your own account with that vendor and is billed to you at cost. Nothing
        is sent until you enable an AI feature.
      </>
    ),
  },
  {
    q: "What does Orbit cost?",
    a: (
      <>
        Free for your first {FREE_CONTACT_LIMIT} contacts, with a monthly plan
        and a one-time early-adopter tier above that — current prices are on the{" "}
        <Link href="/pricing">pricing page</Link>. AI always runs on your own
        provider key, billed to you directly with no markup.
      </>
    ),
  },
  {
    q: "What happens if I stop paying?",
    a: (
      <>
        Nothing is deleted and nothing is hidden. Hitting a limit only stops you
        adding new people — every contact, note, and reminder you already have
        stays visible, editable, and exportable, including the ones you added
        while subscribed.
      </>
    ),
  },
  {
    q: "Can I use Orbit to send cold outreach at scale?",
    a: (
      <>
        Orbit is built for personal networking — the people you actually met.
        Unsolicited bulk messaging isn&apos;t supported and breaches{" "}
        <Link href="/terms">the acceptable use terms</Link>. You are the sender
        of anything that leaves your account.
      </>
    ),
  },
  {
    q: "Is the code public?",
    a: (
      <>
        Yes —{" "}
        <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
          github.com/jasonpereira518/orbit
        </a>
        . If you&apos;d rather read the implementation than take the privacy
        policy&apos;s word for it, that&apos;s the fastest route.
      </>
    ),
  },
];

export default async function ContactPage() {
  const clerkOn = isClerkConfigured();
  // Public page: resolve auth optionally so signed-out visitors never hit a throw.
  const { userId } = clerkOn ? await auth() : { userId: null };
  const authProps = {
    clerkOn,
    demoMode: isDemoMode(),
    signedIn: Boolean(userId),
  };
  // No mail credentials, no form: a contact form that always fails is worse
  // than sending people to the links below.
  const formEnabled = await isContactFormEnabled();

  return (
    <>
      <DocHero
        eyebrow="Contact"
        title="Talk to the person who builds it."
        lede="Orbit doesn't have a support queue or a ticket bot. It's one developer, so a message reaches the person who can actually change the thing you're writing about."
        meta={[
          { label: "Built by", value: "Jason Pereira" },
          { label: "Typical reply", value: "Within a few days" },
          { label: "Best for bugs", value: "GitHub issues" },
        ]}
      />

      <section className="mx-auto w-full max-w-6xl px-6 pb-16 md:px-10 md:pb-20">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-14">
          <Reveal className="reveal-celestial">
            <p className="text-xs uppercase tracking-[0.18em] text-[#6d807c]">
              {formEnabled ? "Write to Jason" : "What to write about"}
            </p>
            <h2 className={`${HEADING} mt-3 max-w-[16ch] text-[clamp(26px,3.6vw,40px)]`}>
              A little context goes a long way.
            </h2>
            <p className="mt-4 max-w-[42ch] text-base leading-[1.7] text-[#9aada8]">
              {formEnabled
                ? "Nothing here is required beyond a reply address. These are just the details that turn a message into a fix."
                : "There's no form to fill in and no required format. These are just the details that turn a message into a fix."}
            </p>

            <ul className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-1">
              {TOPICS.map(({ icon: Icon, title, body }) => (
                <li key={title} className="flex gap-3.5">
                  <Icon
                    className="mt-0.5 size-[18px] shrink-0 text-landing-accent"
                    aria-hidden="true"
                  />
                  <div>
                    <p className="text-[15px] text-[#e8f3f1]">{title}</p>
                    <p className="mt-1 max-w-[40ch] text-sm leading-[1.65] text-[#9aada8]">
                      {body}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </Reveal>

          {formEnabled && (
            <Reveal className="reveal-celestial" delay={90}>
              <ContactForm />
            </Reveal>
          )}
        </div>
      </section>

      <section className="mx-auto w-full max-w-6xl border-t border-[#e8f3f1]/[0.07] px-6 py-16 md:px-10 md:py-20">
        <Reveal className="reveal-celestial">
          <p className="text-xs uppercase tracking-[0.18em] text-[#6d807c]">
            {formEnabled ? "Other ways to reach Orbit" : "Ways to reach Orbit"}
          </p>
        </Reveal>
        <div className="mt-6 grid gap-4 lg:grid-cols-3">
          {CHANNELS.map(({ icon: Icon, ...channel }, index) => {
            const inner = (
              <>
                <div className="flex items-start justify-between gap-4">
                  <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-[#f2c14e]/25 bg-[#f2c14e]/[0.08]">
                    <Icon className="h-5 w-5 text-landing-accent" />
                  </span>
                  <span className="text-[11px] uppercase tracking-[0.16em] text-[#6d807c]">
                    {channel.label}
                  </span>
                </div>
                <p className="mt-5 font-[family-name:var(--font-display)] text-xl tracking-tight text-[#e8f3f1]">
                  {channel.title}
                </p>
                <p className="mt-2.5 text-sm leading-[1.65] text-[#9aada8]">
                  {channel.body}
                </p>
                <span className="mt-5 inline-flex items-center gap-1.5 text-sm text-landing-accent">
                  {channel.cta}
                  <ArrowUpRight className="h-4 w-4 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
                </span>
              </>
            );

            const className =
              "landing-glass group flex w-full flex-col rounded-3xl p-6 transition-colors hover:border-[#f2c14e]/30 sm:p-7";

            return (
              <Reveal
                key={channel.title}
                className="reveal-celestial flex"
                delay={index * 70}
              >
                {channel.external ? (
                  <a
                    href={channel.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={className}
                  >
                    {inner}
                  </a>
                ) : (
                  <Link href={channel.href} className={className}>
                    {inner}
                  </Link>
                )}
              </Reveal>
            );
          })}
        </div>
      </section>

      <section className="mx-auto w-full max-w-6xl border-t border-[#e8f3f1]/[0.07] px-6 py-16 md:px-10 md:py-20">
        <Reveal className="reveal-celestial">
          <p className="text-xs uppercase tracking-[0.18em] text-[#6d807c]">
            Answered already
          </p>
          <h2 className={`${HEADING} mt-3 max-w-[20ch] text-[clamp(26px,3.6vw,40px)]`}>
            The questions that arrive most often.
          </h2>
        </Reveal>

        <Reveal className="reveal-celestial mt-8 block" delay={80}>
          <FaqList items={FAQ} />
        </Reveal>
      </section>

      <section className="relative mx-auto w-full max-w-6xl px-6 pb-8 pt-4 text-center md:px-10">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute left-1/2 top-1/2 -z-10 h-[720px] w-[720px] -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{
            background:
              "radial-gradient(circle, rgba(242,193,78,0.13), transparent 62%)",
          }}
        />
        <Reveal className="reveal-celestial">
          <h2 className={`${HEADING} text-[clamp(28px,3.8vw,42px)]`}>
            Or skip the message and try it.
          </h2>
        </Reveal>
        <Reveal className="reveal-celestial" delay={90}>
          <p className="mx-auto mt-4 max-w-[44ch] text-base leading-relaxed text-[#9aada8]">
            Orbit is free for your first {FREE_CONTACT_LIMIT} contacts. Most
            questions answer themselves once your own network is on the screen.
          </p>
        </Reveal>
        <Reveal className="reveal-celestial mt-8 flex justify-center" delay={170}>
          <LandingAuthControls {...authProps} variant="hero" />
        </Reveal>
      </section>
    </>
  );
}
