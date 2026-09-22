import type { Metadata } from "next";
import { Eye, MousePointerClick, Sparkles, UserCheck } from "lucide-react";
import {
  DocBody,
  DocCallout,
  DocFooterCta,
  DocHero,
  DocHighlights,
  DocSection,
  MarketingDocShell,
} from "@/components/marketing/marketing-doc";
import { isClerkConfigured, isDemoMode } from "@/lib/auth";

/**
 * What the extension opens on install: pin it, sign in once, and what it does
 * and does not read.
 *
 * In the Clerk-free `(site)` group and fully static, so it renders for someone
 * who installed the extension before ever signing in — which is most people
 * arriving from the Web Store. The same document chrome as /connect, with no
 * legal switcher, for the same reason.
 *
 * Every claim in "What it reads" is a promise the code keeps (extension/README.md,
 * "What it deliberately does not do"); change one only with the other.
 */
export const metadata: Metadata = {
  title: "The Orbit browser extension — Orbit",
  description:
    "Pin Orbit, sign in once, and see who you already know on LinkedIn, GitHub, Gmail and any page you read — saved to Orbit in one click.",
  // A page for people who just installed it, not a landing page.
  robots: { index: false },
};

const HIGHLIGHTS = [
  {
    icon: UserCheck,
    title: "Knows who you know",
    body: "Open a profile and Orbit says whether they're already in your network — and what you last talked about.",
  },
  {
    icon: MousePointerClick,
    title: "One click to save",
    body: "Someone new? Their name, title and company come off the page. Add a note or a follow-up in the same breath.",
  },
  {
    icon: Eye,
    title: "Reads only when you ask",
    body: "It reads the tab you clicked, when you click. Nothing runs in the background and nothing is added to the page.",
  },
  {
    icon: Sparkles,
    title: "Free on every plan",
    body: "Recognizing, saving, notes and follow-ups are free. Pro adds AI opening lines, smart search, work history and company lookup.",
  },
] as const;

const TOC = [
  { id: "pin", label: "Pin it" },
  { id: "sign-in", label: "Sign in once" },
  { id: "use", label: "Use it" },
  { id: "reads", label: "What it reads" },
  { id: "plans", label: "Free and Pro" },
] as const;

export default function ExtensionWelcomePage() {
  return (
    <MarketingDocShell clerkOn={isClerkConfigured()} demoMode={isDemoMode()} switcher={false}>
      <DocHero
        eyebrow="Browser extension"
        title="Orbit is installed"
        lede={
          <>
            It lives in Chrome&apos;s side panel, beside whatever you&apos;re reading. Pin it, sign
            in once, and the people you meet online land in the same network as everyone else.
          </>
        }
        meta={[
          { label: "Plans", value: "All, including free" },
          { label: "Shortcut", value: "⌘⇧O · Ctrl+Shift+O" },
        ]}
      />

      <DocHighlights kicker="What it does" items={HIGHLIGHTS} />

      <DocBody toc={TOC}>
        <DocSection id="pin" index={1} title="Pin it">
          <ol>
            <li>Click the puzzle-piece icon at the right of Chrome&apos;s toolbar.</li>
            <li>Click the pin beside Orbit, so its icon stays one click away.</li>
          </ol>
        </DocSection>

        <DocSection id="sign-in" index={2} title="Sign in once">
          <p>
            Click the Orbit icon and the side panel opens. If you&apos;re signed in to Orbit in
            this browser, it picks that session up by itself. If not, it asks you to sign in —
            once, in a normal Orbit tab — and then carries on.
          </p>
        </DocSection>

        <DocSection id="use" index={3} title="Use it">
          <p>
            On any page, click the icon or press <code>⌘⇧O</code> (<code>Ctrl+Shift+O</code> on
            Windows).
          </p>
          <ul>
            <li>
              <strong>A profile</strong> — LinkedIn, GitHub, X, or someone&apos;s own site: whether
              you know them, and if not, their details ready to save.
            </li>
            <li>
              <strong>A page of people</strong> — a LinkedIn search, a company&apos;s People tab, a
              team page: who&apos;s on it, marked known or new. Pick one at a time.
            </li>
            <li>
              <strong>A company</strong> — how many people you know there now, and who used to be.
            </li>
            <li>
              <strong>Anything else</strong> — what&apos;s due today, search, and a quick note
              about anyone.
            </li>
          </ul>
          <p>
            Right-click works too: <em>Look up in Orbit</em> on a profile link, and{" "}
            <em>Save to Orbit as a note</em> on text you&apos;ve selected.
          </p>
        </DocSection>

        <DocSection id="reads" index={4} title="What it reads, and when">
          <p>
            Only the tab you clicked, and only when you click. Clicking the icon is what lets it
            read that page; it can&apos;t read or fetch any site in the background, and it never
            adds anything to the pages you visit. It doesn&apos;t click, scroll or expand anything
            either — it reads what&apos;s already on your screen.
          </p>
          <p>
            What it reads is used to work out who the page is about. Orbit keeps what you choose
            to save — a name, a title, their roles — never the page itself. A right-clicked link
            sends only the link; the page behind it is never opened.
          </p>
          <DocCallout title="Following you, if you want it">
            In the extension&apos;s settings you can let it follow you on LinkedIn, X, Gmail or
            GitHub, so it updates as you browse there without a click. It&apos;s off until you
            turn it on, and you can turn it off from the same list.
          </DocCallout>
        </DocSection>

        <DocSection id="plans" index={5} title="Free and Pro">
          <p>
            Every plan: recognizing the people you know, saving new ones, notes, follow-ups,
            reminders, search by name, and right-click.
          </p>
          <p>
            Orbit Pro and Lifetime add AI-written opening lines (with your own AI key), smart
            search that finds people by what you know about them, work history read from their
            LinkedIn, and who you know at any company you look at.
          </p>
        </DocSection>
      </DocBody>

      <DocFooterCta
        title="Click the Orbit icon on the next profile you open"
        body="That's the whole setup. Everything it saves shows up in Orbit, with everyone else you know."
        primary={{ href: "/dashboard", label: "Open Orbit" }}
        secondary={{ href: "/pricing", label: "See plans" }}
      />
    </MarketingDocShell>
  );
}
