import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { cookies, headers } from "next/headers";
import { Reveal } from "@/components/motion/reveal";
import { LandingStarfield } from "@/components/landing/landing-visuals";
import { InterestHero, type HeroInitial } from "@/components/interest/interest-hero";
import { ReferralTracker } from "@/components/interest/referral-tracker";
import { RingsBackdrop } from "@/components/interest/rings-backdrop";
import { AppDemo } from "@/components/interest/app-demo/app-demo";
import { DemoPeek } from "@/components/interest/demo-peek";
import { SkyHint } from "@/components/interest/sky-hint";
import { FooterWordmark } from "@/components/landing/footer-wordmark";
import { FaqList, type FaqItem } from "@/components/marketing/faq-list";
import { FeaturePoll, type FeaturePollInitial } from "@/components/interest/feature-poll";
import { EarlyAccessPath } from "@/components/interest/early-access-path";
import { PillarArt, type PillarArtKind } from "@/components/interest/pillar-art";
import { getWaitlistOrigin, getWaitlistPageUrl } from "@/lib/app-url";
import {
  REFERRAL_TIERS,
  SHARE_TOKEN_MAX,
  SPOTS_PER_REFERRAL,
  TRACKER_SLOTS,
  buildTicketImageUrl,
  type InterestTicket,
} from "@/lib/interest-list";
import {
  getInterestProof,
  getInviterPlanet,
  getProgressByShareToken,
  getTicketByShareToken,
  type InterestProof,
} from "@/lib/interest-list-ticket";
import { getWaitlistDemoEnabled } from "@/lib/waitlist-demo";
import { getPollInitial } from "@/lib/waitlist-poll-votes";
import { POLL_VOTER_COOKIE } from "@/lib/waitlist-poll";
import { isWaitlistHostHeader } from "@/lib/waitlist-host";

// The proof line, the invited strip and the pass all come from the URL and the database
// on every request. The proof memo (60 s) keeps the count query off the hot path.
export const dynamic = "force-dynamic";

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

/**
 * THE WAITLIST LEADS NOWHERE. It goes out to a large audience before the product is
 * public, so beyond the "Orbit" mark top left it links to nothing but itself, its
 * privacy notice and the share targets. On its own domain (`WAITLIST_HOST`) it is served
 * at `/`, and every other path there redirects back to it — see `lib/waitlist-host.ts`.
 * Keep it that way: no nav, no sign-in, no "learn more". The mark's image is a copy under
 * `public/waitlist/`, the one folder the waitlist host serves; `/orbit-logo.png` redirects.
 * The "Take it for a spin" demo (`components/interest/app-demo/`) is a self-contained fake
 * of the app on a made-up network: it links nowhere and loads nothing outside `/waitlist/`.
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

const SECTION_TITLE = `${HEADING} text-[clamp(26px,3.4vw,38px)]`;

/**
 * A section with its heading beside the content rather than above it, used to break the
 * page's run of centred stacks. `side` is where the heading sits from `lg`; below that the
 * two stack, heading first and centred, like every other section. The heading is always
 * first in the DOM — only the visual order flips — so a screen reader or a keyboard meets
 * it before the content. It sticks beside a long column (the FAQ, answers open).
 */
function SplitSection({
  id,
  title,
  blurb,
  side,
  children,
}: {
  id: string;
  title: string;
  blurb: string;
  side: "left" | "right";
  children: React.ReactNode;
}) {
  const right = side === "right";
  return (
    <section
      className={`mt-24 md:mt-32 lg:grid lg:items-start lg:gap-16 ${
        right ? "lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]" : "lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]"
      }`}
      aria-labelledby={id}
    >
      <div className={`text-center lg:sticky lg:top-24 lg:text-left ${right ? "lg:order-2" : ""}`}>
        <Reveal className="reveal-celestial">
          <h2 id={id} className={SECTION_TITLE}>
            {title}
          </h2>
        </Reveal>
        <Reveal className="reveal-celestial" delay={80}>
          <p className="mx-auto mt-3 max-w-[48ch] text-base leading-relaxed text-[#9aada8] lg:mx-0">
            {blurb}
          </p>
        </Reveal>
      </div>
      <Reveal className="reveal-celestial mt-10 block lg:mt-0" delay={120}>
        {children}
      </Reveal>
    </section>
  );
}

/** What the proof line degrades to if the database read fails: count 0 stays below the
 * floor, so the count itself is hidden. */
const EMPTY_PROOF: InterestProof = { count: 0, total: 0, recent: [] };

/** What the poll degrades to if the database read fails: nothing voted, nothing tallied. */
const EMPTY_POLL: FeaturePollInitial = { results: { counts: {} }, choice: null };

