import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { Clock3, Network, ShieldCheck } from "lucide-react";
import { Reveal } from "@/components/motion/reveal";
import { LandingStarfield } from "@/components/landing/landing-visuals";
import { InterestHero, type HeroInitial } from "@/components/interest/interest-hero";
import { RingsBackdrop } from "@/components/interest/rings-backdrop";
import { FaqList, type FaqItem } from "@/components/marketing/faq-list";
import { getWaitlistOrigin, getWaitlistPageUrl } from "@/lib/app-url";
import {
  FRONT_WAVE_REFERRALS,
  SHARE_TOKEN_MAX,
  buildTicketImageUrl,
  type InterestTicket,
} from "@/lib/interest-list";
import {
  getInterestProof,
  getInviterPlanet,
  getTicketByShareToken,
  type InterestProof,
} from "@/lib/interest-list-ticket";
import { isWaitlistHostHeader } from "@/lib/waitlist-host";

// The proof line, the invited strip and the pass all come from the URL and the database
// on every request. The proof memo (60 s) keeps the count query off the hot path.
export const dynamic = "force-dynamic";

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

/**
 * THE WAITLIST IS UNBRANDED AND LEADS NOWHERE. It goes out to a large audience before the
 * product is public, so this page names no product, shows no logo, describes nothing it
 * does beyond one line, and links to nothing but itself, its privacy notice and the share
 * targets. On its own domain (`WAITLIST_HOST`) it is served at `/`, and every other path
 * there redirects back to it — see `lib/waitlist-host.ts`. Keep it that way: no header,
 * no footer nav, no sign-in, no "learn more".
 */
const TITLE = "Early access — the future of networking";
const DESCRIPTION =
  "A central intelligence for everyone you know. Join the waitlist for early access — we're opening in waves.";

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
  const origin = getWaitlistOrigin();
  const base: Metadata = {
    title: TITLE,
    description: DESCRIPTION,
    metadataBase: new URL(origin),
    // Replaces the root layout's icon list, which names the product's logo file. The
    // file-based icons (`app/favicon.ico`, `icon.png`) are still linked; the waitlist host
    // rewrites those URLs to this same planet.
    icons: { icon: "/waitlist/icon.png", apple: "/waitlist/icon.png" },
  };
  // A shared `?ref=` link previews with the sharer's planet; so does a `?me=` pass.
  const token = tokenParam(params.ref) ?? tokenParam(params.me);
  let planetKnown = false;
  if (token) {
    try {
      planetKnown = (await getInviterPlanet(token)) !== null;
    } catch (err) {
      console.error("[interest] planet lookup failed in metadata", err);
    }
  }
  const image = planetKnown
    ? buildTicketImageUrl(origin, token!)
    : `${origin}/api/interest-list/ticket-image`;
  return {
    ...base,
    openGraph: {
      title: TITLE,
      description: DESCRIPTION,
      images: [{ url: image, width: 1200, height: 630 }],
    },
    twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION, images: [image] },
  };
}

const HEADING =
  "font-[family-name:var(--font-display)] font-normal leading-[1.12] tracking-[-0.025em] text-[#e8f3f1]";

/** What the proof line degrades to if the database read fails: count 0 stays below the
 * floor, so the count itself is hidden. */
const EMPTY_PROOF: InterestProof = { count: 0, total: 0, recent: [] };

/** High level on purpose: what it is for, never what it does or how. */
const PILLARS = [
  {
    icon: Network,
    title: "One intelligence, your whole network",
    body: "Everyone you know, finally in one place that understands them.",
  },
  {
    icon: Clock3,
    title: "Always a step ahead",
    body: "It knows who matters, and when — so the right moment never slips by.",
  },
  {
    icon: ShieldCheck,
    title: "Private by design",
    body: "Your network is yours. It stays that way.",
  },
];

const STEPS = [
  { title: "Join the waitlist", body: "One email address. That's all it takes to hold your place." },
  {
    title: "We open in waves",
    body: "The front wave goes first, then everyone else in the order they joined.",
  },
  { title: "Your invite arrives", body: "When your wave opens, your invite lands in your inbox." },
];

function faq(privacyHref: string): readonly FaqItem[] {
  return [
    {
      q: "What is it?",
      a: "A new kind of networking tool, built around a central intelligence. We're keeping the details under wraps until your wave opens.",
    },
    {
      q: "When do I get in?",
      a: "We're rolling out in waves over the coming weeks. The front wave goes first; everyone else follows in the order they joined.",
    },
    {
      q: "How do I get into the front wave?",
      a: `Share your invite link. When ${FRONT_WAVE_REFERRALS} friends join through it, you're in.`,
    },
    {
      q: "What happens to my email?",
      a: (
        <>
          We use it to hold your place and send your invite — never shared or sold. Every email
          has a link to leave the waitlist. The details are in the{" "}
          <Link href={privacyHref}>privacy notice</Link>.
        </>
      ),
    },
  ];
}

/**
 * Dynamic: the card's state comes from `?me=` (a pass) or `?ref=` (an invitation), and
 * the proof line from the database. The form talks to `joinInterestList` directly.
 */
