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
  type Highlight,
} from "@/components/marketing/marketing-doc";
import type { TocItem } from "@/components/marketing/doc-toc";
import { GOOGLE_LIMITED_USE, GOOGLE_SCOPE_DISCLOSURES, LEGAL_LAST_UPDATED } from "@/lib/legal";
import { TIMELINE_DAILY_CONTACT_CAP } from "@/lib/timeline-cost";

export const metadata: Metadata = {
  title: "Privacy Policy — Orbit",
  description:
    "What Orbit collects, who it shares data with, what it does with Google data, and how to export or delete everything in your account.",
};

const LAST_UPDATED = LEGAL_LAST_UPDATED;

const HIGHLIGHTS: readonly Highlight[] = [
  { icon: ShieldCheck, title: "Your network isn't a product", body: "Orbit doesn't sell personal information or run ad pixels, and its traffic analytics set no cookies." },
  { icon: Sparkles, title: "AI runs on your key", body: "AI features are opt-in, you choose the provider, every call bills to a key you supply, and Settings shows what the last 30 days cost." },
  { icon: Download, title: "Export on demand", body: "One control in Settings produces a JSON download of your core Orbit data, on every plan including Free." },
  { icon: Trash2, title: "Deletion is real deletion", body: "Delete some or all of your data from Settings, or delete your account — which erases your data, keys and sign-in and cancels any subscription." },
];

const TOC: readonly TocItem[] = [
  { id: "scope", label: "Who this covers" },
  { id: "collect", label: "What we collect" },
  { id: "use", label: "How it's used" },
  { id: "google", label: "Google user data" },
  { id: "recruiters", label: "Recruiter scan & directory" },
  { id: "third-parties", label: "Who else sees it" },
  { id: "ai", label: "AI processing" },
  { id: "payments", label: "Payments" },
  { id: "cookies", label: "Cookies, storage & analytics" },
  { id: "controls", label: "Your controls" },
  { id: "retention", label: "Retention" },
  { id: "security", label: "Security" },
  { id: "operator-access", label: "Operator access" },
  { id: "transfers", label: "Where it's processed" },
  { id: "children", label: "Children" },
  { id: "changes", label: "Changes" },
  { id: "contact", label: "Questions" },
];

/** Every service that receives personal data, verified against the code on 2026-09-15. */
const PROCESSORS = [
  { name: "Clerk", badge: "Required", body: "Sign-in, sessions and account lifecycle. Holds your sign-in identity and records when you accepted these terms." },
  { name: "Vercel", badge: "Required", body: "Hosting, and file storage for contact photos, capture photos and feedback screenshots. Also runs Web Analytics and Speed Insights, which receive page addresses with ids and tokens removed." },
  { name: "Neon", badge: "Required", body: "The Postgres database that holds your Orbit data." },
  { name: "Sentry", badge: "Required", body: "Error reports: the error, where in the code it happened, the page and browser. Configured not to attach IP addresses or cookies, and with session replay off." },
  { name: "Slack", badge: "Required", body: "Operational alerts to the operator: job status, route names and error messages. An error message can occasionally include a value it was processing." },
  { name: "Better Stack", badge: "Required", body: "Uptime heartbeat. Receives a ping, no personal data." },
  { name: "unavatar.io", badge: "Automatic", body: "Looks up a public profile photo for contacts with a LinkedIn URL. Receives the LinkedIn username only." },
  { name: "Microlink", badge: "Automatic", body: "When unavatar.io has no photo, fetches the public preview image of the contact's LinkedIn profile URL." },
  { name: "Gravatar", badge: "Automatic", body: "Checks for a public avatar for a contact's email. Receives a one-way hash of the address, not the address." },
  { name: "Stripe", badge: "Optional", body: "Orbit Pro and Orbit Lifetime payments. Card details go to Stripe directly; Orbit stores a customer reference." },
  { name: "Google Gemini, OpenAI, Anthropic", badge: "Optional", body: "AI features, on the provider and key you choose in Settings: notes, chat, drafts, search indexing, transcription and reading pages you scan." },
  { name: "Wispr Flow", badge: "Optional", body: "Meeting transcription, only if you add a Wispr key." },
  { name: "Google", badge: "Optional", body: "Gmail, Contacts and Calendar, one permission per feature you turn on. See Google user data." },
  { name: "Microsoft", badge: "Optional", body: "Outlook contacts import, read-only. Orbit does not read Outlook mail." },
  { name: "Eventbrite", badge: "Optional", body: "Guest lists of events you host, through Eventbrite sign-in." },
  { name: "Luma", badge: "Optional", body: "Guest lists of events you host (with your Luma API key), and your personal Luma calendar link if you paste it." },
  { name: "Partiful", badge: "Optional", body: "Your personal Partiful calendar link, if you paste it, to list events you are going to." },
  { name: "Apollo", badge: "Optional", body: "People search and contact enrichment, with your Apollo key, or Orbit's on Pro." },
  { name: "Resend", badge: "Optional", body: "Email Orbit sends: the waitlist confirmation, messages you send through the contact page, and outreach you send from Orbit." },
  { name: "Twilio", badge: "Optional", body: "SMS outreach you send, through the Twilio account you connect." },
] as const;