const PILLARS: readonly { art: PillarArtKind; title: string; body: string }[] = [
  {
    art: "network",
    title: "One intelligence, your whole network",
    body: "Everyone you know, finally in one place that understands them.",
  },
  {
    art: "ahead",
    title: "Always a step ahead",
    body: "An advanced recommendation engine reads your whole network and tells you who to reach, and when — before the moment slips by.",
  },
  {
    art: "tools",
    title: "Works with the tools you already use",
    body: "It plugs into your inbox, your calendar and the apps you rely on every day. No starting from scratch.",
  },
];

const STEPS = [
  { title: "Join the waitlist", body: "One email address. That's all it takes to hold your place." },
  {
    title: "We open in waves",
    body: "Spots open a few at a time, in line order. Friends you invite move you up.",
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
      a: "We're rolling out in waves over the coming weeks, in line order. The earlier you join, and the more friends you bring, the earlier your wave.",
    },
    {
      q: "How do I move up the line?",
      a: `Share your invite link. Each friend who joins through it moves you up ${SPOTS_PER_REFERRAL} spots, and the more friends you bring, the more you unlock: ${REFERRAL_TIERS.filter((t) => t.at >= 3)
        .map((t) => `${t.perk} at ${t.at}`)
        .join(", ")}.`,
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
  const voterId = await readVoterId();
  const [proof, ticket, showDemo, poll, friendPlanets] = await Promise.all([
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
    // The admin console's switch. Never throws: a failed read shows the demo.
    getWaitlistDemoEnabled(),
    getPollInitial({ me, voterId }).catch((err: unknown) => {
      console.error("[interest] poll read failed", err);
      return EMPTY_POLL;
    }),
    // The tracker draws each friend's planet; without them it falls back to plain gold.
    me
      ? getProgressByShareToken(me)
          .then((p) => p?.friendPlanets ?? [])
          .catch((err: unknown) => {
            console.error("[interest] friend planets read failed", err);
            return [];
          })
      : Promise.resolve([]),
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
    // renders position:fixed, so this root must stay free of transform/filter. It clips BOTH
    // axes: the closing section's 720px glow hangs below the footer, and clipping only x
    // left that overhang as dead scroll under the page.
    <div className="landing-root relative overflow-clip bg-[#03050c] text-[#e8f3f1]">
      <LandingStarfield interactive />
      <SkyHint />

      {/* Overlaid, not in flow: the page below sits exactly where it did without it. The
          hero's eyebrow starts 64px down on phones (main pt-6 + hero pt-10) and 104px from
          md; this row ends at 48px / 64px, so it never touches it. */}
      <header className="absolute inset-x-0 top-0 z-20 mx-auto flex w-full max-w-6xl items-center px-6 pt-4 md:px-10 md:pt-8">
        <div className="flex items-center gap-2.5">
          <Image
            src="/waitlist/logo.png"
            alt=""
            width={32}
            height={32}
            priority
            className="shrink-0 rounded-full"
          />
          <span className="font-[family-name:var(--font-display)] text-xl font-bold tracking-tight text-[#e8f3f1]">
            Orbit
          </span>
        </div>
      </header>

      <main className="relative z-10 mx-auto w-full max-w-6xl px-6 pb-20 pt-6 md:px-10 md:pt-10">
        <div className="relative">
          <RingsBackdrop />
          <InterestHero initial={initial} pageUrl={getWaitlistPageUrl()} pagePath={pagePath} />
        </div>

        <Reveal className="reveal-celestial mt-20 block">
          {/* No backdrop blur: the sky under these moves every frame (see the panel note in
              globals.css). A faint fill reads as a surface without it. */}
          <ul className="grid gap-4 sm:grid-cols-3">
            {PILLARS.map(({ art, title, body }) => (
              <li
                key={title}
                className="pillar-card rounded-2xl border border-[#e8f3f1]/[0.07] bg-[linear-gradient(180deg,rgba(232,243,241,0.04),rgba(232,243,241,0.01))] p-5 transition-colors duration-300 hover:border-[#f2c14e]/25"
              >
                <PillarArt kind={art} />
                <h3 className="mt-4 font-[family-name:var(--font-display)] text-lg leading-snug text-[#e8f3f1]">
                  {title}
                </h3>
                <p className="mt-1.5 text-sm leading-relaxed text-[#9aada8]">{body}</p>
              </li>
            ))}
          </ul>
        </Reveal>

        <section className="mt-24 md:mt-32" aria-labelledby="waitlist-referrals">
          <Reveal className="reveal-celestial">
            <h2 id="waitlist-referrals" className={`${HEADING} text-center text-[clamp(26px,3.4vw,38px)]`}>
              Bring friends, move up.
            </h2>
          </Reveal>
          <Reveal className="reveal-celestial" delay={80}>
            <p className="mx-auto mt-3 max-w-[48ch] text-center text-base leading-relaxed text-[#9aada8]">
              Every friend who joins through your link moves you up {SPOTS_PER_REFERRAL} spots, and
              the first {TRACKER_SLOTS} unlock more along the way.
            </p>
          </Reveal>
          <Reveal className="reveal-celestial mt-10 block" delay={120}>
            <ReferralTracker
              token={ticket?.shareToken ?? null}
              referrals={ticket?.referrals ?? 0}
              position={ticket?.position ?? null}
              friendPlanets={ticket ? friendPlanets : []}
              joinHref="#interest-join"
            />
          </Reveal>
        </section>

        {/* An admin can hide the demo from /admin/growth/interest-list. */}
        {showDemo && (
          <>
            {/* Desktop only: the demo is a desktop window, and phones never fetch its chunk. */}
            <section className="mt-32 hidden md:block" aria-labelledby="waitlist-demo">
              <Reveal className="reveal-celestial">
                <h2 id="waitlist-demo" className={`${HEADING} text-center text-[clamp(26px,3.4vw,38px)]`}>
                  Take it for a spin.
                </h2>
              </Reveal>
              <Reveal className="reveal-celestial" delay={80}>
                <p className="mx-auto mt-3 max-w-[48ch] text-center text-base leading-relaxed text-[#9aada8]">
                  A working preview with a made-up network. Watch the tour, or click anything to take over.
                </p>
              </Reveal>
              <div className="mt-10">
                <AppDemo />
              </div>
            </section>

            {/* Phones: stills of the same demo to swipe through. */}
            <section className="mt-24 md:hidden" aria-labelledby="waitlist-peek">
              <Reveal className="reveal-celestial">
                <h2 id="waitlist-peek" className={`${SECTION_TITLE} text-center`}>
                  Take a peek.
                </h2>
              </Reveal>
              <Reveal className="reveal-celestial" delay={80}>
                <p className="mx-auto mt-3 max-w-[48ch] text-center text-base leading-relaxed text-[#9aada8]">
                  A preview with a made-up network. Swipe through.
                </p>
              </Reveal>
              <Reveal className="reveal-celestial mt-8 block" delay={120}>
                <DemoPeek />
              </Reveal>
            </section>
          </>
        )}

        {/* A lighter band than the panels around it, so a slightly shorter lead-in. */}
        <section className="mt-24 md:mt-28" aria-labelledby="waitlist-how">
          <Reveal className="reveal-celestial">
            <h2 id="waitlist-how" className={`${SECTION_TITLE} text-center`}>
              How early access works.
            </h2>
          </Reveal>
          <Reveal className="reveal-celestial mt-12 block" delay={80}>
            <EarlyAccessPath steps={STEPS} />
          </Reveal>
        </section>

        <SplitSection
          id="waitlist-poll"
          side="left"
          title="What should we release first?"
          blurb="Vote for the one you want most, and see what everyone else picked."
        >
          <FeaturePoll initial={poll} me={me} />
        </SplitSection>

        <SplitSection
          id="waitlist-faq"
          side="right"
          title="A few answers."
          blurb="What to expect while you wait for your wave."
        >
          <FaqList items={faq(privacyHref)} columns={1} />
        </SplitSection>

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

      <footer className="relative z-10 mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-6 pb-6 text-xs text-[#6d807c] md:px-10">
        <span>© {new Date().getFullYear()}</span>
        <Link href={privacyHref} className="transition-colors hover:text-[#9aada8]">
          Privacy
        </Link>
      </footer>

      {/* The landing page's closing frame: "Orbit" in star dots, cut off by the bottom of the
          page, so nothing may follow it. Its own stacking context lets the vignette sit
          behind it without dropping under the page background. */}
      <div className="relative z-10">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-[520px] bg-[linear-gradient(to_bottom,transparent_0%,rgba(0,2,8,0.55)_55%,#00010a_100%)]"
        />
        <div className="px-6 md:px-10">
          <FooterWordmark className="relative mx-auto max-w-6xl" />
        </div>
      </div>
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

/**
 * The poll's voter cookie, or null. Outside a request — the page smoke renders this
 * function directly — there is no cookie store, which reads as "hasn't voted".
 */
async function readVoterId() {
  try {
    return (await cookies()).get(POLL_VOTER_COOKIE)?.value ?? null;
  } catch {
    return null;
  }
}
