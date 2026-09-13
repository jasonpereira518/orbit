import type { Metadata } from "next";
import Link from "next/link";
import { MailOpen, Sparkles, Unplug } from "lucide-react";
import { OrbitLogo } from "@/components/orbit-logo";
import { Reveal } from "@/components/motion/reveal";
import { LandingStarfield } from "@/components/landing/landing-visuals";
import { LandingAuthControls } from "@/components/landing/landing-auth-controls";
import { InterestHero, type HeroInitial } from "@/components/interest/interest-hero";
import { OrbitRingsBackdrop } from "@/components/interest/orbit-rings-backdrop";
import { FaqList, type FaqItem } from "@/components/marketing/faq-list";
import { MarketingFooter } from "@/components/marketing/marketing-footer";
import { BackControl } from "@/components/pricing/back-control";
import { getAppBaseUrl } from "@/lib/app-url";
import { isClerkConfigured, isDemoMode } from "@/lib/auth";
import {
  SHARE_TOKEN_MAX,
  buildTicketImageUrl,
  passengerLine,
  type InterestTicket,
} from "@/lib/interest-list";
import {
  getInterestProof,
  getInviterPlanet,
  getTicketByShareToken,
  type InterestProof,
} from "@/lib/interest-list-ticket";
import { FREE_CONTACT_LIMIT } from "@/lib/plan-limits";

// The proof line, the invited strip and the ticket all come from the URL and the database
// on every request. The proof memo (60 s) keeps the count query off the hot path.
export const dynamic = "force-dynamic";

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

const DEFAULT_TITLE = "Interest list — Orbit";
const DEFAULT_DESCRIPTION = `Occasional notes from the person building Orbit, only when there's real news. Join and you're handed a planet. Orbit is already live and free for your first ${FREE_CONTACT_LIMIT} contacts.`;

/** One token from the query, or null: trimmed, single-valued, at most SHARE_TOKEN_MAX. */
function tokenParam(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  const token = raw?.trim() ?? "";
  return token.length > 0 && token.length <= SHARE_TOKEN_MAX ? token : null;
}

export async function generateMetadata({
  searchParams,
}: {
  searchParams: SearchParams;
}): Promise<Metadata> {
  const params = await searchParams;
  const token = tokenParam(params.me) ?? tokenParam(params.ref);
  let ticket: InterestTicket | null = null;
  if (token) {
    try {
      ticket = await getTicketByShareToken(token);
    } catch (err) {
      console.error("[interest] ticket lookup failed in metadata", err);
    }
  }
  if (!ticket) {
    return { title: DEFAULT_TITLE, description: DEFAULT_DESCRIPTION };
  }
  const image = buildTicketImageUrl(getAppBaseUrl(), ticket.shareToken);
  const title = `${passengerLine(ticket)} — Orbit`;
  const description =
    "Every person who joins Orbit's interest list is handed a planet. Get yours.";
  return {
    title,
    description,
    openGraph: { title, description, images: [{ url: image, width: 1200, height: 630 }] },
    twitter: { card: "summary_large_image", title, description, images: [image] },
  };
}

const HEADING =
  "font-[family-name:var(--font-display)] font-normal leading-[1.12] tracking-[-0.025em] text-[#e8f3f1]";

/** What the proof line degrades to if the database read fails: count 0 stays below the
 * floor (so the count itself is hidden) and "next planet up: Mercury" is true for an empty
 * list and harmless otherwise. */
const EMPTY_PROOF: InterestProof = { count: 0, nextPlanet: "mercury", recent: [] };

const EXPECT = [
  {
    icon: MailOpen,
    title: "Written by a person",
    body: "Every note comes from Jason, the one person who builds Orbit. There's no drip sequence and no marketing calendar behind it.",
  },
  {
    icon: Sparkles,
    title: "Only when it's real",
    body: "A launch, a big change, something worth your minute. Quiet months stay quiet.",
  },
  {
    icon: Unplug,
    title: "Leave in one click",
    body: "Every email carries a one-click unsubscribe. You're off the list immediately, no confirmation screen.",
  },
];

const FAQ: readonly FaqItem[] = [
  {
    q: "How often will you email me?",
    a: "Rarely. A short hello when you join, one tip a few days later if you haven't signed up, and after that only when there's real news. Quiet months are quiet.",
  },
  {
    q: "Is this a waitlist?",
    a: `Not really. There's no queue and nothing to wait for — Orbit is live and free for your first ${FREE_CONTACT_LIMIT} contacts. The number and the planet are yours to keep; the notes are the point.`,
  },
  {
    q: "What happens to my address?",
    a: (
      <>
        It gets the notes above and nothing else — never shared or sold. The details are in
        the <Link href="/privacy">privacy policy</Link>.
      </>
    ),
  },
  {
    q: "How do I leave?",
    a: "Every email has a one-click unsubscribe link. You're off immediately; there's no confirmation screen.",
  },
];

