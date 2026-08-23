import type { Metadata } from "next";
import Link from "next/link";
import { HeartHandshake, KeyRound, Sparkles, Wallet } from "lucide-react";
import {
  DocBody,
  DocCallout,
  DocFooterCta,
  DocHero,
  DocHighlights,
  DocSection,
  type Highlight,
} from "@/components/marketing/marketing-doc";
import type { TocItem } from "@/components/marketing/doc-toc";
import { FREE_CONTACT_LIMIT, LIFETIME_SEAT_LIMIT } from "@/lib/plan-limits";

export const metadata: Metadata = {
  title: "Terms of Service — Orbit",
  description:
    "The agreement covering your use of Orbit: what you can expect from the product, and what it expects from you.",
};

const LAST_UPDATED = "August 12, 2026";
const OPERATOR = "Jason Pereira";

const HIGHLIGHTS: readonly Highlight[] = [
  {
    icon: KeyRound,
    title: "Your data stays yours",
    body: "You keep ownership of everything you put into Orbit, and you can export or delete it at any time.",
  },
  {
    icon: Wallet,
    title: "Limits gate adding, not access",
    body: `Passing ${FREE_CONTACT_LIMIT} contacts stops you adding new ones. Nothing already in your orbit is hidden or deleted.`,
  },
  {
    icon: Sparkles,
    title: "AI output needs review",
    body: "Drafts, summaries, and suggestions can be wrong. Read them before you send them to a real person.",
  },
  {
    icon: HeartHandshake,
    title: "Use it in good faith",
    body: "No spam, no scraping, no uploading data about people you have no right to hold.",
  },
];

const TOC: readonly TocItem[] = [
  { id: "agreement", label: "The agreement" },
  { id: "what-orbit-is", label: "What Orbit is" },
  { id: "eligibility", label: "Eligibility" },
  { id: "account", label: "Your account" },
  { id: "acceptable-use", label: "Acceptable use" },
  { id: "your-content", label: "Your content" },
  { id: "keys", label: "Third-party services" },
  { id: "ai", label: "AI features" },
  { id: "availability", label: "Availability" },
  { id: "plans", label: "Plans and payment" },
  { id: "ip", label: "Orbit's IP" },
  { id: "termination", label: "Termination" },
  { id: "disclaimers", label: "Disclaimers" },
  { id: "liability", label: "Liability" },
  { id: "indemnity", label: "Indemnification" },
  { id: "law", label: "Governing law" },
  { id: "changes", label: "Changes" },
  { id: "contact", label: "Contact" },
];