export default async function InterestPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const me = tokenParam(params.me);

  // Served at `/` on the waitlist's own domain, at `/interest` anywhere else (local
  // development, the app host before stealth). Links on the page follow suit.
  const onWaitlistHost = await servedOnWaitlistHost();
  const pagePath = onWaitlistHost ? "/" : "/interest";
  const privacyHref = onWaitlistHost ? "/privacy" : "/interest/privacy";

  // The proof line never depends on either token, so it runs alongside the pass.
  const [proof, ticket] = await Promise.all([
    getInterestProof().catch((err: unknown) => {
      console.error("[interest] proof read failed", err);
      return EMPTY_PROOF;
    }),
    me
      ? getTicketByShareToken(me).catch((err: unknown): InterestTicket | null => {
          console.error("[interest] ticket lookup failed", err);
          return null;
        })
      : Promise.resolve(null),
  ]);

  // `?ref=` loses to a pass that actually RESOLVED, not to the mere presence of `?me=`: a
  // stale or mistyped `me` must not discard a perfectly good invitation.
  const ref = ticket ? null : tokenParam(params.ref);
  const invite = ref
    ? await getInviterPlanet(ref).catch((err: unknown) => {
        console.error("[interest] inviter lookup failed", err);
        return null;
      })
    : null;

  const initial: HeroInitial = ticket
    ? { kind: "ticket", proof, ticket }
    : { kind: "form", proof, invite, ref: invite ? ref : null };

  return (
    // `landing-root` is load-bearing: globals.css paints the body deep-space while it is
    // mounted, which is what stops a light strip appearing on overscroll. The starfield
    // renders position:fixed, so this root must stay free of transform/filter.
    <div className="landing-root relative overflow-x-clip bg-[#03050c] text-[#e8f3f1]">
      <LandingStarfield interactive />

      <main className="relative z-10 mx-auto w-full max-w-6xl px-6 pb-20 pt-6 md:px-10 md:pt-10">
        <div className="relative">
          <RingsBackdrop />
          <InterestHero
            initial={initial}
            pageUrl={getWaitlistPageUrl()}
            pagePath={pagePath}
            socialShare={!onWaitlistHost}
          />
        </div>

        <Reveal className="reveal-celestial mt-20 block">
          <ul className="grid gap-6 sm:grid-cols-3">
            {PILLARS.map(({ icon: Icon, title, body }) => (
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

        <section className="mt-24 md:mt-32" aria-labelledby="waitlist-how">
          <Reveal className="reveal-celestial">
            <h2 id="waitlist-how" className={`${HEADING} text-center text-[clamp(26px,3.4vw,38px)]`}>
              How early access works.
            </h2>
          </Reveal>
          <Reveal className="reveal-celestial mt-10 block" delay={80}>
            <ol className="grid gap-4 sm:grid-cols-3">
              {STEPS.map((step, i) => (
                <li key={step.title} className="landing-glass rounded-2xl p-5">
                  <p className="font-[family-name:var(--font-display)] text-2xl text-landing-accent">
                    {i + 1}
                  </p>
                  <h3 className="mt-2 text-sm font-medium text-[#e8f3f1]">{step.title}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-[#9aada8]">{step.body}</p>
                </li>
              ))}
            </ol>
          </Reveal>
        </section>

        <section className="mt-24 md:mt-32" aria-labelledby="waitlist-faq">
          <Reveal className="reveal-celestial">
            <h2 id="waitlist-faq" className={`${HEADING} text-center text-[clamp(26px,3.4vw,38px)]`}>
              A few answers.
            </h2>
          </Reveal>
          <Reveal className="reveal-celestial mt-10 block" delay={80}>
            <FaqList items={faq(privacyHref)} />
          </Reveal>
        </section>

        <section className="relative mt-24 text-center md:mt-32">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute left-1/2 top-1/2 -z-10 h-[720px] w-[720px] -translate-x-1/2 -translate-y-1/2 rounded-full"
            style={{ background: "radial-gradient(circle, rgba(242,193,78,0.13), transparent 62%)" }}
          />
          <Reveal className="reveal-celestial">
            <h2 className={`${HEADING} text-[clamp(28px,3.8vw,42px)]`}>Be among the first.</h2>
          </Reveal>
          <Reveal className="reveal-celestial" delay={90}>
            <p className="mx-auto mt-4 max-w-[42ch] text-base leading-relaxed text-[#9aada8]">
              The earlier you join, the earlier your wave.
            </p>
          </Reveal>
          <Reveal className="reveal-celestial mt-8 flex justify-center" delay={170}>
            <a
              href="#interest-join"
              className="inline-flex items-center justify-center rounded-full bg-[#e8f3f1] px-6 py-3 text-sm font-medium text-[#0f3d3e] transition-colors hover:bg-white"
            >
              {ticket ? "Back to your pass" : "Join the waitlist"}
            </a>
          </Reveal>
        </section>
      </main>

      <footer className="relative z-10 mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-6 pb-10 text-xs text-[#6d807c] md:px-10">
        <span>© {new Date().getFullYear()}</span>
        <Link href={privacyHref} className="transition-colors hover:text-[#9aada8]">
          Privacy
        </Link>
      </footer>
    </div>
  );
}

/**
 * Whether this request came in on the waitlist's own domain. Outside a request — the page
 * smoke renders this function directly — there is no host, which reads as the app's.
 */
async function servedOnWaitlistHost() {
  let host: string | null = null;
  try {
    host = (await headers()).get("host");
  } catch {
    return false;
  }
  return isWaitlistHostHeader(host);
}