/**
 * Dynamic: the card's state comes from `?me=` (a ticket) or `?ref=` (an invitation), and
 * the proof line from the database. Who is signed in still resolves in the browser
 * (`LandingAuthControls`). The form talks to `joinInterestList` directly.
 *
 * Not a warp journey destination (see `lib/warp/journeys.ts`), so no arrival beacon.
 */
export default async function InterestPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const me = tokenParam(params.me);
  const ref = me ? null : tokenParam(params.ref);

  const [proof, ticket, invite] = await Promise.all([
    getInterestProof().catch((err: unknown) => {
      console.error("[interest] proof read failed", err);
      return EMPTY_PROOF;
    }),
    me
      ? getTicketByShareToken(me).catch((err: unknown) => {
          console.error("[interest] ticket lookup failed", err);
          return null;
        })
      : Promise.resolve(null),
    ref
      ? getInviterPlanet(ref).catch((err: unknown) => {
          console.error("[interest] inviter lookup failed", err);
          return null;
        })
      : Promise.resolve(null),
  ]);

  const initial: HeroInitial = ticket
    ? { kind: "ticket", proof, ticket }
    : { kind: "form", proof, invite, ref: invite ? ref : null };

  const clerkOn = isClerkConfigured();
  const demoMode = isDemoMode();
  const authProps = { clerkOn, demoMode };
  // Mirrors the destinations `LandingAuthControls` chooses for "Get Started".
  const signUpHref = clerkOn ? "/sign-up" : demoMode ? "/dashboard" : "/sign-in";

  return (
    // `landing-root` is load-bearing: globals.css paints the body deep-space while it is
    // mounted, which is what stops a light strip appearing on overscroll. The starfield
    // renders position:fixed, so this root must stay free of transform/filter.
    <div className="landing-root relative overflow-x-clip bg-[#03050c] text-[#e8f3f1]">
      <LandingStarfield interactive />

      <header className="relative z-10 mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-6 py-6 md:px-10">
        <div className="flex items-center gap-4">
          <BackControl />
          <Link
            href="/"
            className="flex items-center gap-2.5 transition-opacity hover:opacity-80"
            aria-label="Orbit home"
          >
            <OrbitLogo size="sm" />
            {/* Below sm the wordmark is what pushes the auth controls into
                wrapping — the logo alone still identifies the link. */}
            <span className="hidden font-[family-name:var(--font-display)] text-[17px] tracking-tight text-[#e8f3f1] sm:inline">
              Orbit
            </span>
          </Link>
        </div>
        <LandingAuthControls {...authProps} variant="header" />
      </header>

      <main className="relative z-10 mx-auto w-full max-w-6xl px-6 pb-24 md:px-10">
        <div className="relative">
          <OrbitRingsBackdrop />
          <InterestHero initial={initial} appUrl={getAppBaseUrl()} signUpHref={signUpHref} />
        </div>

        <Reveal className="reveal-celestial mt-20 block">
          <ul className="grid gap-6 sm:grid-cols-3">
            {EXPECT.map(({ icon: Icon, title, body }) => (
              <li key={title} className="flex gap-3.5">
                <Icon className="mt-0.5 size-[18px] shrink-0 text-[#f2c14e]" aria-hidden="true" />
                <div>
                  <h3 className="text-sm font-medium text-[#e8f3f1]">{title}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-[#9aada8]">{body}</p>
                </div>
              </li>
            ))}
          </ul>
        </Reveal>

        <section className="mt-24 md:mt-32" aria-labelledby="interest-faq">
          <Reveal className="reveal-celestial">
            <h2 id="interest-faq" className={`${HEADING} text-center text-[clamp(26px,3.4vw,38px)]`}>
              Before you hand over an address.
            </h2>
          </Reveal>
          <Reveal className="reveal-celestial mt-10 block" delay={80}>
            <FaqList items={FAQ} />
          </Reveal>
        </section>

        <section className="relative mt-24 text-center md:mt-32">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute left-1/2 top-1/2 -z-10 h-[720px] w-[720px] -translate-x-1/2 -translate-y-1/2 rounded-full"
            style={{ background: "radial-gradient(circle, rgba(242,193,78,0.13), transparent 62%)" }}
          />
          <Reveal className="reveal-celestial">
            <h2 className={`${HEADING} text-[clamp(28px,3.8vw,42px)]`}>
              One address. Occasional news.
            </h2>
          </Reveal>
          <Reveal className="reveal-celestial" delay={90}>
            <p className="mx-auto mt-4 max-w-[42ch] text-base leading-relaxed text-[#9aada8]">
              If you scrolled this far, the box is a click away.
            </p>
          </Reveal>
          <Reveal className="reveal-celestial mt-8 flex justify-center" delay={170}>
            {/* Back up to the form, not on to sign-up: one ask per page. */}
            <a
              href="#interest-join"
              className="inline-flex items-center justify-center rounded-full bg-[#e8f3f1] px-6 py-3 text-sm font-medium text-[#0f3d3e] transition-colors hover:bg-white"
            >
              Join the list
            </a>
          </Reveal>
        </section>
      </main>

      <MarketingFooter className="max-w-6xl px-6 md:px-10" />
    </div>
  );
}