export default function PrivacyPage() {
  return (
    <>
      <DocHero
        eyebrow="Privacy"
        title="What Orbit knows, and what it does with it."
        lede="Orbit holds the working memory of your professional network — who you met, what you said, and who you still owe a reply. This page is the plain description of how that information is handled."
        meta={[
          { label: "Last updated", value: LAST_UPDATED },
          { label: "Applies to", value: "The Orbit web app and browser extension" },
          { label: "Read time", value: "About 12 minutes" },
        ]}
      />

      <DocHighlights kicker="The short version" items={HIGHLIGHTS} />

      <DocBody toc={TOC}>
        <DocSection id="scope" index={1} title="Who this covers">
          <p>
            Orbit is a personal networking tracker: it captures contacts, keeps a history of your
            relationships, imports data you already have, and uses AI to organise follow-ups. This
            policy covers the Orbit web app, its browser extension and the services run alongside
            them, and describes how the product behaves today rather than how it might later.
          </p>
          <p>
            Orbit is built and run by one person, Jason Pereira. Where this policy says{" "}
            <strong>we</strong>, that is who it means.
          </p>
        </DocSection>

        <DocSection id="collect" index={2} title="What Orbit collects">
          <p>Almost everything in Orbit is there because you put it there. Depending on the features you use:</p>
          <ul>
            <li>
              <strong>Account information</strong> — from our sign-in provider, Clerk: your user id,
              name, email address and profile image; your plan; and when you accepted the Terms and
              which version.
            </li>
            <li>
              <strong>Network and CRM content</strong> — contacts and their details (name, company,
              title, location, school, email, phone, LinkedIn URL, website, notes, tags, closeness,
              follow-up dates), interactions, goals, reminders, chat threads, events, outreach
              campaigns and messages, recruiter records, and import history. When you capture notes,
              Orbit keeps the text and any photos you attach so you can look back at the original.
              Photos are resized and stripped of their metadata (including location) before they are
              stored; photos from a capture you never save are deleted after 24 hours.
            </li>
            <li>
              <strong>Voice and meetings</strong> — audio you record is sent to be transcribed and is
              not kept. The transcript is: a voice note becomes the text of your note, and a meeting
              keeps its transcript until you delete the meeting.
            </li>
            <li>
              <strong>Connected accounts</strong> — if you connect Google, Orbit reads only what the
              feature you turned on needs (see <a href="#google">Google user data</a>). Microsoft is
              used only to import Outlook contacts.
            </li>
            <li>
              <strong>The browser extension</strong> — when you open its panel on a LinkedIn profile,
              it sends that page&rsquo;s text to Orbit, which fills in a contact using your AI key. A
              contact is created only when you save it.
            </li>
            <li>
              <strong>Secrets you provide</strong> — API keys for AI, enrichment, email, SMS and
              transcription providers, and the tokens for accounts you connect. Encrypted at rest.
            </li>
            <li>
              <strong>Derived data</strong> — AI summaries, suggestions, embeddings (search indexes)
              and timeline events computed from what you store.
            </li>
            <li>
              <strong>Usage records</strong> — for each AI call: the feature, provider, model, token
              counts, an estimated cost, duration and whether it succeeded. Never the prompt or the
              reply. You can see your last 30 days in Settings under Integrations → AI provider.
            </li>
            <li>
              <strong>Page views</strong> — which pages are opened, when and for how long; device type;
              the referring site and campaign tags; and approximate location looked up from the IP
              address. Linked to your account while you are signed in. See{" "}
              <a href="#cookies">cookies, storage, and analytics</a>.
            </li>
          </ul>
          <DocCallout title="Worth knowing">
            <p>
              Contact records are usually about other people. When you add or import someone, you
              decide what Orbit stores about them, and you remain responsible for having a lawful
              basis to keep it. Recording a meeting captures everyone on the call, and many places
              require their consent first.
            </p>
          </DocCallout>
        </DocSection>

        <DocSection id="use" index={3} title="How that data is used">
          <p>Orbit uses the information above to:</p>
          <ul>
            <li>Authenticate you and keep every query scoped to your account</li>
            <li>Run the CRM itself — search, reminders, the relationship graph and the dashboard</li>
            <li>Power the AI features you use, on your key</li>
            <li>Run the imports, syncs, enrichment and outbound email or SMS you set up</li>
            <li>Look up public profile photos for your contacts</li>
            <li>Apply plan limits and process payments if you upgrade</li>
            <li>Understand which pages are read, where visitors arrive from, and which features get used</li>
            <li>Honour export, deletion and account requests</li>
          </ul>
          <p>
            Orbit does not use your content to train AI models, its own or anyone else&rsquo;s, and
            does not build advertising profiles from it.
          </p>
        </DocSection>
        <DocSection id="google" index={4} title="Google user data">
          <p>
            Orbit can connect to a Google account you choose. Each feature asks Google only for the
            permission it needs, at the moment you turn it on, and Google&rsquo;s own screen shows
            exactly what is being granted. You can allow one feature and decline another.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-[#e8f3f1]/[0.1] text-xs uppercase tracking-[0.12em] text-[#6d807c]">
                  <th scope="col" className="py-2 pr-4 font-normal">Permission</th>
                  <th scope="col" className="py-2 pr-4 font-normal">What Orbit does with it</th>
                  <th scope="col" className="py-2 font-normal">Asked for when</th>
                </tr>
              </thead>
              <tbody>
                {GOOGLE_SCOPE_DISCLOSURES.map((row) => (
                  <tr key={row.scope} className="border-b border-[#e8f3f1]/[0.06] align-top">
                    <td className="py-3 pr-4 text-[#e8f3f1]">{row.permission}</td>
                    <td className="py-3 pr-4 text-[#9aada8]">{row.use}</td>
                    <td className="py-3 text-[#9aada8]">{row.askedWhen}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p>
            {GOOGLE_LIMITED_USE.before}
            <a href={GOOGLE_LIMITED_USE.href}>{GOOGLE_LIMITED_USE.linkText}</a>
            {GOOGLE_LIMITED_USE.after}
          </p>
          <p>
            In practice: Orbit uses Google data only to provide the features in the table, shown to
            you inside Orbit. It does not sell it, does not use it for advertising, and does not use
            it to develop or train AI models. Where a feature uses AI (the recruiter scan), the text
            involved goes to the AI provider you chose, on your own key, only to produce the result
            you asked for. A person at Orbit reads Google data only with your permission for a
            support request you raise, to investigate abuse or a security problem, or where the law
            requires it.
          </p>
          <p>
            Disconnecting Google in Orbit deletes the tokens Orbit holds. To also revoke the grant
            on Google&rsquo;s side, remove Orbit from your Google Account&rsquo;s third-party access
            page.
          </p>
          <DocCallout title="Confirmation emails">
            <p>
              If you turn on event discovery from confirmation emails, Orbit searches your Gmail for
              mail from event platforms only — Luma, Partiful, Eventbrite, Meetup and Posh — and
              opens a message only when Google&rsquo;s signature check confirms it came from one of
              them. It keeps the event link, the subject line, the sender&rsquo;s domain and the
              date; it stores no message bodies, reads no other mail, and never sends this mail to
              an AI provider. Turning it off stops the scanning and removes what it recorded about
              where each event was found.
            </p>
          </DocCallout>
        </DocSection>

        <DocSection id="recruiters" index={5} title="The recruiter scan and the shared directory">
          <p>
            <strong>The scan.</strong> When you connect Gmail on the Recruiters page and press Scan,
            Orbit uses Gmail search to find messages that look like recruiting — terms such as
            &ldquo;recruiter&rdquo;, &ldquo;talent acquisition&rdquo; and &ldquo;open role&rdquo;,
            excluding newsletters and mailing lists. For each likely recruiter, up to 400 a scan, it
            sends the subject and text of up to five of their most recent messages, with their name
            and address, to the AI provider you chose, on your key. The model decides whether the
            sender is a recruiter and writes a short summary of the conversation.
          </p>
          <p>
            <strong>What is kept.</strong> For each recruiter found: their name, firm and email
            address; the companies and roles discussed; how many emails you exchanged and when; the
            latest thread id, so a reply can continue it; and the summary, which only you can see.
            Message bodies are not stored. The scan&rsquo;s work list — the name, address and Gmail
            message ids of every sender it considered — stays with the scan in your import history
            until you delete it.
          </p>
          <p>
            <strong>The shared directory.</strong> A recruiter&rsquo;s record has a shared core —
            name, firm, specialty, and work email, phone and LinkedIn when known — so two people
            who work with the same recruiter point at one record. Your notes, summaries and email
            threads stay yours. Sharing is off by default. If you turn it on in Recruiters, the
            recruiters you add (except any you exclude) join a pool: other people who also share can
            see those recruiters&rsquo; shared core and an average rating that includes yours, and
            you see theirs. Contact details on a shared record are shown to someone else only when
            that recruiter is in the pool and they share too. Turning sharing off takes your
            recruiters out of the pool.
          </p>
        </DocSection>

        <DocSection id="third-parties" index={6} title="Who else touches your data">
          <p>
            Orbit relies on the processors and integrations below. &ldquo;Required&rdquo; ones handle
            every account; &ldquo;Automatic&rdquo; ones run without a setting (photo lookups for
            contacts); &ldquo;Optional&rdquo; ones stay dormant until you use the feature.
          </p>
          <DocCardGrid columns={2}>
            {PROCESSORS.map((processor) => (
              <DocCard key={processor.name} title={processor.name} badge={processor.badge}>
                {processor.body}
              </DocCard>
            ))}
          </DocCardGrid>
          <p>
            We do not sell your personal information. Using AI, enrichment, sync or outreach shares
            the relevant content with those providers, where it is governed by their own terms and
            privacy policies.
          </p>
        </DocSection>

        <DocSection id="ai" index={7} title="AI processing">
          <p>
            When you use an AI feature, the content it needs — notes, contact context, chat prompts,
            meeting audio, photos of pages you scan, recruiter emails when you run the scan — is sent
            to the provider you configured. In production every call runs on an API key you supply,
            so the request lands on your own account with that vendor, under the retention terms you
            agreed with them.
          </p>
          <p>
            Some AI work runs in the background. Search indexing runs when contacts change, so search
            understands meaning. Importing LinkedIn messages writes a short summary for up to 40 of
            the people you talked with most. Deriving timeline events from imported LinkedIn
            conversations is off until you turn it on, shows an estimated cost first, skips threads
            with a single message, and processes at most {TIMELINE_DAILY_CONTACT_CAP} conversations
            a day. Settings → Integrations → AI provider shows every call from the last 30 days and
            its estimated cost.
          </p>
          <p>
            <strong>
              Don&rsquo;t store anything in Orbit you would be unwilling to send to your chosen AI
              provider
            </strong>
            . AI output can be wrong or invented — review anything before you act on it or send it
            to a real person.
          </p>
        </DocSection>

        <DocSection id="payments" index={8} title="Payments">
          <p>
            The Free Plan needs no payment details. Orbit Pro and Orbit Lifetime are sold through
            Stripe.
          </p>
          <p>
            <strong>Orbit never sees your card.</strong> Orbit stores a Stripe customer reference, your
            plan and subscription status, and a record of each charge, refund and dispute for its
            accounts. When you delete your account, that accounting record is kept with your account
            id removed. Pricing is on the <Link href="/pricing">pricing page</Link>.
          </p>
        </DocSection>
        <DocSection id="cookies" index={9} title="Cookies, local storage, and analytics">
          <p>
            Orbit uses Clerk session cookies to keep you signed in. On your very
            first visit it also sets one first-party cookie,{" "}
            <code>orbit_attr</code>, recording where you arrived from — the
            referring site and any campaign tags in the link — so we can tell
            which channels bring people here. It holds no personal information,
            is never shared, and expires after 90 days. The app also stores
            preferences on your device in <code>localStorage</code> —
            theme flash helpers, saved graph layout positions, and per-device
            notification opt-in. Delivered notification history and account
            preferences live with your account instead.
          </p>
          <p>
            Orbit counts its own traffic, and does it{" "}
            <strong>without cookies</strong>. Each page view records which page
            was opened, when, and for how long; whether it was on a desktop,
            phone, or tablet; the site that linked there and any campaign tags;
            and an approximate location — city, region, and country — looked up
            from the IP address. The IP address itself is not kept: Orbit&apos;s
            analytics reduces it, together with your browser type, to a one-way
            hash mixed with a value that changes every day, and stores only the
            hash. That hash cannot connect one day&apos;s visit to the next, and
            it cannot be turned back into an address from the data alone. To
            group the pages of a single visit, your browser holds a random
            session id in <code>sessionStorage</code>; it is discarded when you
            close the tab, and replaced after 30 minutes without a page view.
          </p>
          <p>
            For a signed-out visitor, that is all it is: a count of how many
            people read which pages on a given day, with no way to tell who they
            were.{" "}
            <strong>
              While you are signed in, your page views are also recorded against
              your account
            </strong>{" "}
            — which pages you open, when, and for how long. Only Orbit&apos;s
            operator can see them, in the internal console described under{" "}
            <a href="#operator-access">operator access</a>. They are used to
            understand which features get used and where people get stuck, and
            they are never sold, shared, or used for advertising.
          </p>
          <p>
            Orbit also runs two of its host&apos;s tools:{" "}
            <strong>Vercel Web Analytics</strong>, which counts page views and
            visitors in aggregate, and <strong>Vercel Speed Insights</strong>,
            which measures how quickly pages load. Along with each page, Vercel
            receives the site that linked to it, the browser and device type, and
            an approximate location. Neither tool uses cookies; Vercel tells
            visitors apart with a hash of the request that it discards after 24
            hours. Before anything is sent to Vercel, ids and one-time
            tokens in the page address are replaced with placeholders, every
            query parameter except campaign tags is removed, and views of the
            operator console are not sent at all. There are no advertising
            pixels and no cross-site tracking.
          </p>
        </DocSection>

        <DocSection id="controls" index={10} title="Your controls">
          <p>
            In Settings, under <Link href="/settings">Data and privacy</Link>, on every plan
            including Free:
          </p>
          <ul>
            <li>
              <strong>Export</strong> a JSON download of your contacts, interactions, reminders,
              tags, imports and AI suggestions. It does not yet include capture text and photos,
              meeting transcripts, chat history, events, companies, goals, outreach or recruiter
              records — ask through the <Link href="/contact">contact page</Link> for a copy of those.
            </li>
            <li>
              <strong>Delete data</strong>, choosing by category. Your account, plan and API keys
              stay.
            </li>
            <li>
              <strong>Delete your account.</strong> This erases all of your Orbit data and settings,
              including saved API keys and connected accounts, cancels an active Orbit Pro
              subscription, and removes your sign-in. It cannot be undone.
            </li>
          </ul>
          <p>
            Deleting your account from Clerk&rsquo;s own account page does the same deletion through
            our account webhook. Settings → Integrations → AI provider shows your AI usage, and you
            can disconnect any connected account from the Integrations dialog.
          </p>
        </DocSection>

        <DocSection id="retention" index={11} title="How long data is kept">
          <p>
            Your Orbit data is kept while your account is active, until you delete it with the
            controls above. Downgrading never deletes anything: contacts added while you were
            subscribed stay visible and exportable on the Free Plan.
          </p>
          <p>
            Capture photos stay with the capture they belong to until you delete it; photos from a
            capture you never save are deleted after 24 hours. Audio is never kept. Page views are
            deleted after 180 days; deleting your data or your account unlinks the ones made while
            you were signed in, keeping only the anonymous count.
          </p>
          <p>
            When you delete your account, every table holding your data is cleared, including your
            settings, keys and tokens. What remains: Stripe&rsquo;s own records of your payments,
            held by Stripe; Orbit&rsquo;s accounting record of charges and refunds, with your
            account id removed; the operator&rsquo;s audit log of actions taken on your account,
            which refers to an account id that no longer exists; and a few operational counters
            keyed by that same id. Encrypted database backups are kept for 90 days, so deleted data
            leaves the last backup within 90 days.
          </p>
        </DocSection>

        <DocSection id="security" index={12} title="Security">
          <p>
            Traffic runs over HTTPS, every database query is scoped to your account, and API keys and
            account tokens are encrypted at rest (AES-256-GCM). Sign-in is handled by Clerk, and card
            data never touches Orbit&rsquo;s servers.
          </p>
          <p>
            No system is perfectly secure, and Orbit is an early-stage product built by one person.
            Use a strong, unique password, and treat the API keys you paste into Settings with the
            same care you would anywhere else.
          </p>
        </DocSection>

        <DocSection id="operator-access" index={13} title="Operator access">
          <p>
            Running Orbit means occasionally looking at how it is doing, and at one account when
            something goes wrong for it. There is an internal operator console for that. This is what
            it can see and do.
          </p>
          <ul>
            <li>
              <strong>For every account:</strong> name, email and profile picture; plan and billing
              status; sign-up and last-active times; which integrations are connected and whether
              each has a key saved (never the key); AI usage totals and estimated cost; recent
              imports and errors; a timeline of recent activity that names contacts and chat thread
              titles; and the pages you opened while signed in.
            </li>
            <li>
              <strong>When the operator opens an account:</strong> its contact list — names, email
              addresses, companies and titles. Opening one contact shows that record in full: phone,
              location, notes, AI summary, key facts, and the notes on its recent interactions.
            </li>
            <li>
              <strong>Never:</strong> API keys, account tokens, webhook secrets or the calendar feed
              link; chat messages; the original text of your captures; meeting transcripts; capture
              photos. These are blocked in the code that reads the database, so the console cannot
              display them even by mistake.
            </li>
            <li>
              <strong>Feedback you send</strong> through the in-app feedback button, including any
              screenshot you attach, is read by the operator.
            </li>
          </ul>
          <p>
            The operator can comp or revoke a plan, suspend or delete an account, retry or cancel an
            import, reset onboarding, disconnect an integration, turn a calendar feed on or off, and
            create a one-time link that signs in as your account (for support, and for the demo
            account). Each of these requires a written reason, recorded in an audit log. Opening your
            account is recorded, and so is every individual contact record opened, by its id.
          </p>
          <p>
            The operator looks only to answer a support request from you, to investigate abuse, a
            security problem or a failure affecting your account, or where the law requires it.
          </p>
        </DocSection>

        <DocSection id="transfers" index={14} title="Where data is processed">
          <p>
            Orbit&rsquo;s hosting, database, payment and AI providers operate globally, so your data
            may be processed outside the country you live in — most often the United States. Where
            you supply your own API keys, the processing location follows what you configured with
            that vendor.
          </p>
        </DocSection>

        <DocSection id="children" index={15} title="Children">
          <p>
            Orbit is not directed at children under 13, and we do not knowingly collect personal
            information from them. If you believe a child has provided information to Orbit, get in
            touch and it will be removed.
          </p>
        </DocSection>

        <DocSection id="changes" index={16} title="Changes to this policy">
          <p>
            This policy will change as the product does. The <strong>Last updated</strong> date at
            the top is revised whenever it happens, and material changes are called out in the app.
            Continuing to use Orbit after a change means you accept the updated policy.
          </p>
        </DocSection>

        <DocSection id="contact" index={17} title="Questions">
          <p>
            Questions about this policy, or about what Orbit holds on you, can go to the operator
            through the <Link href="/contact">contact page</Link>. For routine export or deletion,
            the Settings controls are faster than an email.
          </p>
        </DocSection>
      </DocBody>

      <DocFooterCta
        title="Prefer to check for yourself?"
        body="Export your data, delete some of it, or delete your account from the Data and privacy panel in Settings — no request required."
        primary={{ href: "/settings", label: "Open Settings" }}
        secondary={{ href: "/terms", label: "Read the terms" }}
      />
    </>
  );
}
