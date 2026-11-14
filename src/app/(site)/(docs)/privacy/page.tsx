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
import { ScrollRegion } from "@/components/ui/scroll-region";
import { GOOGLE_LIMITED_USE, GOOGLE_SCOPE_DISCLOSURES, LEGAL_LAST_UPDATED } from "@/lib/legal";
import { TIMELINE_DAILY_CONTACT_CAP } from "@/lib/timeline-cost";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "What Orbit collects, who it shares data with, what it does with Google data, and how to export or delete everything in your account.",
};

const LAST_UPDATED = LEGAL_LAST_UPDATED;

const HIGHLIGHTS: readonly Highlight[] = [
  { icon: ShieldCheck, title: "Your network isn't a product", body: "Orbit doesn't sell personal information or run ad pixels, and its traffic analytics set no cookies." },
  { icon: Sparkles, title: "AI runs on your key or Orbit’s", body: "You choose the provider, and can supply your own key; the Free Plan, Orbit Pro, Orbit Max and Orbit Lifetime include AI on Orbit’s accounts. Most AI features run only when you use them; a few, like deriving LinkedIn timeline events, run automatically in the background on the same key or account. Settings shows what the last 30 days cost." },
  { icon: Download, title: "Export on demand", body: "One control in Settings produces a JSON download of your core Orbit data, on every plan including Free." },
  { icon: Trash2, title: "Deletion is real deletion", body: "Delete some or all of your data from Settings, or delete your account — which erases your data, keys and sign-in and cancels any subscription." },
];

