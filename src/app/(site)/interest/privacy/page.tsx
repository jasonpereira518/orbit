import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { getWaitlistOrigin } from "@/lib/app-url";
import { isWaitlistHostHeader } from "@/lib/waitlist-host";

/**
 * The waitlist's own privacy notice, served at `/privacy` on the waitlist domain.
 *
 * Not the product's privacy policy, deliberately: that one names every subprocessor and,
 * section by section, what the product does — exactly what the waitlist keeps quiet (see
 * `lib/waitlist-host.ts`). This covers only what the waitlist itself collects, which is
 * small, and says so plainly. Kept in step with `lib/interest-list-join.ts` (what a join
 * stores), `/api/track` (page views) and the email senders. HAVE IT REVIEWED before the
 * waitlist is sent out.
 */
export const metadata: Metadata = {
  title: "Privacy — early access waitlist",
  description: "What the early access waitlist collects, why, and how to leave.",
  metadataBase: new URL(getWaitlistOrigin()),
  icons: { icon: "/waitlist/icon.png", apple: "/waitlist/icon.png" },
};

export const dynamic = "force-dynamic";

const SECTIONS: ReadonlyArray<{ title: string; body: React.ReactNode }> = [
  {
    title: "What we collect",
    body: (
      <ul className="list-disc space-y-2 pl-5">
        <li>The email address you join with.</li>
        <li>
          Whose invite link brought you here, if any, so the person who shared it gets credit
          toward the front wave.
        </li>
        <li>
          How you found the page: the referring site and any campaign tags in the link you
          followed.
        </li>
        <li>
          Anonymous page-view counts — the page, rough location and device type. No cookies are
          set for this, and it is never tied to your email address.
        </li>
        <li>
          Your IP address, to rate-limit sign-ups and stop automated ones. It is kept apart
          from your email and used for nothing else.
        </li>
      </ul>
    ),
  },
  {
    title: "Why",
    body: "To hold your place in line, to count the friends who joined through your link, and to email you about your place and your invite. Nothing else.",
  },
  {
    title: "Who else sees it",
    body: "Only the service providers that host this site, deliver its email and report errors, and only to do those jobs. Your address is never sold, rented or shared for marketing.",
  },
  {
    title: "How long we keep it",
    body: "Until you leave the waitlist, or until early access opens and your invite has been sent. Leaving takes one click from any waitlist email.",
  },
  {
    title: "Questions, or deletion",
    body: "Reply to any waitlist email and it reaches a person. Ask us to delete your details and we will.",
  },
];

export default async function WaitlistPrivacyPage() {
  const onWaitlistHost = await servedOnWaitlistHost();
  const home = onWaitlistHost ? "/" : "/interest";

  return (
    <div className="landing-root relative min-h-dvh bg-[#03050c] text-[#e8f3f1]">
      <main className="mx-auto w-full max-w-2xl px-6 pb-20 pt-16 md:pt-24">
        <p className="text-xs uppercase tracking-[0.16em] text-landing-accent">
          Early access waitlist
        </p>
        <h1 className="mt-4 font-[family-name:var(--font-display)] text-[clamp(30px,4.4vw,44px)] font-normal leading-[1.12] tracking-[-0.025em]">
          Privacy
        </h1>
        <p className="mt-5 text-base leading-relaxed text-[#9aada8]">
          The waitlist collects very little. Here is all of it.
        </p>

        <div className="mt-12 space-y-10">
          {SECTIONS.map((section) => (
            <section key={section.title}>
              <h2 className="text-sm font-medium text-[#e8f3f1]">{section.title}</h2>
              <div className="mt-2 text-sm leading-relaxed text-[#9aada8]">{section.body}</div>
            </section>
          ))}
        </div>

        <p className="mt-14 text-sm">
          <Link
            href={home}
            className="text-landing-accent underline decoration-[#f2c14e]/35 underline-offset-4 transition-colors hover:decoration-[#f2c14e]/90"
          >
            Back to the waitlist
          </Link>
        </p>
      </main>
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
