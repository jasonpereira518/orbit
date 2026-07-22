import type { Metadata } from "next";
import Link from "next/link";
import { OrbitLogo } from "@/components/orbit-logo";

export const metadata: Metadata = {
  title: "Privacy Policy — Orbit",
  description:
    "How Orbit collects, uses, and shares data for your personal networking tracker.",
};

const LAST_UPDATED = "July 21, 2026";

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="mx-auto flex w-full max-w-3xl items-center justify-between px-6 py-5 md:px-8">
        <Link
          href="/"
          className="flex items-center gap-2.5 transition-opacity hover:opacity-80"
        >
          <OrbitLogo size="sm" />
          <span className="font-[family-name:var(--font-display)] text-xl tracking-tight text-primary">
            Orbit
          </span>
        </Link>
        <Link
          href="/sign-in"
          className="text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          Sign in
        </Link>
      </header>

      <main className="mx-auto w-full max-w-3xl px-6 pb-16 md:px-8">
        <article className="space-y-10">
          <header className="space-y-3">
            <h1 className="font-[family-name:var(--font-display)] text-4xl tracking-tight text-primary sm:text-5xl">
              Privacy Policy
            </h1>
            <p className="text-sm text-muted-foreground">
              Last updated: {LAST_UPDATED}
            </p>
            <p className="text-base leading-relaxed text-muted-foreground">
              This page describes how Orbit, a personal networking tracker operated by
              the operators of Orbit, handles information when you use the product.
              It reflects current product behavior and may change as Orbit evolves.
            </p>
          </header>

          <Section title="Who we are">
            <p>
              Orbit helps you capture contacts, track relationships, import LinkedIn
              data, and use AI to organize follow-ups across your network. This
              Privacy Policy applies to the Orbit web application and related
              services we operate.
            </p>
          </Section>

          <Section title="Data we collect">
            <p>Depending on how you use Orbit, we may process:</p>
            <ul className="mt-3 list-disc space-y-2 pl-5">
              <li>
                <span className="text-foreground">Account information</span> —
                identity details from our authentication provider (Clerk), such as
                your user id, name, email address, and profile image.
              </li>
              <li>
                <span className="text-foreground">Network and CRM content</span> —
                contacts and related details you add or import (names, company,
                title, location, school, email, phone, LinkedIn URL, website,
                notes, tags, relationship scores, follow-up dates, and similar
                fields); interaction logs; goals; reminders; chat threads; calendar
                subscription metadata and synced events; outreach campaigns and
                messages; and LinkedIn CSV import metadata.
              </li>
              <li>
                <span className="text-foreground">Secrets you provide</span> —
                optional bring-your-own API keys for AI, enrichment, email, or SMS
                providers, stored encrypted at rest.
              </li>
              <li>
                <span className="text-foreground">Derived data</span> — AI-generated
                summaries, suggestions, embeddings, and similar artifacts created
                from content you store in Orbit.
              </li>
            </ul>
          </Section>

          <Section title="How we use data">
            <p>We use this information to:</p>
            <ul className="mt-3 list-disc space-y-2 pl-5">
              <li>Authenticate you and keep your data scoped to your account</li>
              <li>Provide the networking CRM, search, reminders, and graph features</li>
              <li>
                Run AI features you enable (parsing notes, chat, drafts, semantic
                search, suggestions)
              </li>
              <li>
                Support optional enrichment and outbound email or SMS when you
                configure those integrations
              </li>
              <li>Honor export, deletion, and account lifecycle requests</li>
            </ul>
          </Section>

          <Section title="Third parties">
            <p>
              Orbit relies on processors and optional integrations. Data may be sent
              to them only as needed for the features you use:
            </p>
            <ul className="mt-3 list-disc space-y-2 pl-5">
              <li>
                <span className="text-foreground">Clerk</span> — authentication and
                sessions
              </li>
              <li>
                <span className="text-foreground">Database host</span> — primary
                storage of your Orbit data (for example Neon when a hosted Postgres
                URL is configured)
              </li>
              <li>
                <span className="text-foreground">AI providers</span> — Google
                Gemini, OpenAI, and/or Anthropic, depending on your settings and
                keys
              </li>
              <li>
                <span className="text-foreground">Apollo</span> — optional people
                search and enrichment
              </li>
              <li>
                <span className="text-foreground">Resend</span> — optional outbound
                email
              </li>
              <li>
                <span className="text-foreground">Twilio</span> — optional outbound
                SMS
              </li>
              <li>
                <span className="text-foreground">Calendar providers</span> — when
                you subscribe via an ICS URL you provide
              </li>
              <li>
                <span className="text-foreground">LinkedIn</span> — user-initiated
                CSV imports and profile image fetches where applicable
              </li>
              <li>
                <span className="text-foreground">Google Fonts</span> — font delivery
                for the app UI
              </li>
            </ul>
            <p className="mt-3">
              We do not sell your personal information. Enabling AI, enrichment, or
              outreach features necessarily shares relevant content with those
              providers under their own terms.
            </p>
          </Section>

          <Section title="Cookies and local storage">
            <p>
              Orbit uses Clerk session cookies to keep you signed in. The app also
              stores preferences on your device via{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 text-sm">
                localStorage
              </code>
              , such as theme flash helpers, graph layout positions, and
              notification opt-in on this device. Delivered-notification history
              and account preferences are stored with your account. We do not use
              advertising pixels or third-party analytics trackers in the product
              today.
            </p>
          </Section>

          <Section title="AI processing">
            <p>
              When you use AI features, content from your network — such as notes,
              contact context, and chat prompts — may be sent to the AI provider
              configured in Settings. You can choose the provider and, where
              supported, supply your own API keys. Do not store information in Orbit
              that you are unwilling to send to those providers.
            </p>
          </Section>

          <Section title="Your rights and controls">
            <p>
              In Settings under{" "}
              <Link
                href="/settings"
                className="text-primary underline-offset-4 hover:underline"
              >
                Data and privacy
              </Link>
              , you can:
            </p>
            <ul className="mt-3 list-disc space-y-2 pl-5">
              <li>
                Export a JSON download of core Orbit data (contacts, interactions,
                reminders, tags, imports, and AI suggestions)
              </li>
              <li>Permanently delete all Orbit application data for your account</li>
            </ul>
            <p className="mt-3">
              The JSON export may not include every category of data (for example
              chat history, outreach records, embeddings, or calendar sync details).
              Deleting your Clerk account triggers removal of associated Orbit data
              via our account lifecycle webhook when configured.
            </p>
          </Section>

          <Section title="Retention">
            <p>
              We retain your Orbit data for as long as your account remains active
              or until you delete it using in-app controls or account deletion. After
              deletion, residual copies may persist briefly in backups or logs before
              they are purged in the ordinary course of operations.
            </p>
          </Section>

          <Section title="Children">
            <p>
              Orbit is not directed at children under 13, and we do not knowingly
              collect personal information from children under 13.
            </p>
          </Section>

          <Section title="Changes">
            <p>
              We may update this Privacy Policy as the product changes. The “Last
              updated” date at the top of this page will be revised when we do. Continued
              use of Orbit after changes means you accept the updated policy.
            </p>
          </Section>

          <Section title="Contact">
            <p>
              Questions about this Privacy Policy can be directed to the operators of
              Orbit. For data export or deletion, use the controls in Settings.
            </p>
          </Section>
        </article>

        <p className="mt-12 text-sm text-muted-foreground">
          <Link
            href="/"
            className="text-primary underline-offset-4 hover:underline"
          >
            Back to home
          </Link>
        </p>
      </main>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <h2 className="font-[family-name:var(--font-display)] text-2xl tracking-tight text-primary">
        {title}
      </h2>
      <div className="space-y-3 text-base leading-relaxed text-muted-foreground">
        {children}
      </div>
    </section>
  );
}
