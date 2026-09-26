import type { Metadata } from "next";
import { Bot, KeyRound, ShieldCheck, Sparkles } from "lucide-react";
import {
  DocBody,
  DocCallout,
  DocFooterCta,
  DocHero,
  DocHighlights,
  DocSection,
} from "@/components/marketing/marketing-doc";
import { MarketingDocShell } from "@/components/marketing/marketing-doc";
import { isClerkConfigured, isDemoMode } from "@/lib/auth";

/**
 * How to use Orbit from an assistant.
 *
 * Its own route rather than a page in the `(docs)` group: that group's switcher is the
 * legal-and-contact rail (Privacy / Terms / Contact), and a setup guide sitting under it
 * would render a switcher with nothing active. It reuses the same document components, so
 * it reads as part of the same family without joining that set.
 */
export const metadata: Metadata = {
  title: "Use Orbit from Claude and ChatGPT — Orbit",
  description:
    "Connect Orbit to Claude, ChatGPT, Claude Code or Cursor. Ask who you know, log what you discussed, and let your assistant draft a message you approve before it sends.",
};

const HIGHLIGHTS = [
  {
    icon: Sparkles,
    title: "Ask in the assistant you already use",
    body: "“Who do I know at Stripe?” answered from your own network, in the chat window you had open anyway.",
  },
  {
    icon: Bot,
    title: "It can write things down",
    body: "Log a coffee, add a note, set a reminder, schedule a follow-up — without opening Orbit.",
  },
  {
    icon: ShieldCheck,
    title: "It cannot send anything",
    body: "Your assistant can draft an email. It waits on your dashboard until you read it and press send.",
  },
  {
    icon: KeyRound,
    title: "Free on every plan",
    body: "Sign in once when you connect. There is no key to copy and nothing to paste into a settings file.",
  },
] as const;

const TOC = [
  { id: "claude", label: "Claude" },
  { id: "chatgpt", label: "ChatGPT" },
  { id: "cli", label: "Claude Code and Cursor" },
  { id: "what-it-can-do", label: "What it can do" },
  { id: "safety", label: "What it cannot do" },
] as const;

export default function ConnectPage() {
  return (
    <MarketingDocShell
      clerkOn={isClerkConfigured()}
      demoMode={isDemoMode()}
      switcher={false}
    >
      <DocHero
        eyebrow="Connectors"
        title="Use Orbit from Claude and ChatGPT"
        lede={
          <>
            Orbit speaks MCP, the protocol assistants use to reach the tools you already have.
            Connect it once and your network becomes something you can ask about in plain
            language — and write to — without leaving the conversation.
          </>
        }
        meta={[
          { label: "Plans", value: "All, including free" },
          { label: "Setup", value: "About a minute" },
        ]}
      />

      <DocHighlights kicker="Why bother" items={HIGHLIGHTS} />

      <DocBody toc={TOC}>
        <DocSection id="claude" index={1} title="Claude">
          <ol>
            <li>Open Settings → Connectors → Add custom connector.</li>
            <li>
              Paste your Orbit connector URL. You will find it in Orbit under Settings → API
              and connectors; it is your Orbit address followed by <code>/api/mcp</code>.
            </li>
            <li>Press Connect, then sign in to Orbit on the page that opens.</li>
          </ol>
          <p>
            That sign-in is the whole authorisation. Claude never sees an Orbit password or a
            key, and you can disconnect it from Claude at any time.
          </p>
        </DocSection>

        <DocSection id="chatgpt" index={2} title="ChatGPT">
          <ol>
            <li>Open Settings → Connectors → Add.</li>
            <li>Paste the same URL and choose OAuth when it asks how to authenticate.</li>
            <li>Sign in to Orbit, and approve the connection.</li>
          </ol>
        </DocSection>

        <DocSection id="cli" index={3} title="Claude Code and Cursor">
          <p>
            Tools that run on your own machine can use the same URL. Where one asks for a
            bearer token instead of a sign-in, create an API key in Orbit under Settings → API
            and connectors and send it as an <code>Authorization: Bearer</code> header.
          </p>
          <DocCallout title="One key, one purpose">
            Give each tool its own key and name it after the tool. Then revoking the one you
            stopped using does not break the two you still do.
          </DocCallout>
        </DocSection>

        <DocSection id="what-it-can-do" index={4} title="What it can do">
          <p>
            Read: search your contacts, open one person’s history, find who you know at a
            company, list what is due, and summarise the shape of your network.
          </p>
          <p>
            Write: add a contact, update their details, write a note, log a conversation,
            create a reminder, complete or snooze one, and schedule a follow-up. Anything an
            assistant writes is marked as such on the timeline, so you can always tell your own
            words from its.
          </p>
        </DocSection>

        <DocSection id="safety" index={5} title="What it cannot do">
          <p>
            It cannot delete a contact, merge two people, or send a message. The first two are
            simply not offered. The third is the important one: an assistant can compose an
            email and ask, and the message then sits on your dashboard with the recipient and
            the wording in plain sight until you press send.
          </p>
          <p>
            That distinction matters more than it sounds. Assistants read whatever is in front
            of them, and text on a web page or in an email can try to give them instructions.
            Orbit’s answer is not to hope the assistant sees through it — it is to make sure
            nothing the assistant can reach is able to send anything anywhere.
          </p>
        </DocSection>
      </DocBody>

      <DocFooterCta
        title="Your network, in the window you already have open"
        body="Connect Orbit to your assistant and ask it something. It works on every plan, free included."
        primary={{ href: "/settings?integration=assistants", label: "Get your Orbit link" }}
        secondary={{ href: "/pricing", label: "See plans" }}
      />
    </MarketingDocShell>
  );
}
