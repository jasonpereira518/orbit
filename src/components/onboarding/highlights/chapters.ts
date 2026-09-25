import type { ComponentType } from "react";
import {
  BellRing,
  MessageCircleQuestion,
  NotebookPen,
  Orbit,
  Telescope,
  Upload,
  Users,
  type LucideIcon,
} from "lucide-react";
import {
  AskPreview,
  CapturePreview,
  ConstellationPreview,
  EverywherePreview,
  FollowUpsPreview,
  OutreachPreview,
  PeoplePreview,
} from "@/components/onboarding/highlights/previews";
import type { Entitlements } from "@/lib/entitlements";

/**
 * Quick setup's overview, as data: one chapter per thing a new account can do today, and a
 * last chapter for what is still in dry dock. Every product surface a user can reach appears
 * in one chapter — adding a surface to the app without a line here is how the old tour
 * ended up never mentioning Events, Knowledge or the extension.
 *
 * `entitlement` marks a line as Pro for viewers whose plan lacks it (entitlements already
 * resolve every flag on for Lifetime and the localhost demo account). `soon` marks a line
 * whose page is behind the coming-soon screen. `needs` is what the chapter's page wants
 * before it is useful, shown as a live tag from the account's real state. `surfaceKey`
 * drops the whole chapter when an operator has hidden that surface from this viewer.
 */

export type PlanFlag = keyof Pick<
  Entitlements,
  "canUseOutreach" | "canUseHostedSending" | "canUseRecruiters" | "canUseSync" | "canUseExtension" | "canUseApi"
>;

export type ChapterNeed = "ai" | "linkedin";

export type HighlightChapter = {
  id: string;
  icon: LucideIcon;
  /** Short label for the chapter rail. */
  label: string;
  title: string;
  blurb: string;
  bullets: Array<{ label: string; entitlement?: PlanFlag; soon?: boolean }>;
  /** The whole chapter is a paid feature. */
  entitlement?: PlanFlag;
  /** What this chapter's page needs before it does anything: tagged from live facts. */
  needs?: ChapterNeed;
  surfaceKey?: string;
  Preview: ComponentType;
};

export const HIGHLIGHT_CHAPTERS: HighlightChapter[] = [
  {
    id: "capture",
    icon: NotebookPen,
    label: "Capture",
    title: "Capture people in seconds",
    blurb:
      "Paste messy notes, talk it through, or scan a page with your phone. Orbit pulls out who you met, what you talked about, and what to do next.",
    bullets: [
      { label: "Messy notes become people and reminders" },
      { label: "Voice and meeting capture while it’s still fresh" },
      { label: "Scan business cards and notebooks from your phone" },
      { label: "A pasted LinkedIn URL logs a person with no key at all" },
    ],
    needs: "ai",
    surfaceKey: "page.capture",
    Preview: CapturePreview,
  },
  {
    id: "people",
    icon: Users,
    label: "Your people",
    title: "Everyone, with context",
    blurb:
      "Each person gets a living profile: how you met, where they work, what you talked about, and how close you are. Knowledge keeps every note you wrote findable.",
    bullets: [
      { label: "Briefs and timelines on every contact" },
      { label: "Closeness that reflects how you actually keep in touch" },
      { label: "Duplicates merged for you, and undoable" },
      { label: "Your notes and imports, searchable in Knowledge" },
    ],
    surfaceKey: "page.contacts",
    Preview: PeoplePreview,
  },
  {
    id: "follow-ups",
    icon: BellRing,
    label: "Follow-ups",
    title: "Never let a connection go cold",
    blurb:
      "Your dashboard says who to reach out to and why, and Reminders makes sure it actually happens.",
    bullets: [
      { label: "Who’s due today, on your dashboard" },
      { label: "Reminders with due dates, lists and snooze" },
      { label: "Desktop notifications when something is due" },
      { label: "A calendar feed of your follow-ups" },
    ],
    surfaceKey: "page.reminders",
    Preview: FollowUpsPreview,
  },
  {
    id: "ask",
    icon: MessageCircleQuestion,
    label: "Ask Orbit",
    title: "Ask your network anything",
    blurb:
      "Ask who can help and get an answer grounded in your own notes, with the source behind every claim.",
    bullets: [
      { label: "Answers quote the note they came from" },
      { label: "Log it, remind me, follow up: proposed, saved when you confirm" },
      { label: "An ask bar on every page, ⌘K to jump anywhere" },
      { label: "Runs on the AI key you bring" },
    ],
    needs: "ai",
    surfaceKey: "page.chat",
    Preview: AskPreview,
  },
  {
    id: "constellation",
    icon: Orbit,
    label: "Constellation",
    title: "See your network as a sky",
    blurb:
      "You’re the sun. Companies and schools form constellations around you, each traced by the people you know there.",
    bullets: [
      { label: "A living map of your whole network" },
      { label: "Clustered by company" },
      { label: "Search lights up the people who match" },
      { label: "Grows as you log notes and meetings" },
    ],
    surfaceKey: "page.graph",
    Preview: ConstellationPreview,
  },
  {
    id: "imports",
    icon: Upload,
    label: "Imports",
    title: "Bring in the people you already know",
    blurb:
      "LinkedIn, Google and Outlook, contact files and calendars all feed one orbit. Upload a file and review everyone before they land.",
    bullets: [
      { label: "LinkedIn connections and messages, ZIP and all" },
      { label: "Google and Outlook contacts, free on every plan" },
      { label: "vCard and CSV from any address book" },
      { label: "Calendar sync for your meetings", entitlement: "canUseSync" },
    ],
    needs: "linkedin",
    surfaceKey: "page.imports",
    Preview: EverywherePreview,
  },
  {
    id: "ahead",
    icon: Telescope,
    label: "What’s ahead",
    title: "More on the way",
    blurb:
      "Some of Orbit is still in dry dock. Here’s what’s coming, and what a plan unlocks today.",
    bullets: [
      { label: "Recruiters: conversations tracked apart from friends", entitlement: "canUseRecruiters" },
      { label: "Outreach: a personal AI draft for every person", soon: true },
      { label: "Events: who you’ll see where, with rosters", soon: true },
      { label: "A Chrome extension that saves people from LinkedIn", soon: true },
      { label: "Orbit inside Claude and ChatGPT, free on every plan" },
    ],
    Preview: OutreachPreview,
  },
];

export function visibleChapters(hidden: ReadonlySet<string>): HighlightChapter[] {
  return HIGHLIGHT_CHAPTERS.filter((c) => !c.surfaceKey || !hidden.has(c.surfaceKey));
}