export default function TermsPage() {
  return (
    <>
      <DocHero
        eyebrow="Terms of Service"
        title="The deal between you and Orbit."
        lede="Orbit is an early-stage product built by one person. These terms set out what you can expect from it, what it expects from you, and where the limits sit — written to be read, not skimmed past."
        meta={[
          { label: "Last updated", value: LAST_UPDATED },
          { label: "Operated by", value: OPERATOR },
          { label: "Read time", value: "About 8 minutes" },
        ]}
      />

      <DocHighlights kicker="The short version" items={HIGHLIGHTS} />

      <DocBody toc={TOC}>
        <DocSection id="agreement" index={1} title="The agreement">
          <p>
            These Terms of Service (the <strong>Terms</strong>) are an agreement
            between you and {OPERATOR}, who operates Orbit (<strong>we</strong>,{" "}
            <strong>us</strong>). By creating an account, joining the waitlist,
            or otherwise using Orbit, you agree to them. If you don&apos;t
            agree, don&apos;t use the product.
          </p>
          <p>
            The <Link href="/privacy">Privacy Policy</Link> is part of this
            agreement and describes how your information is handled. Where the
            two documents overlap, the Privacy Policy governs privacy matters.
          </p>
          <p>
            The summary cards above are a convenience, not a substitute — the
            sections below are the operative terms.
          </p>
        </DocSection>

        <DocSection id="what-orbit-is" index={2} title="What Orbit is">
          <p>
            Orbit is a personal networking tracker. It stores the people you
            meet, keeps a history of your conversations, imports contact data
            you provide, and uses AI to help you decide who to follow up with
            and what to say. It is a tool for organising your own relationships.
          </p>
          <p>
            Orbit is not a professional service. Nothing it produces is legal,
            financial, employment, or career advice, and it does not guarantee
            interviews, introductions, replies, or job offers. Decisions you
            make with it are yours.
          </p>
        </DocSection>

        <DocSection id="eligibility" index={3} title="Who can use Orbit">
          <p>
            You must be at least 13 years old, and at least the age of digital
            consent where you live, to use Orbit. If you are using it on behalf
            of an organisation, you confirm you have the authority to bind that
            organisation to these Terms. You may not use Orbit if you are barred
            from doing so under applicable law or sanctions.
          </p>
        </DocSection>

        <DocSection id="account" index={4} title="Your account">
          <p>
            Accounts are handled by our authentication provider, Clerk. You are
            responsible for keeping your credentials secure and for everything
            that happens under your account. Tell us promptly if you believe it
            has been accessed by someone else.
          </p>
          <p>
            Provide accurate account information, and keep it current. One
            person, one account — don&apos;t share logins or resell access.
          </p>
        </DocSection>

        <DocSection id="acceptable-use" index={5} title="Acceptable use">
          <p>When using Orbit, you agree not to:</p>
          <ul>
            <li>
              Upload or store personal data about other people that you have no
              lawful basis to hold, or that you obtained in breach of another
              service&apos;s terms
            </li>
            <li>
              Send unsolicited bulk messages, spam, or anything that violates
              anti-spam and telemarketing rules such as CAN-SPAM, CASL, or the
              GDPR&apos;s marketing provisions
            </li>
            <li>
              Use outreach features to harass, deceive, impersonate, or threaten
              anyone
            </li>
            <li>
              Scrape, resell, or redistribute enrichment data in ways that
              breach the source provider&apos;s terms
            </li>
            <li>
              Probe, overload, or interfere with the service, or attempt to
              access accounts and data that are not yours
            </li>
            <li>
              Reverse engineer or circumvent the product&apos;s technical
              limits, except where that right cannot be excluded by law
            </li>
            <li>Use Orbit to break the law, anywhere it applies to you</li>
          </ul>
          <p>
            You are the sender of any message you dispatch through Orbit, and
            you are responsible for its content and for complying with the rules
            that govern it.
          </p>
        </DocSection>

        <DocSection id="your-content" index={6} title="Your content">
          <p>
            You keep ownership of everything you put into Orbit — contacts,
            notes, interactions, messages, and the rest. We claim no ownership
            over it.
          </p>
          <p>
            You grant us a limited, non-exclusive licence to host, store,
            process, transmit, and display that content strictly to operate the
            product for you: rendering it in the app, running the features you
            invoke, sending it to the providers you have enabled, and creating
            derived artifacts such as summaries and embeddings. That licence
            exists so the software can function, and it ends when you delete the
            content or your account.
          </p>
          <DocCallout title="You are the data controller">
            <p>
              For contact records about other people, you decide what is
              collected and why. You confirm you have the right to store that
              information and to contact those people, and you agree to honour
              their requests — including deletion — using the controls Orbit
              provides.
            </p>
          </DocCallout>
          <p>
            We don&apos;t use your content to train our own models, and we
            don&apos;t sell it. See the{" "}
            <Link href="/privacy">Privacy Policy</Link> for the full picture.
          </p>
        </DocSection>

        <DocSection
          id="keys"
          index={7}
          title="Third-party services and your API keys"
        >
          <p>
            Orbit integrates with services including Clerk, hosted Postgres,
            Vercel, Stripe, AI providers (Google Gemini, OpenAI, Anthropic),
            Apollo, Resend, Twilio, Google and Microsoft mail and calendar, and
            LinkedIn CSV exports. Each has its own terms and privacy policy, and
            your use of them through Orbit is also subject to those.
          </p>
          <p>
            Where you supply your own API keys, you are contracting directly
            with that provider: their usage limits, costs, and content rules
            apply to you, and any charges they bill are yours to pay. Orbit adds
            no markup to what your providers charge, and equally takes no
            responsibility for it. We are not responsible for a third-party
            service changing, degrading, rate-limiting, or discontinuing what it
            offers, and any given integration may be removed from Orbit if it
            becomes impractical to maintain.
          </p>
        </DocSection>

        <DocSection id="ai" index={8} title="AI features">
          <p>
            AI features are optional and off until you configure them. When you
            use one, relevant content from your Orbit data is sent to the
            provider you selected so it can generate a response, billed to your
            own key.
          </p>
          <p>
            AI output is probabilistic. It can be inaccurate, outdated,
            incomplete, or entirely fabricated, including about real people you
            have stored in Orbit.{" "}
            <strong>
              Review anything the model produces before you rely on it or send
              it to someone
            </strong>
            . You remain responsible for every message that leaves your account,
            regardless of which tool drafted it.
          </p>
        </DocSection>

        <DocSection id="availability" index={9} title="Availability and changes">
          <p>
            Orbit is in early access. Features may be added, changed, or removed
            at any time; the product may be unavailable for maintenance,
            provider outages, or plain breakage; and there is no uptime
            commitment or service level agreement. Keep your own copy of
            anything you cannot afford to lose — the JSON export in Settings
            exists for exactly this.
          </p>
        </DocSection>

        <DocSection id="plans" index={10} title="Plans and payment">
          <p>
            The Free Plan covers up to {FREE_CONTACT_LIMIT} contacts and costs
            nothing. Paid plans — Orbit Pro, billed monthly or annually, and
            Orbit Lifetime, a one-time purchase limited to the first{" "}
            {LIFETIME_SEAT_LIMIT} buyers — lift that cap. Current prices are on
            the <Link href="/pricing">pricing page</Link> and apply from the
            moment you subscribe.
          </p>
          <ul>
            <li>
              <strong>Reaching a limit only stops you adding people.</strong>{" "}
              Everything already in your account stays visible, editable, and
              exportable — including contacts added while you were subscribed,
              if you later drop back to Free.
            </li>
            <li>
              <strong>Cancel whenever you like.</strong> Orbit Pro runs to the
              end of the period you have already paid for, then your account
              returns to the Free Plan. Cancelling part-way through a period
              does not trigger a pro-rated refund.
            </li>
            <li>
              <strong>Payments are handled by our providers.</strong>{" "}
              Subscriptions run through Clerk&apos;s billing and the one-time
              tier through Stripe. Their terms govern the transaction itself,
              and taxes are added where the law requires.
            </li>
            <li>
              <strong>AI, enrichment, and sending costs are separate.</strong>{" "}
              Where a feature runs on your own provider key, that provider bills
              you directly and no Orbit plan covers it.
            </li>
          </ul>
          <p>
            Prices may change. Existing subscribers get notice before a change
            takes effect and can cancel instead of accepting it. If something
            goes wrong with a charge, write to us — a solo product would rather
            fix a billing mistake than argue about it.
          </p>
        </DocSection>

        <DocSection id="ip" index={11} title="Orbit's intellectual property">
          <p>
            The Orbit software, interface, design, and name belong to us or our
            licensors. These Terms grant you a personal, non-transferable,
            revocable right to use the product as offered — nothing more. You
            may not use its branding or present the product as your own.
          </p>
          <p>
            If you send us feedback or ideas, we may use them freely to improve
            Orbit, with no obligation or payment to you.
          </p>
        </DocSection>

        <DocSection id="termination" index={12} title="Suspension and termination">
          <p>
            You can stop using Orbit at any time and delete your data or your
            whole account from Settings. We may suspend or terminate access if
            you materially breach these Terms, if your use puts the service or
            other people at risk, or if we discontinue the product — and we will
            give notice where it is reasonable to do so.
          </p>
          <p>
            Export what you want to keep before you go. After termination, your
            Orbit data is deleted as described in the{" "}
            <Link href="/privacy">Privacy Policy</Link>. The sections on your
            content licence, disclaimers, liability, indemnification, and
            governing law survive termination.
          </p>
        </DocSection>

        <DocSection id="disclaimers" index={13} title="Disclaimers">
          <p>
            Orbit is provided <strong>as is</strong> and{" "}
            <strong>as available</strong>, without warranties of any kind,
            express or implied, including merchantability, fitness for a
            particular purpose, non-infringement, accuracy, or uninterrupted
            operation. We do not warrant that the product will meet your
            requirements, that enrichment or AI output will be correct, or that
            defects will be fixed.
          </p>
          <p>
            Some jurisdictions do not allow certain warranty exclusions. Where
            that is the case, this section applies only to the extent permitted,
            and your mandatory statutory rights are unaffected.
          </p>
        </DocSection>

        <DocSection id="liability" index={14} title="Limitation of liability">
          <p>
            To the maximum extent permitted by law, we are not liable for
            indirect, incidental, special, consequential, or punitive damages,
            or for lost profits, lost opportunities, lost goodwill, or lost or
            corrupted data, arising from your use of Orbit — even if we were
            told such damages were possible.
          </p>
          <p>
            Our total liability for all claims relating to Orbit is limited to
            the greater of the amount you paid us for the product in the twelve
            months before the claim, or one hundred US dollars.
          </p>
          <p>
            Nothing here limits liability that cannot be limited by law,
            including for fraud, or for death or personal injury caused by
            negligence.
          </p>
        </DocSection>

        <DocSection id="indemnity" index={15} title="Indemnification">
          <p>
            You agree to indemnify and hold us harmless from claims, damages,
            and reasonable costs (including legal fees) arising from your
            content, your messages sent through Orbit, your breach of these
            Terms, or your violation of any law or third-party right — including
            the privacy rights of people whose details you store.
          </p>
        </DocSection>

        <DocSection id="law" index={16} title="Governing law and disputes">
          <p>
            These Terms are governed by the laws applicable where the operator
            of Orbit is established, without regard to conflict-of-law rules,
            and the courts of that place have jurisdiction over disputes arising
            from them. If you are a consumer, this does not deprive you of the
            protection of mandatory rules in your own country of residence, or
            of the right to bring proceedings there where local law gives you
            that right.
          </p>
          <p>
            Before filing anything formal, please write to us — nearly every
            dispute at this size is faster to resolve with an email than a
            filing.
          </p>
        </DocSection>

        <DocSection id="changes" index={17} title="Changes to these terms">
          <p>
            These Terms will change as Orbit does. When they do, the{" "}
            <strong>Last updated</strong> date at the top of this page is
            revised, and material changes are announced in the app before they
            take effect. Continuing to use Orbit afterwards means you accept the
            updated Terms; if you don&apos;t, stop using the product and delete
            your account.
          </p>
        </DocSection>

        <DocSection id="contact" index={18} title="Contact">
          <p>
            Questions about these Terms — including anything that reads
            ambiguously — can go through the{" "}
            <Link href="/contact">contact page</Link>. It reaches the person who
            wrote them.
          </p>
        </DocSection>
      </DocBody>

      <DocFooterCta
        title="Still have a question about the fine print?"
        body="Orbit is small enough that you can ask the person who built it and get an actual answer."
        primary={{ href: "/contact", label: "Get in touch" }}
        secondary={{ href: "/pricing", label: "See what it costs" }}
      />
    </>
  );
}