const TOC: readonly TocItem[] = [
  { id: "scope", label: "Who this covers" },
  { id: "collect", label: "What we collect" },
  { id: "use", label: "How it's used" },
  { id: "google", label: "Google user data" },
  { id: "recruiters", label: "Recruiter scan & directory" },
  { id: "radar", label: "Radar" },
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

/** Every service that receives personal data, verified against the code on 2026-11-12. */
const PROCESSORS = [
  { name: "Clerk", badge: "Required", body: "Sign-in, sessions and account lifecycle. Holds your sign-in identity and records when you accepted these terms." },
  { name: "Vercel", badge: "Required", body: "Hosting, and file storage for contact photos, capture photos, feedback screenshots and files you attach to email. Also runs Web Analytics and Speed Insights, which receive page addresses with ids and tokens removed, and BotID, which checks forms for automated traffic." },
  { name: "Neon", badge: "Required", body: "The Postgres database that holds your Orbit data." },
  { name: "Sentry", badge: "Required", body: "Error reports: the error, where in the code it happened, the page and browser. Configured not to attach IP addresses or cookies, and with session replay off." },
  { name: "Slack", badge: "Required", body: "Operational alerts to the operator: job status, route names, error messages with email addresses and keys removed, and each piece of feedback you send: its text (up to 1,000 characters), your email address, plan, how long you have had your account, the page you were on, how many screenshots you attached, and the one-line summary described under Feedback below. An error message can occasionally include a value it was processing." },
  { name: "Better Stack", badge: "Required", body: "Uptime heartbeat. Receives a ping, no personal data." },
  { name: "unavatar.io", badge: "Automatic", body: "Looks up a public profile photo for contacts with a LinkedIn URL. Receives the LinkedIn username only." },
  { name: "Microlink", badge: "Automatic", body: "When unavatar.io has no photo, fetches the public preview image of the contact's LinkedIn profile URL." },
  { name: "Gravatar", badge: "Automatic", body: "Checks for a public avatar for a contact's email. Receives a one-way hash of the address, not the address." },
  { name: "Wikidata and Google's favicon service", badge: "Automatic", body: "Brand colors for the companies and schools in your network, and company logos on your meetings. Receives an organization's name or website domain only. A domain may come from a contact's or meeting guest's work email address; the address itself is never sent." },
  { name: "Deepgram", badge: "Always", body: "Speech-to-text for voice notes, meetings and the chat microphone. Receives your audio and a list of your recent contact names so it spells them correctly. Every request sets Deepgram's zero-retention flag, which Deepgram documents as not storing your audio, text, transcripts or synthesized audio after the response is returned. Each request also carries a label so Orbit can check its own bill: a recording's own id for a meeting, and for everything else a random value Orbit generated for your account — not your name, your email or your account id. Labels sit in Deepgram's usage records, which the zero-retention flag does not cover; deleting your data in Settings replaces yours. Deepgram also runs Cosmo, Orbit's voice assistant: during a call it receives your speech and Cosmo's instructions (your name, role and goals, a short summary of what needs your attention, the recent conversation, and the page you are on described in Orbit's own words) plus the Orbit records Cosmo looks up to answer you, and its voice agent passes the text of the conversation, not the audio, to OpenAI to write each reply. The zero-retention flag above covers transcription requests; how long Deepgram keeps a call is set by its own terms." },
  { name: "ElevenLabs", badge: "Optional", body: "An alternative voice provider for Cosmo, used only if Orbit switches calls to it. During a call it receives what Deepgram would: your speech, Cosmo's instructions and the records Cosmo looks up." },
  { name: "Stripe", badge: "Optional", body: "Orbit Pro, Orbit Max and credit pack payments. Card details go to Stripe directly; Orbit stores a customer reference." },
  { name: "Google Gemini, OpenAI, Anthropic", badge: "Optional", body: "AI features: notes, chat, drafts, search indexing, transcription and reading pages you scan. Also reading feedback you send, for the operator, on Orbit's account (see Feedback below). On the provider you choose in Settings: on your own key, or (for the Free Plan’s allowance and included AI on Orbit Pro, Orbit Max and Orbit Lifetime) on Orbit's account with that provider. Keeping a contact's work history current runs a web search through that same provider, by the contact's name, employer and public profile link. Looking up a meeting guest who is not yet a contact, when you press Look up, runs the same search by their name and the company named by their email domain — never the address. When you review the people a capture found, each one who would be added as a new contact is looked up the same way, by their name with the company, role, place you met and city your note gives — never an email address or phone number." },
  { name: "OpenRouter", badge: "Optional", body: "The same AI features, routed through OpenRouter, only if you connect your own OpenRouter account in Settings." },
  { name: "TypeSafe", badge: "Optional", body: "Jev, a decision model, for yes-or-no and ranking steps: spotting recruiters during a mail scan you start, choosing which contacts a chat answer draws on, telling two contact records apart before they are merged, reading captured notes, judging which calendar events were meetings with people, and deciding whether a note or message has anything in it worth sending to your chat model. Those run only if you add your own TypeSafe key in Settings. On every account, Orbit's own TypeSafe account also decides whether keeping a contact's work history current needs another web search: it reads the job history Orbit already has for that contact, when it was last checked, and short summaries of your notes and messages about them since — never the notes themselves, an email address or a phone number — and, when a search was unsure it found the right person, the public answer that search found." },
  { name: "Google", badge: "Optional", body: "Gmail, Contacts and Calendar, one permission per feature you turn on. See Google user data." },
  { name: "Apple iCloud", badge: "Optional", body: "Your iCloud calendars, if you connect them with an app-specific password, which Orbit stores encrypted. Used to log meetings with people you know and for the meeting features described under Connected accounts." },
  { name: "Microsoft", badge: "Optional", body: "Outlook, one permission per feature you turn on: your contacts to import, your calendar to log meetings with people you know and for meeting prep, reminders and Chat, your mail for the recruiter scan you start, and sending the email you write from your own address, and your OneDrive files for cloud notes. See What Orbit collects and The recruiter scan." },
  { name: "Web push services (Google, Apple, Mozilla)", badge: "Optional", body: "Deliver Radar's push notifications to devices where you turned push on. Each receives the device's push address and an encrypted message it cannot read." },
  { name: "Event websites", badge: "Optional", body: "With Radar on, Orbit's server may open the public page of an event a search found, to check its date and place. The site sees a request from Orbit, with nothing about you." },
  { name: "Eventbrite", badge: "Optional", body: "Guest lists of events you host, through Eventbrite sign-in." },
  { name: "Luma", badge: "Optional", body: "Guest lists of events you host (with your Luma API key), your personal Luma calendar link if you paste it, and the guest list you have open on an event page when you save it from the browser extension." },
  { name: "Partiful", badge: "Optional", body: "Your personal Partiful calendar link, if you paste it, to list events you are going to, and the guest list you have open on an event page when you save it from the browser extension." },
  { name: "Apollo", badge: "Optional", body: "People search and contact enrichment, with your own Apollo key. Orbit does not run it on an Apollo account of its own." },
  { name: "Resend", badge: "Optional", body: "Email Orbit sends on its own behalf: the waitlist confirmation, Radar's Monday and same-day emails, and outreach campaigns you send from Orbit. Email you write to a person goes from your own Gmail or Outlook instead. Resend reports back when a message bounces or is marked as spam and, for outreach sent through Orbit's Resend account, when it was delivered, first opened and first clicked. See Cookies, storage & analytics." },
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
              follow-up dates), interactions, goals, reminders, chat threads (with the text read
              from any file you attach to a question), the short notes you ask Orbit to remember
              across chats, events, outreach campaigns and messages, recruiter records, and import
              history. When you capture notes,
              Orbit keeps the text and any photos you attach so you can look back at the original.
              Photos are resized and stripped of their metadata (including location) before they are
              stored; photos from a capture you never save are deleted after 24 hours.
            </li>
            <li>
              <strong>Contact photos</strong> — shared photos come only from public lookups: public
              LinkedIn profile photos found on the web, and public Gravatar photos found by a
              contact&rsquo;s email address. One is added to a shared set once and shown to any Orbit
              user who has that person. A photo found by email is kept under a one-way hash of the
              address, never the address itself. Photos from Google or Outlook contacts, photos the
              Orbit browser extension captures, Apollo photos and photos you upload are never shared:
              they stay with your account.
            </li>
            <li>
              <strong>Contact work history</strong> — when a web search finds a contact&rsquo;s work
              history from their public LinkedIn profile and is confident it is them, that history is
              kept in a shared set for up to 30 days and reused for any Orbit user who has the same
              profile, so it is not searched again. Only what a public web search found is shared:
              never anything you typed or imported, nothing the Orbit browser extension captures, and
              nothing a search was unsure about. It is deleted within a day once no Orbit account has
              that person, and after 90 days at most.
            </li>
            <li>
              <strong>Voice and meetings</strong> — audio you record is sent to be transcribed and is
              not kept. The transcript is: a voice note becomes the text of your note, and a meeting
              keeps its transcript until you delete the meeting.
            </li>
            <li>
              <strong>Talking with Cosmo</strong> — Cosmo, the voice assistant in the corner of each
              page, listens only after you click it, and a call ends when you end it or after a quiet
              minute. What you and Cosmo say is saved as that day&rsquo;s Cosmo chat, which you can
              delete like any chat. To know where you are, Cosmo is told the page&rsquo;s name, the id
              of the record you have open and the names of Orbit&rsquo;s own buttons on screen, never
              the text on the page or a screenshot. It can make small changes you ask for at once,
              each with Undo; it sends an email only after you say &ldquo;send it&rdquo; or click.
              When you ask, it can also open pages, press Orbit&rsquo;s own buttons and type into
              Orbit&rsquo;s fields for you, with its cursor showing where; it never presses save,
              send or delete itself, and leaves those to you.
              Minutes are counted per account from when each call connects. Whether you turned
              captions on, where you moved Cosmo and which suggestions you dismissed stay in your
              browser.
            </li>
            <li>
              <strong>Connected accounts</strong> — if you connect Google, Orbit reads only what the
              feature you turned on needs (see <a href="#google">Google user data</a>). If you connect
              Microsoft, Orbit asks for one permission per feature you turn on: your Outlook
              contacts, so you can pick who to import; your calendar, to add meetings with people
              you know to their timelines and for the meeting features below; your mail, for the recruiter scan you start, to find
              your latest message with a contact when you reply in that conversation (its
              Message-ID, subject and date only), and to check your Sent Items so a retried send is
              never delivered twice; and permission to send mail (Mail.Send), only for email you
              write and press Send on; and read access to your OneDrive files (Files.Read), for
              cloud notes: listing recent files so you can pick notes to import, and reading the
              title and first lines of recently changed ones to spot meeting notes — a whole file is
              read only when you extract it or turned on automatic extraction. Each connection also asks for your Microsoft sign-in
              identity and email address, to show which account is connected. Orbit cannot read,
              change or delete anything else in your Microsoft account. Disconnecting deletes the tokens Orbit holds; to
              also revoke the grant on Microsoft&rsquo;s side, remove Orbit from your Microsoft
              account&rsquo;s app permissions.
            </li>
            <li>
              <strong>Your calendar</strong> — from a Google, Outlook or iCloud calendar you
              connect (on Google, the calendars you tick, your primary calendar by default), Orbit
              keeps the meetings from two days ago to two weeks ahead (title, time,
              call link, agenda, and the guests&rsquo; names and addresses), refreshes them while
              you use Orbit, and deletes a meeting once it leaves that window or your calendar. It
              uses them to suggest recording a call, remind you to prepare and follow up, show a
              prep card, link a recording to its invite, and answer questions about your
              schedule in Chat. Guests&rsquo; addresses are used only to recognise people you
              already know; they are never sent to an AI provider. Disconnecting a calendar
              deletes these meetings and the prep reminders made for meetings still to come. A
              meeting from 90 days ago to 60 days ahead with people you know is also matched to
              them: a past one is logged to their history, with the meeting&rsquo;s title, location
              and the first 500 characters of its description, and a follow-up reminder may be
              suggested.
              When an invite is for a Luma, Partiful or Eventbrite event Orbit already holds, the
              prep card and Chat also show that event&rsquo;s hosts, guest count and the guests
              worth finding — by name and role, never their addresses.
            </li>
            <li>
              <strong>Email you send</strong> — when you send email from Orbit through your Gmail or
              Outlook, Orbit keeps a record of each message (sender, recipients, subject, body, when
              it was sent, and any files attached) so it can deliver it after the undo window or at
              the time you scheduled, retry it safely, and log it on the contacts it went to. Orbit
              never sends a message you did not send.
            </li>
            <li>
              <strong>The browser extension</strong> — when you open its panel on a LinkedIn profile,
              it sends that page&rsquo;s text to Orbit, which fills in a contact using your key or Orbit&rsquo;s included AI. A
              contact is created only when you save it. On a Luma or Partiful event page, it reads
              the guest list you have open in your own signed-in session — names, and the
              platform&rsquo;s profile links where it shows them — and sends it to Orbit only when you
              press Save. The guests are kept on that event in Orbit, never sent to an AI provider,
              and none becomes a contact unless you add them one by one. Orbit&rsquo;s servers never
              fetch a guest list themselves. On your LinkedIn Connections page, it offers to log the
              people you connected with at one of your events: it sends Orbit only the names,
              profile links and headlines of the connections you tick, when you press Log, and they
              are added to that event&rsquo;s guest list. None becomes a contact until you review
              and save them in Orbit. With Radar&rsquo;s &ldquo;Save LinkedIn posts from the
              extension&rdquo; setting on, you can save the post you have open to Radar, or press{" "}
              <strong>Scan</strong> on your LinkedIn feed or someone&rsquo;s activity page. A scan reads
              only the posts already on your screen, at most 25. It first sends Orbit just the
              authors&rsquo; profile links; Orbit answers which of them are your contacts and keeps
              none of the links. Only those contacts&rsquo; posts (their text and link) are then sent
              and kept, as Radar activity for that contact. Posts by anyone else never leave your
              browser.
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
              reply. This powers your cost view; you can see your last 30 days in Settings under
              Integrations → AI provider.
            </li>
            <li>
              <strong>Page views</strong> — which pages are opened, when and for how long; how quickly
              each loaded; device type; the referring site and campaign tags; and approximate location
              looked up from the IP address. Linked to your account while you are signed in. See{" "}
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
            <li>Power the AI features you use, on your key or Orbit’s</li>
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
          {/* Keyboard-scrollable while it overflows (axe scrollable-region-focusable). */}
          <ScrollRegion label="Google permissions Orbit asks for">
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
          </ScrollRegion>
          <p>
            {GOOGLE_LIMITED_USE.before}
            <a href={GOOGLE_LIMITED_USE.href}>{GOOGLE_LIMITED_USE.linkText}</a>
            {GOOGLE_LIMITED_USE.after}
          </p>
          <p>
            In practice: Orbit uses Google data only to provide the features in the table, shown to
            you inside Orbit. It does not sell it, does not use it for advertising, and does not use
            it to develop or train AI models. Where a feature uses AI — the recruiter scan;
            for your calendar, a meeting&rsquo;s title, agenda and guests&rsquo; names when you ask
            Chat about your schedule, when a recording of that meeting is summarized, and when
            you ask for talking points — the text involved goes to the AI provider you chose — on your own key, or on
            Orbit&rsquo;s account with that provider when that is the one in use — only to produce
            the result you asked for. A person at Orbit reads Google data only with your
            permission for a support request you raise, to investigate abuse or a
            security problem, or where the law requires it.
          </p>
          <p>
            Disconnecting Google in Orbit deletes the tokens Orbit holds. To also revoke the grant
            on Google&rsquo;s side, remove Orbit from your Google Account&rsquo;s third-party access
            page.
          </p>
          <DocCallout title="Email insights">
            <p>
              If you turn on Email insights in Settings, Orbit checks your Gmail every fifteen
              minutes for new threads that look like a job application or a recruiter
              conversation, excluding newsletters and mailing lists. It first reads only the
              sender, the subject, who is on the thread and the short preview Gmail supplies.
            </p>
            <p>
              For a thread that looks like a hiring conversation, Orbit then reads the text of
              its most recent messages — up to four, each cut to 4,000 characters — and sends it,
              with the sender names and addresses, to the AI provider that runs your
              account&rsquo;s AI features. The model notes the company, the role, where things
              stand, any dates, the people named and what is being asked of you. Orbit keeps
              those notes, the thread id, the subject, the participants and one short quote
              (under 200 characters) copied from the mail as evidence. It stores no message
              bodies, and it does not use this mail to train models or for advertising.
            </p>
            <p>
              In those same messages, when the sender is already one of your contacts, Orbit reads
              the signature at the end of their own text by rule, with no AI, and copies their
              role, company, phone number and LinkedIn link into any of those fields that are
              empty on their contact. It never changes a field that already has a value, and each
              one it fills is listed under &ldquo;Changed by Orbit&rdquo; on the Duplicates page,
              where you can undo it.
            </p>
            <p>
              The notes it keeps can appear as reasons on your Radar cards, in the short lines
              and drafts Radar writes with your AI provider, and in your in-app briefing. They
              are never put in Radar&rsquo;s Monday email.
            </p>
            <p>
              Radar can also list people an email names who are not in your orbit yet, showing
              the name and job title the email gave. Orbit adds one only when you press Add; it
              then saves their name, email address and job title as a contact, and nothing else
              from the email. Dismissing someone keeps only their name, on the Ignored people
              list, until you delete your insights data or disconnect Gmail.
            </p>
            <p>
              Your chat assistant can search the same notes. When you ask a question, the notes
              that match are sent with it to the AI provider that runs your account&rsquo;s AI
              features, and an answer can cite them. Turning Email insights off removes them
              from chat search at once; disconnecting Gmail or deleting your insights data
              removes them for good.
            </p>
            <p>
              Turning it off stops the checking; disconnecting Gmail, or deleting your insights
              in Settings, removes what it recorded.
            </p>
          </DocCallout>
          <DocCallout title="Matching your writing style">
            <p>
              So the messages Orbit drafts for you sound like you, Orbit reads about twenty of
              your recent sent emails from Gmail or Outlook, once, after your first draft (and
              again when you press Refresh). It removes quoted replies, signatures, email
              addresses, links and phone numbers, and sends what is left, each email cut to 1,200
              characters, to the AI provider that runs your account&rsquo;s AI features.
            </p>
            <p>
              The model writes a short description of how you write: greetings, sign-offs,
              length, tone and the words you tend to use, with no names, companies or details of
              what the emails were about. Orbit keeps only that description (at most 600
              characters) and never stores the emails themselves. You can read, edit or turn it
              off under &ldquo;How I like things written&rdquo; in Chat; turning it off deletes it and stops
              Orbit reading your sent mail for this. Deleting your preferences deletes it too.
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
            and address, to the AI provider you chose, on your key or Orbit&rsquo;s included AI. The model decides whether the
            sender is a recruiter and writes a short summary of the conversation.
          </p>
          <p>
            <strong>Outlook.</strong> If you connect Outlook instead, or as well, the scan works the
            same way on Outlook mail: it needs the read-only mail permission, which Orbit asks for
            only when you press Allow mail access on the Recruiters page. It searches your mailbox
            for the same terms, skips Junk Email and Deleted Items, and sends the same text to the
            same AI provider, on your key or Orbit&rsquo;s included AI. What is kept is the same too, apart from the thread id,
            which Outlook does not provide. Message bodies are not stored.
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

        <DocSection id="radar" index={6} title="Radar">
          <p>
            Radar suggests who to reach out to and why. It is off until you turn it on, and while it
            is off it reads nothing and runs no searches. With it on:
          </p>
          <ul>
            <li>
              <strong>What it reads.</strong> Your contacts, notes, meetings, reminders, the email
              insights you turned on, the goals, projects and city you give Orbit, the LinkedIn posts
              you save or scan with the browser extension, and, if you uploaded your LinkedIn export,
              the hashtags you use most in your own posts. Every
              suggestion shows what it rests on: a quote from your own notes or messages, a record in
              Orbit such as a meeting or a job change, or a link a web search returned. A suggestion
              whose proof doesn&rsquo;t check out is dropped.
            </li>
            <li>
              <strong>Links between people you know.</strong> To suggest an introduction or an ask,
              Radar compares a recent note about one person with notes about other people you have
              met, and sends the matching passages to your AI provider to judge whether the link is
              real. A draft introduction never quotes one person&rsquo;s note to the other.
            </li>
            <li>
              <strong>Web searches about people you know.</strong> When Orbit re-checks where a
              contact works (see <em>Contact work history</em> above), Radar also asks the same search
              for that person&rsquo;s recent public posts, talks and news. This happens only for
              people you have met, at most a set number of times a month for your plan, and costs no
              extra search. The search sends the person&rsquo;s name and the details Orbit uses to
              recognize them: LinkedIn URL, title, company, location and school. Orbit keeps a result
              only if the search itself returned its link. It keeps it as a short excerpt and that
              link, in your account only. Unlike work history, it is never shared with other Orbit
              users.
            </li>
            <li>
              <strong>Web searches for opportunities.</strong> About once a week Radar searches the
              web for events in your city, people who could help with your goals, and programs with
              deadlines. The search sends your city, up to five of your goals and up to eight of the
              hashtags you use most, and nothing about your contacts. To check an event&rsquo;s date and place, Orbit&rsquo;s server may open
              the event&rsquo;s public page; it never opens lu.ma pages. A person it finds is shown
              only when someone you know works or used to work where they work, and stays in Radar until you choose{" "}
              <strong>Save person</strong>: nothing is added to your contacts on its own. Finds you
              don&rsquo;t save are deleted 30 days after they end or expire.
            </li>
            <li>
              <strong>Alerts.</strong> When something on Radar&rsquo;s Today list won&rsquo;t keep,
              Radar can send a push notification to each device where you turned push on, and an
              email, at most one a day. A push travels through your browser&rsquo;s push service
              (Google, Apple or Mozilla, depending on the browser), encrypted so that service
              can&rsquo;t read it, and never includes anyone&rsquo;s name. Radar&rsquo;s emails (the
              Monday email and the same-day email) do name the people on your list. They are sent
              through Resend, and each has its own one-click unsubscribe.
            </li>
            <li>
              <strong>Learning.</strong> When you hide a suggestion and say why, Radar uses your
              answer to adjust future suggestions for your account. It is not used for anyone
              else&rsquo;s.
            </li>
          </ul>
          <p>
            You can turn Radar off, and each of its emails and push, in Radar&rsquo;s settings at any
            time. Deleting your data or your account deletes everything Radar keeps.
          </p>
        </DocSection>

        <DocSection id="third-parties" index={7} title="Who else touches your data">
          <p>
            Orbit relies on the processors and integrations below. &ldquo;Required&rdquo; ones handle
            every account; &ldquo;Automatic&rdquo; ones run without a setting (photo lookups for
            contacts); &ldquo;Always&rdquo; runs whenever you use a voice feature, on Orbit&rsquo;s
            own key rather than one you supply; &ldquo;Optional&rdquo; ones stay dormant until you
            use the feature.
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
          <p>
            <strong>Assistants you connect yourself.</strong> If you connect Orbit to Claude,
            ChatGPT or another assistant, whatever it reads from Orbit goes to that assistant&rsquo;s
            provider under their privacy policy, not ours — the same as if you had copied the
            text into their chat window. That includes your upcoming meetings (titles, times and
            guests&rsquo; names, never their addresses) and when you are free, if you ask it to look.
            Orbit sends nothing on its own: a connected assistant
            can draft a message, but it waits for you to read and approve it before anything
            leaves. You can disconnect an assistant from its own settings, and revoke any API
            key from Orbit&rsquo;s.
          </p>
        </DocSection>

        <DocSection id="ai" index={8} title="AI processing">
          <p>
            When you use an AI feature, the content it needs — notes, contact context, chat prompts,
            photos of pages you scan, recruiter emails when you run the scan — is sent to an AI
            provider: Google Gemini, OpenAI or Anthropic. Every plan includes a monthly AI
            allowance, and the Free Plan also gets a one-time starter grant: those calls run on Orbit&rsquo;s own
            accounts with Anthropic or OpenAI, whichever Orbit routes the request to, under Orbit&rsquo;s agreements with them, which do not allow
            your content to be used to train their models. Providers may keep requests for a limited
            period for abuse monitoring under those agreements. If you add your own key and choose it,
            those calls run on your account, with the provider you chose in Settings, instead.
          </p>
          <p>
            Chat also sends along two things you control. A file you attach to a question goes as
            text: a text file is read in your browser, and a photo or PDF is read by the AI
            provider first, the same way a scanned page is. And the notes you have asked Orbit to
            remember are included with every chat question until you remove them in the chat&rsquo;s
            Context panel. Orbit saves one only when you add it yourself or confirm a suggestion
            it offers; it never saves one on its own.
          </p>
          <p>
            Voice notes, the chat microphone and meetings are transcribed by Deepgram instead, on
            Orbit&rsquo;s own key on every plan — see Deepgram under Who else touches your data. If
            Deepgram is unavailable, transcription falls back to the AI provider and key above.
          </p>
          <p>
            If you also add a TypeSafe key, the yes-or-no and ranking steps run on Jev,
            TypeSafe&rsquo;s decision model, on your own TypeSafe account. Each one sees only what
            that step already works from: the emails described above, for deciding which senders in
            a recruiter scan are recruiters; your question and a short card per contact (name,
            title, company, school, tags and summary), for ranking which contacts a chat answer
            draws on, and those same cards for deciding whether two records are one person; a
            calendar event&rsquo;s title, description and the domains &mdash; not the addresses
            &mdash; of its organiser and guests; and a note you captured, for matching the tags it
            proposes against the ones you already have and reading who was actually there. Jev is
            also asked, in front of the slower steps, whether there is anything in a note or a
            message thread worth sending to your chat model at all; when the answer is a confident
            no, that call is not made. Jev only returns yes-or-no answers and scores; it writes
            nothing.
          </p>
          <p>
            Separately, on every account and on Orbit&rsquo;s own TypeSafe account, Jev decides
            whether keeping a contact&rsquo;s work history current needs another web search. It
            reads the job history Orbit already holds for that contact, when it was last checked,
            and short summaries of your notes and messages about them since then &mdash; never the
            notes themselves, an email address or a phone number. When a search was unsure it had
            found the right person, Jev also reads that search&rsquo;s public answer and may decide
            it is someone else, in which case nothing is saved. Either way it can only skip a
            search; it never changes a contact.
          </p>
          <p>
            With Radar on, some of its work runs in the background on your plan&rsquo;s monthly
            allowance: a weekly pass that picks and words your plan, the check for links between
            people you know, drafts written ahead, and the web searches described under{" "}
            <a href="#radar">Radar</a>. Web searches run through your AI provider&rsquo;s own search,
            so the provider sees the text of each search. Background work on Orbit&rsquo;s accounts
            pauses once half a month&rsquo;s credits or fewer remain.
          </p>
          <p>
            Some AI work runs in the background. Search indexing runs when contacts change, so search
            understands meaning. Importing LinkedIn messages writes a short summary for up to 40 of
            the people you talked with most. Deriving timeline events from imported LinkedIn
            conversations happens automatically, on the AI provider and key described
            above: a thread with a single message gets a rule-based note and no AI
            call, and the cap of{" "}
            {TIMELINE_DAILY_CONTACT_CAP} conversations a day only counts the conversations that
            reach the model. When no AI is available to you, Orbit falls back to simple keyword
            matching instead. Settings → Integrations → AI provider shows every call
            from the last 30 days and its estimated cost.
          </p>
          <p>
            <strong>
              Don&rsquo;t store anything in Orbit you would be unwilling to send to an AI provider
            </strong>
            . AI output can be wrong or invented — review anything before you act on it or send it
            to a real person.
          </p>
        </DocSection>

        <DocSection id="payments" index={9} title="Payments">
          <p>
            The Free Plan needs no payment details. Orbit Pro, Orbit Max and credit packs are sold
            through Stripe. Orbit Lifetime is no longer sold.
          </p>
          <p>
            <strong>Orbit never sees your card.</strong> Orbit stores a Stripe customer reference, your
            plan and subscription status, a record of each charge, refund and dispute, and of the
            credits your plan and packs granted and used, for its accounts. When you delete your account, that accounting record is kept with your account
            id removed. Pricing is on the <Link href="/pricing">pricing page</Link>.
          </p>
        </DocSection>
        <DocSection id="cookies" index={10} title="Cookies, local storage, and analytics">
          <p>
            Orbit uses Clerk session cookies to keep you signed in. When you
            first arrive from another site or a link with campaign tags, it also
            sets a first-party cookie, <code>orbit_attr</code>, recording where
            you came from — the referring site and the campaign tags — so we can
            tell which channels bring people here. A second one,{" "}
            <code>orbit_attr_last</code>, records the same for the most recent
            such arrival and is replaced each time you arrive that way again; a
            visit you type in yourself changes neither. What they hold when you
            create an account is saved with it, once. They hold no personal
            information, are never shared, and expire after 90 days. The app also stores
            preferences on your device in <code>localStorage</code> —
            theme flash helpers, saved graph layout positions, and per-device
            notification opt-in. Delivered notification history and account
            preferences live with your account instead. If you turn on push, Orbit stores your
            browser&rsquo;s push address and keys so it can reach that device; they are deleted when
            you turn push off.
          </p>
          <p>
            Orbit counts its own traffic, and does it{" "}
            <strong>without cookies</strong>. Each page view records which page
            was opened, when, and for how long; how long it took to load, and for
            the first page of a visit the browser&apos;s standard performance
            timings (how long the main content took to appear, how quickly the
            page responded to a tap or click, and how much the layout shifted);
            whether it was on a desktop,
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
            Forms that limit how often they can be sent — the waitlist, the
            contact form, the feature poll — count by address the same way: a
            one-way hash, never the address, deleted within two days.
          </p>
          <p>
            While you work, unsent drafts, meeting notes and recent
            notifications are kept in your browser so a reload doesn&apos;t
            lose them. They are removed when they are sent or cleared, and all
            of them when a different account signs in on that browser.
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
            Some things you do leave no record of their own, so Orbit writes a small{" "}
            <strong>product event</strong> for them: using a connected assistant or the browser
            extension, hitting a plan limit, seeing a failure, answering a question. An event is a
            name, the time, your account, and counts or categories from a fixed list. It never
            contains anything you wrote, named, said or received. When a page fails and shows an
            error screen, the event says which part of the site it was and a broad type of failure
            (for example, a page that could not load) — never the error message. A search in
            Contacts, the command menu or the API records how long the search was (up to a cap)
            and how many results came back, never what you searched for, and at most once every
            ten seconds. A desktop notification records its type — a due follow-up, a meeting, a
            test — when it is shown and when it is clicked, never its text. Occasionally a one-tap question
            appears at a natural moment, such as after your first capture or when you cancel; your
            answer is one choice from a short list, and you can dismiss it. The random per-tab id
            described above is also saved once with your waitlist entry when you join, and with
            your account on your first visit after signing up, so Orbit can tell which page a
            sign-up came from; it is not a cookie, and on its own it identifies no one.
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
          <p>
            For email Orbit sends through its email provider, Resend, Resend reports back when a
            message bounces or is marked as spam, which takes that address off Orbit&apos;s waitlist
            mailings. For outreach campaigns sent through Orbit&apos;s own Resend account, Orbit
            also stores when each message was delivered, first opened and first clicked, with the
            message. Resend detects opens with an invisible image in the message and clicks by
            passing links through its own address; mail clients that block images make an open
            invisible. Outreach sent with your own Resend key reports to your Resend account, not
            to Orbit.
          </p>
        </DocSection>

        <DocSection id="controls" index={11} title="Your controls">
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
              including saved API keys and connected accounts, cancels an active Orbit Pro or
              Orbit Max subscription, and removes your sign-in. It cannot be undone.
            </li>
          </ul>
          <p>
            Deleting your account from Clerk&rsquo;s own account page does the same deletion through
            our account webhook. Settings → Integrations → AI provider shows your AI usage, and you
            can disconnect any connected account from the Integrations dialog.
          </p>
        </DocSection>

        <DocSection id="retention" index={12} title="How long data is kept">
          <p>
            Your Orbit data is kept while your account is active, until you delete it with the
            controls above. Downgrading never deletes anything: contacts added while you were
            subscribed stay visible and exportable on the Free Plan, and unused pack credits stay
            spendable.
          </p>
          <p>
            Capture photos stay with the capture they belong to until you delete it; photos from a
            capture you never save are deleted after 24 hours. Files attached to an email are deleted 7
            days after it is sent or canceled, and files you uploaded but never sent after 2 days.
            Audio is never kept. Page views are
            deleted after 180 days; deleting your data or your account unlinks the ones made while
            you were signed in, keeping only the anonymous count.
          </p>
          <p>
            Radar&rsquo;s suggestions you acted on, hid or let expire are kept as history while your
            account exists. Finds you didn&rsquo;t save (events, people and programs from its web
            searches) are deleted 30 days after they end or expire. A push subscription is deleted
            when you turn push off or the push service reports it gone.
          </p>
          <p>
            Records of AI calls (which operation ran, on which model, whether it worked, never what
            you sent or got back) are deleted after 180 days, and error records after 30. Product
            events, described under cookies and analytics, are deleted after 400 days and with your
            account, as are the records of limits you hit. Logs of scheduled jobs and incoming
            webhooks are deleted after 90 days, and the recipient address in an email-delivery log
            after 30. If you joined the waitlist before creating an account, your email address and
            name leave that entry 30 days after you accept your invite, and at once if you delete
            your account.
          </p>
          <p>
            A shared photo or shared work history is deleted within a day once no Orbit
            account has that person, and a shared work history after 90 days at most. To have one
            removed sooner, email us through the <Link href="/contact">contact page</Link>.
          </p>
          <p>
            When you delete your account, every table holding your data is cleared, including your
            settings, keys and tokens. What remains: Stripe&rsquo;s own records of your payments,
            held by Stripe; Orbit&rsquo;s accounting record of charges, refunds and credit packs, with
            your account id removed; the operator&rsquo;s audit log of actions taken on your account,
            which refers to an account id that no longer exists and can keep a short excerpt of
            feedback you sent; and operational logs of up to 90 days that can name an account id.
            Encrypted database backups are kept for 90 days, so deleted data
            leaves the last backup within 90 days.
          </p>
        </DocSection>

        <DocSection id="security" index={13} title="Security">
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

        <DocSection id="operator-access" index={14} title="Operator access">
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
              screenshot you attach, is read by the operator. Its text, the area of Orbit it is
              about and the page you were on are also read by an AI model on Orbit&rsquo;s own
              account with Google Gemini, OpenAI or Anthropic, which writes a one-line summary,
              sorts it by kind and urgency, and notes when it repeats an earlier report. This
              never uses your AI credits or your own key, and screenshots are not sent.
            </li>
          </ul>
          <p>
            The operator can comp or revoke a plan, suspend or delete an account, retry or cancel an
            import, reset onboarding, disconnect an integration, turn a calendar feed on or off, remove a shared LinkedIn photo (which also removes that profile&rsquo;s shared work history), and
            create a one-time link that signs in as your account (for support, and for the demo
            account). Each of these requires a written reason, recorded in an audit log. Opening your
            account is recorded, and so is every individual contact record opened, by its id.
          </p>
          <p>
            The operator looks only to answer a support request from you, to investigate abuse, a
            security problem or a failure affecting your account, or where the law requires it.
          </p>
        </DocSection>

        <DocSection id="transfers" index={15} title="Where data is processed">
          <p>
            Orbit&rsquo;s hosting, database, payment and AI providers operate globally, so your data
            may be processed outside the country you live in — most often the United States. Where
            you supply your own API keys, the processing location follows what you configured with
            that vendor.
          </p>
        </DocSection>

        <DocSection id="children" index={16} title="Children">
          <p>
            Orbit is not directed at children under 13, and we do not knowingly collect personal
            information from them. If you believe a child has provided information to Orbit, get in
            touch and it will be removed.
          </p>
        </DocSection>

        <DocSection id="changes" index={17} title="Changes to this policy">
          <p>
            This policy will change as the product does. The <strong>Last updated</strong> date at
            the top is revised whenever it happens, and material changes are called out in the app.
            Continuing to use Orbit after a change means you accept the updated policy.
          </p>
        </DocSection>

        <DocSection id="contact" index={18} title="Questions">
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
