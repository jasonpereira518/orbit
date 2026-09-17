import type { ComponentType } from "react";
import {
  BellRing,
  MessageCircleQuestion,
  NotebookPen,
  Orbit,
  Puzzle,
  Send,
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
 * The feature highlights, as data. Every product surface a user can reach appears in one
 * chapter — adding a surface to the app without a line here is how the old tour ended up
 * never mentioning Events, Knowledge or the extension.
 *
 * `entitlement` marks a line as Pro for viewers whose plan lacks it (entitlements already
 * resolve every flag on for Lifetime and the localhost demo account). `surfaceKey` drops the
 * whole chapter when an operator has hidden that surface from this viewer.
 */

export type PlanFlag = keyof Pick<
  Entitlements,
  "canUseOutreach" | "canUseHostedSending" | "canUseRecruiters" | "canUseSync" | "canUseExtension" | "canUseApi"
>;

export type HighlightChapter = {
  id: string;
  icon: LucideIcon;
  /** Short label for the chapter rail. */
  label: string;
  title: string;
  blurb: string;
  bullets: Array<{ label: string; entitlement?: PlanFlag }>;
  /** The whole chapter is a paid feature. */
  entitlement?: PlanFlag;
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
      "Dump messy notes, talk it through, or scan a page with your phone. Orbit pulls out who you met, what you talked about, and what to do next.",
    bullets: [
      { label: "Messy notes become people and reminders" },
      { label: "Voice capture while it’s still fresh" },
      { label: "Meeting notes become opportunities and next steps" },
      { label: "Scan business cards and notebooks from your phone" },
    ],
    surfaceKey: "page.capture",
    Preview: CapturePreview,
  },
  {
    id: "people",
    icon: Users,
    label: "Your people",
    title: "Everyone, with context",
    blurb:
      "Each person gets a living profile: how you met, where they work, what you talked about, and how close you are.",
    bullets: [
      { label: "Briefs and timelines on every contact" },
      { label: "Referrals, intros and cadence pulled from your notes" },
      { label: "Duplicates merged for you, and undoable" },
      { label: "Recruiters tracked separately from friends", entitlement: "canUseRecruiters" },
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
      "Your dashboard says who to reach out to and why, and reminders make sure it actually happens.",
    bullets: [
      { label: "Suggested follow-ups on your dashboard" },
      { label: "Reminders with due dates and snooze" },
      { label: "Desktop notifications when something is due" },
      { label: "Goals and target companies to aim at" },
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
      "Search by meaning, not just by name. Ask who can help and get an answer grounded in your own notes.",
    bullets: [
      { label: "Chat with everything Orbit knows about your network" },
      { label: "An ask bar on every page" },
      { label: "⌘K to jump to anyone or anything" },
      { label: "A knowledge base built from your imports and notes" },
    ],
    surfaceKey: "page.chat",
    Preview: AskPreview,
  },
  {
    id: "constellation",
    icon: Orbit,
    label: "Constellation",
    title: "See your network as a sky",
    blurb:
      "The Constellation draws who you know by company and closeness, and Events shows who you’ll see where.",
    bullets: [
      { label: "A living map of your whole network" },
      { label: "Events with rosters and who to talk to first" },
      { label: "Calendar sync for your events", entitlement: "canUseSync" },
    ],
    surfaceKey: "page.graph",
    Preview: ConstellationPreview,
  },
  {
    id: "outreach",
    icon: Send,
    label: "Outreach",
    title: "Reach out at scale, and still personally",
    blurb:
      "Build a campaign, let AI draft a note for each person from what you know about them, then send and track replies.",
    bullets: [
      { label: "Campaigns and prospect lists" },
      { label: "A personal AI draft for every person" },
      { label: "Send and track replies from Orbit", entitlement: "canUseHostedSending" },
    ],
    entitlement: "canUseOutreach",
    surfaceKey: "page.outreach",
    Preview: OutreachPreview,
  },
  {
    id: "everywhere",
    icon: Puzzle,
    label: "Everywhere",
    title: "Orbit comes with you",
    blurb:
      "Save people straight from LinkedIn, bring in your address books, and connect Orbit to the tools you already use.",
    bullets: [
      { label: "Chrome extension for LinkedIn and Gmail", entitlement: "canUseExtension" },
      { label: "Import Google and Outlook contacts" },
      { label: "Gmail and calendar sync", entitlement: "canUseSync" },
      { label: "API, webhooks and MCP", entitlement: "canUseApi" },
    ],
    surfaceKey: "page.imports",
    Preview: EverywherePreview,
  },
];

export function visibleChapters(hidden: ReadonlySet<string>): HighlightChapter[] {
  return HIGHLIGHT_CHAPTERS.filter((c) => !c.surfaceKey || !hidden.has(c.surfaceKey));
}
