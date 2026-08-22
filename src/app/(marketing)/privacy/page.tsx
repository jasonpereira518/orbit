import type { Metadata } from "next";
import Link from "next/link";
import { Download, ShieldCheck, Sparkles, Trash2 } from "lucide-react";
import {
  DocBody,
  DocCallout,
  DocCard,
  DocCardGrid,
  DocFooterCta,
  DocHero,
  DocHighlights,
  DocSection,
  MarketingDocShell,
  type Highlight,
} from "@/components/marketing/marketing-doc";
import type { TocItem } from "@/components/marketing/doc-toc";

export const metadata: Metadata = {
  title: "Privacy Policy — Orbit",
  description:
    "What Orbit collects, who it shares data with, and how to export or delete everything in your account.",
};

const LAST_UPDATED = "July 21, 2026";

const HIGHLIGHTS: readonly Highlight[] = [
  {
    icon: ShieldCheck,
    title: "Your network isn't a product",
    body: "Orbit doesn't sell personal information, run ad pixels, or ship third-party analytics trackers.",
  },
  {
    icon: Sparkles,
    title: "AI runs when you say so",
    body: "AI features are opt-in per provider, and you can bring your own API keys where they're supported.",
  },
  {
    icon: Download,
    title: "Export on demand",
    body: "One control in Settings produces a JSON download of your core Orbit data.",
  },
  {
    icon: Trash2,
    title: "Deletion is real deletion",
    body: "Wipe all Orbit application data for your account from Settings, or delete your account entirely.",
  },
];

const TOC: readonly TocItem[] = [
  { id: "scope", label: "Who this covers" },
  { id: "collect", label: "What we collect" },
  { id: "use", label: "How it's used" },
  { id: "third-parties", label: "Who else sees it" },
  { id: "ai", label: "AI processing" },
  { id: "cookies", label: "Cookies & storage" },
  { id: "controls", label: "Your controls" },
  { id: "retention", label: "Retention" },
  { id: "security", label: "Security" },
  { id: "transfers", label: "Where it's processed" },
  { id: "children", label: "Children" },
  { id: "changes", label: "Changes" },
  { id: "contact", label: "Questions" },
];

const PROCESSORS = [
  {
    name: "Clerk",
    badge: "Required",
    body: "Authentication, sessions, and account lifecycle. Holds your sign-in identity.",
  },
  {
    name: "Database host",
    badge: "Required",
    body: "Primary storage for your Orbit data — for example Neon, when a hosted Postgres URL is configured.",
  },
  {
    name: "Google Gemini, OpenAI, Anthropic",
    badge: "Optional",
    body: "AI features. Which one receives content depends on the provider and keys you configure in Settings.",
  },
  {
    name: "Apollo",
    badge: "Optional",
    body: "People search and contact enrichment, when you turn it on and supply a key.",
  },
  {
    name: "Resend",
    badge: "Optional",
    body: "Outbound email for outreach you compose and send from Orbit.",
  },
  {
    name: "Twilio",
    badge: "Optional",
    body: "Outbound SMS for outreach you compose and send from Orbit.",
  },
  {
    name: "Calendar providers",
    badge: "Optional",
    body: "Event sync, only for an ICS calendar URL you paste in yourself.",
  },
  {
    name: "LinkedIn",
    badge: "Optional",
    body: "CSV imports you initiate, and profile image fetches where applicable.",
  },
  {
    name: "Google Fonts",
    badge: "Required",
    body: "Font delivery for the interface.",
  },
] as const;

