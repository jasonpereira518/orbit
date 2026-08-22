import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowUpRight,
  Bug,
  ChevronDown,
  Globe,
  Lightbulb,
  MessageSquare,
  ShieldCheck,
} from "lucide-react";
import { WaitlistForm } from "@/components/landing/waitlist-form";
import {
  DocHero,
  MarketingDocShell,
} from "@/components/marketing/marketing-doc";
import { isClerkConfigured, isDemoMode } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Contact — Orbit",
  description:
    "Reach the person who builds Orbit: bug reports, feature requests, privacy questions, and everything else.",
};

const PERSONAL_SITE = "https://jasonpereira.live/";
const REPO_URL = "https://github.com/jasonpereira518/orbit";
const ISSUES_URL = "https://github.com/jasonpereira518/orbit/issues/new";

const CHANNELS = [
  {
    icon: Globe,
    label: "Start here",
    title: "jasonpereira.live",
    body: "The main way in. Contact details live on the site, and messages land with the person who writes the code.",
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
    body: "Say what you did, what happened, and what you expected. A screenshot and roughly when it happened is usually enough to find it in the logs.",
  },
  {
    icon: Lightbulb,
    title: "Orbit should do X",
    body: "Describe the moment in your job search where you wanted it, not the feature itself — that's what shapes how it gets built.",
  },
  {
    icon: ShieldCheck,
    title: "A privacy or data question",
    body: "Ask about anything in the privacy policy, or about a record you want corrected or removed. Mention the account email you use.",
  },
  {
    icon: MessageSquare,
    title: "Everything else",
    body: "Press, partnerships, a question about the stack, or just telling me the landing page renders badly on your phone — all welcome.",
  },
] as const;

const FAQ = [
  {
    q: "How do I export my data?",
    a: (
      <>
        Go to <Link href="/settings">Settings → Data and privacy</Link> and
        request the JSON export. It covers contacts, interactions, reminders,
        tags, imports, and AI suggestions. A few categories — chat history,
        outreach records, embeddings — may fall outside it; ask if you need
        those too.
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
        Anthropic. Where it&apos;s supported you can supply your own API key, so
        requests run on your own account with that vendor. Nothing is sent until
        you enable an AI feature.
      </>
    ),
  },
  {
    q: "Does Orbit cost anything?",
    a: (
      <>
        Orbit is free during early access. If you connect your own API keys for
        AI, enrichment, email, or SMS, those providers bill you directly for
        what you use. See <Link href="/terms">the terms</Link> for how pricing
        changes would be announced.
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
] as const;

export default function ContactPage() {
  const clerkOn = isClerkConfigured();
  const demoMode = isDemoMode();

  return (
    <MarketingDocShell active="/contact">
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

      <section className="landing-reveal mx-auto w-full max-w-6xl px-6 pb-16 md:px-10 md:pb-20">
        <p className="text-xs uppercase tracking-[0.18em] text-[#6d807c]">
          Ways to reach Orbit
        </p>
        <div className="mt-6 grid gap-4 lg:grid-cols-3">
          {CHANNELS.map(({ icon: Icon, ...channel }) => {
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
                  <ArrowUpRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
                </span>
              </>
            );

            const className =
              "landing-glass group flex flex-col rounded-3xl p-6 transition-colors hover:border-[#f2c14e]/30 sm:p-7";

            return channel.external ? (
              <a
                key={channel.title}
                href={channel.href}
                target="_blank"
                rel="noopener noreferrer"
                className={className}
              >
                {inner}
              </a>
            ) : (
              <Link key={channel.title} href={channel.href} className={className}>
                {inner}
              </Link>
            );
          })}
        </div>
      </section>

      <section className="landing-reveal mx-auto w-full max-w-6xl border-t border-[#e8f3f1]/[0.07] px-6 py-16 md:px-10 md:py-20">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:gap-16">
          <div>
            <p className="text-xs uppercase tracking-[0.18em] text-[#6d807c]">
              What to write about
            </p>
            <h2 className="mt-3 max-w-[16ch] font-[family-name:var(--font-display)] text-[clamp(26px,3.6vw,40px)] font-normal leading-[1.15] tracking-[-0.025em] text-[#e8f3f1]">
              A little context goes a long way.
            </h2>
            <p className="mt-4 max-w-[42ch] text-base leading-[1.7] text-[#9aada8]">
              There&apos;s no form to fill in and no required format. These are
              just the details that turn a message into a fix.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            {TOPICS.map(({ icon: Icon, title, body }) => (
              <div key={title} className="landing-glass rounded-2xl p-5">
                <Icon className="h-5 w-5 text-landing-accent" />
                <p className="mt-4 text-[15px] text-[#e8f3f1]">{title}</p>
                <p className="mt-1.5 text-sm leading-[1.65] text-[#9aada8]">
                  {body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="landing-reveal mx-auto w-full max-w-6xl border-t border-[#e8f3f1]/[0.07] px-6 py-16 md:px-10 md:py-20">
        <p className="text-xs uppercase tracking-[0.18em] text-[#6d807c]">
          Answered already
        </p>
        <h2 className="mt-3 max-w-[20ch] font-[family-name:var(--font-display)] text-[clamp(26px,3.6vw,40px)] font-normal leading-[1.15] tracking-[-0.025em] text-[#e8f3f1]">
          The questions that arrive most often.
        </h2>

        <div className="mt-8 grid gap-3 lg:grid-cols-2">
          {FAQ.map((item) => (
            <details
              key={item.q}
              className="landing-glass doc-faq h-fit rounded-2xl px-5 py-4"
            >
              <summary className="flex items-start justify-between gap-4 text-[15px] text-[#e8f3f1]">
                {item.q}
                <ChevronDown
                  aria-hidden="true"
                  className="doc-faq-chevron mt-1 h-4 w-4 shrink-0 text-[#6d807c] transition-transform"
                />
              </summary>
              <div className="doc-prose mt-3 border-t border-[#e8f3f1]/[0.07] pt-3 text-sm">
                <p>{item.a}</p>
              </div>
            </details>
          ))}
        </div>
      </section>

      <section className="landing-reveal mx-auto w-full max-w-6xl border-t border-[#e8f3f1]/[0.07] px-6 py-16 md:px-10 md:py-24">
        <div className="grid items-center gap-10 lg:grid-cols-2">
          <div>
            <h2 className="max-w-[16ch] font-[family-name:var(--font-display)] text-[clamp(28px,4.2vw,48px)] font-normal leading-[1.12] tracking-[-0.03em] text-[#e8f3f1]">
              Not writing in — just want in?
            </h2>
            <p className="mt-5 max-w-[40ch] text-base leading-[1.7] text-[#9aada8] sm:text-lg">
              Early access is free. Join the waitlist and you&apos;ll get an
              email as spots open.
            </p>
          </div>

          <div className="landing-glass rounded-3xl p-8">
            <p className="text-xs uppercase tracking-[0.16em] text-landing-accent">
              Waitlist
            </p>
            <p className="mt-2 text-base text-[#e8f3f1]">
              One email field, no setup.
            </p>
            <div className="mt-5">
              <WaitlistForm clerkOn={clerkOn} demoMode={demoMode} />
            </div>
            <p className="mt-4 text-xs text-[#6d807c]">
              Your address is used to let you in — nothing else. See the{" "}
              <Link
                href="/privacy"
                className="text-[#9aada8] underline underline-offset-4 transition-colors hover:text-[#e8f3f1]"
              >
                privacy policy
              </Link>
              .
            </p>
          </div>
        </div>
      </section>
    </MarketingDocShell>
  );
}