export default function PrivacyPage() {
  return (
    <MarketingDocShell active="/privacy">
      <DocHero
        eyebrow="Privacy"
        title="What Orbit knows, and what it does with it."
        lede="Orbit holds the working memory of your professional network — who you met, what you said, and who you still owe a reply. This page is the plain description of how that information is handled."
        meta={[
          { label: "Last updated", value: LAST_UPDATED },
          { label: "Applies to", value: "The Orbit web app" },
          { label: "Read time", value: "About 6 minutes" },
        ]}
      />

      <DocHighlights kicker="The short version" items={HIGHLIGHTS} />

      <DocBody toc={TOC}>
        <DocSection id="scope" index={1} title="Who this covers">
          <p>
            Orbit is a personal networking tracker: it captures contacts, keeps
            a history of your relationships, imports LinkedIn data, and uses AI
            to organise follow-ups. This policy applies to the Orbit web
            application and the services operated alongside it, and it describes
            how the product actually behaves today rather than how it might
            behave later.
          </p>
          <p>
            Orbit is built and run by one person, Jason Pereira. Where this
            policy says <strong>we</strong>, that is who it means.
          </p>
        </DocSection>

        <DocSection id="collect" index={2} title="What Orbit collects">
          <p>
            Almost everything in Orbit is there because you put it there.
            Depending on which features you use, the product may process:
          </p>
          <ul>
            <li>
              <strong>Account information</strong> — identity details from our
              authentication provider (Clerk): your user id, name, email
              address, and profile image.
            </li>
            <li>
              <strong>Network and CRM content</strong> — contacts and their
              details (name, company, title, location, school, email, phone,
              LinkedIn URL, website, notes, tags, relationship scores,
              follow-up dates and similar fields), interaction logs, goals,
              reminders, chat threads, calendar subscription metadata and
              synced events, outreach campaigns and messages, and LinkedIn CSV
              import metadata.
            </li>
            <li>
              <strong>Secrets you provide</strong> — optional bring-your-own API
              keys for AI, enrichment, email, or SMS providers. These are stored
              encrypted at rest.
            </li>
            <li>
              <strong>Derived data</strong> — AI-generated summaries,
              suggestions, embeddings, and similar artifacts computed from the
              content you store in Orbit.
            </li>
          </ul>
          <DocCallout title="Worth knowing">
            <p>
              Contact records are usually about other people. When you add or
              import someone, you are deciding what Orbit stores about them, and
              you remain responsible for having a lawful basis to keep it.
            </p>
          </DocCallout>
        </DocSection>

        <DocSection id="use" index={3} title="How that data is used">
          <p>Orbit uses the information above to:</p>
          <ul>
            <li>Authenticate you and keep every query scoped to your account</li>
            <li>
              Run the networking CRM itself — search, reminders, the
              relationship graph, and the dashboard
            </li>
            <li>
              Power the AI features you enable: parsing notes, chat, drafting
              outreach, semantic search, and suggestions
            </li>
            <li>
              Support optional enrichment and outbound email or SMS when you
              configure those integrations
            </li>
            <li>
              Honour export, deletion, and account lifecycle requests you make
            </li>
          </ul>
          <p>
            Orbit does not use your content to train models of its own, and does
            not build advertising profiles from it.
          </p>
        </DocSection>

        <DocSection id="third-parties" index={4} title="Who else touches your data">
          <p>
            Orbit relies on a small set of processors and optional integrations.
            Data reaches them only when a feature you are using requires it —
            everything marked optional stays dormant until you switch it on.
          </p>
          <DocCardGrid columns={2}>
            {PROCESSORS.map((processor) => (
              <DocCard
                key={processor.name}
                title={processor.name}
                badge={processor.badge}
              >
                {processor.body}
              </DocCard>
            ))}
          </DocCardGrid>
          <p>
            We do not sell your personal information. Enabling AI, enrichment,
            or outreach necessarily shares the relevant content with those
            providers, where it is then governed by their own terms and privacy
            policies.
          </p>
        </DocSection>

        <DocSection id="ai" index={5} title="AI processing">
          <p>
            When you use an AI feature, content from your network — notes,
            contact context, chat prompts — is sent to the provider configured
            in Settings. You choose that provider, and where supported you can
            supply your own API key so the request runs on your own account with
            that vendor.
          </p>
          <p>
            The practical implication is worth stating directly:{" "}
            <strong>
              don&apos;t store anything in Orbit you would be unwilling to send
              to your chosen AI provider
            </strong>
            . AI output can also be wrong or invented — review anything before
            you act on it or send it to a real person.
          </p>
        </DocSection>

        <DocSection id="cookies" index={6} title="Cookies and local storage">
          <p>
            Orbit uses Clerk session cookies to keep you signed in. The app also
            stores preferences on your device in{" "}
            <code>localStorage</code> — theme flash helpers, saved graph layout
            positions, and per-device notification opt-in. Delivered
            notification history and account preferences live with your account
            instead.
          </p>
          <p>
            There are no advertising pixels and no third-party analytics
            trackers in the product today.
          </p>
        </DocSection>

        <DocSection id="controls" index={7} title="Your controls">
          <p>
            In Settings, under{" "}
            <Link href="/settings">Data and privacy</Link>, you can:
          </p>
          <ul>
            <li>
              Export a JSON download of core Orbit data — contacts,
              interactions, reminders, tags, imports, and AI suggestions
            </li>
            <li>
              Permanently delete all Orbit application data for your account
            </li>
          </ul>
          <p>
            The JSON export may not cover every category of data — chat history,
            outreach records, embeddings, and calendar sync details can fall
            outside it. Deleting your Clerk account triggers removal of the
            associated Orbit data through our account lifecycle webhook where
            that webhook is configured.
          </p>
          <p>
            If you need something the in-app controls don&apos;t cover — a copy
            of data the export misses, or removal of a specific record — ask via
            the <Link href="/contact">contact page</Link>.
          </p>
        </DocSection>

        <DocSection id="retention" index={8} title="How long data is kept">
          <p>
            Your Orbit data is retained for as long as your account is active,
            or until you delete it with the in-app controls or by deleting your
            account. After deletion, residual copies may persist briefly in
            backups or operational logs before they are purged in the ordinary
            course.
          </p>
        </DocSection>

        <DocSection id="security" index={9} title="Security">
          <p>
            Traffic runs over HTTPS, every database query is scoped to your
            account id, and provider API keys you supply are encrypted at rest.
            Authentication and session handling are delegated to Clerk rather
            than rolled by hand.
          </p>
          <p>
            No system is perfectly secure, and Orbit is an early-stage product
            built by one person. Please use a strong, unique password on your
            account, and treat the API keys you paste into Settings with the
            same care you would anywhere else.
          </p>
        </DocSection>

        <DocSection id="transfers" index={10} title="Where data is processed">
          <p>
            Orbit&apos;s hosting, database, and AI providers operate globally,
            which means your data may be processed in countries other than the
            one you live in — most commonly the United States. Where you supply
            your own API keys, the processing location follows whatever you have
            configured with that vendor.
          </p>
        </DocSection>

        <DocSection id="children" index={11} title="Children">
          <p>
            Orbit is not directed at children under 13, and we do not knowingly
            collect personal information from them. If you believe a child has
            provided information to Orbit, get in touch and it will be removed.
          </p>
        </DocSection>

        <DocSection id="changes" index={12} title="Changes to this policy">
          <p>
            This policy will change as the product does. The{" "}
            <strong>Last updated</strong> date at the top of the page is revised
            whenever it happens, and material changes will be called out in the
            app. Continuing to use Orbit after a change means you accept the
            updated policy.
          </p>
        </DocSection>

        <DocSection id="contact" index={13} title="Questions">
          <p>
            Questions about this policy, or about what Orbit holds on you, can
            go to the operator of Orbit via the{" "}
            <Link href="/contact">contact page</Link>. For routine export or
            deletion, the Settings controls are faster than an email.
          </p>
        </DocSection>
      </DocBody>

      <DocFooterCta
        title="Prefer to check for yourself?"
        body="Export your data or wipe it entirely from the Data and privacy panel in Settings — no request required."
        primary={{ href: "/settings", label: "Open Settings" }}
        secondary={{ href: "/terms", label: "Read the terms" }}
      />
    </MarketingDocShell>
  );
}
