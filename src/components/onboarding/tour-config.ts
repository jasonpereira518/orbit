import {
  LayoutDashboard,
  Users,
  Sparkles,
  Upload,
  Bell,
  MessageSquare,
  Network,
  UsersRound,
  Send,
  BookOpen,
} from "lucide-react";

export const TOUR_INTERVAL_MS = 7000;

export type TourNavKey =
  | "welcome"
  | "dashboard"
  | "contacts"
  | "capture"
  | "imports"
  | "reminders"
  | "chat"
  | "graph"
  | "recruiters"
  | "outreach"
  | "knowledge";

export type TourHotspot = {
  /** Matches `data-tour-hotspot` on a preview element. */
  id: string;
  /** Short chat-bubble copy shown while the cursor points here. */
  label: string;
};

export type TourStep = {
  id: TourNavKey;
  navKey: TourNavKey | null;
  title: string;
  body: string;
  /** Elements the guided cursor points to, in order, during this step. */
  hotspots?: TourHotspot[];
};

/** Core loop items (before the Extras divider in the tour sidebar) — mirrors the real app-nav.ts order. */
export const TOUR_NAV_CORE = [
  { key: "dashboard" as const, label: "Dashboard", icon: LayoutDashboard },
  { key: "contacts" as const, label: "Contacts", icon: Users },
  { key: "capture" as const, label: "Capture", icon: Sparkles },
  { key: "imports" as const, label: "Imports", icon: Upload },
  { key: "reminders" as const, label: "Reminders", icon: Bell },
  { key: "chat" as const, label: "Chat", icon: MessageSquare },
  { key: "graph" as const, label: "Constellation", icon: Network },
];

/** Extra feature items (after the Extras divider) — Recruiters has no nav link of its own
 *  (it's a toggle inside Contacts) but earns a tour step; Outreach and Knowledge mirror
 *  the real APP_NAV_EXTRAS order. */
export const TOUR_NAV_EXTRAS = [
  { key: "recruiters" as const, label: "Recruiters", icon: UsersRound },
  { key: "outreach" as const, label: "Outreach", icon: Send },
  { key: "knowledge" as const, label: "Knowledge", icon: BookOpen },
];

export const TOUR_STEPS: TourStep[] = [
  {
    id: "welcome",
    navKey: "welcome",
    title: "Welcome to Orbit",
    body: "Remember the people who matter — and know when to reach out.",
    hotspots: [
      { id: "logo", label: "This is your networking home base." },
      { id: "tagline", label: "Capture people, then know when to act." },
    ],
  },
  {
    id: "dashboard",
    navKey: "dashboard",
    title: "Your dashboard",
    body: "Follow-ups, strong ties, and outreach suggestions — in one place.",
    hotspots: [
      { id: "due", label: "See who's due a follow-up." },
      { id: "suggestion", label: "AI suggests who to reach out to." },
    ],
  },
  {
    id: "contacts",
    navKey: "contacts",
    title: "Your contacts",
    body: "Browse, search, and open anyone in your network.",
    hotspots: [
      { id: "search", label: "Search anyone in your network." },
      { id: "contact", label: "Open a person for full context." },
      { id: "score", label: "Closeness score at a glance." },
    ],
  },
  {
    id: "capture",
    navKey: "capture",
    title: "Capture from notes",
    body: "Paste meeting notes — AI extracts people for you to confirm.",
    hotspots: [
      { id: "notes", label: "Paste raw meeting notes here." },
      { id: "extraction", label: "AI pulls out people & follow-ups." },
    ],
  },
  {
    id: "imports",
    navKey: "imports",
    title: "Import your world",
    body: "Bring in LinkedIn connections, messages, or calendar meetings.",
    hotspots: [
      { id: "linkedin", label: "Import LinkedIn connections." },
      { id: "messages", label: "Enrich from message threads." },
      { id: "calendar", label: "Sync meetings from your calendar." },
    ],
  },
  {
    id: "reminders",
    navKey: "reminders",
    title: "Reminders",
    body: "Turn follow-ups into a real to-do list — organized into lists, with due dates that don't let you forget.",
    hotspots: [
      { id: "filter", label: "Filter by pending, done, or all." },
      { id: "reminder", label: "See what's overdue at a glance." },
      { id: "action", label: "Mark done or snooze in one tap." },
    ],
  },
  {
    id: "chat",
    navKey: "chat",
    title: "Chat with your network",
    body: "Ask who can help, who to follow up with, or who knows what.",
    hotspots: [
      { id: "question", label: "Ask natural questions like this." },
      { id: "answer", label: "Get concrete people & next steps." },
    ],
  },
  {
    id: "graph",
    navKey: "graph",
    title: "Constellation",
    body: "See your network as a spiral galaxy — you're the sun at the center, with clusters of people orbiting by company and closeness.",
    hotspots: [
      { id: "sun", label: "You're the sun — everyone orbits you." },
      { id: "cluster", label: "Each cluster is its own constellation." },
    ],
  },
  {
    id: "recruiters",
    navKey: "recruiters",
    title: "Recruiters",
    body: "A toggle away from Contacts (Orbit Pro/Lifetime). Orbit scans your whole mailbox for recruiter threads, and you can share your list to see everyone else's.",
    hotspots: [
      { id: "sharing", label: "Share your list to unlock everyone else's." },
      { id: "gmail", label: "Scans your whole mailbox in the background." },
      { id: "compose", label: "AI drafts outreach you review & send." },
      { id: "recruiter", label: "Open a recruiter for the full thread." },
    ],
  },
  {
    id: "outreach",
    navKey: "outreach",
    title: "Outreach",
    body: "One of Orbit's extras (Pro/Lifetime) — run cold campaigns, find prospects, generate drafts, and send from your apps.",
    hotspots: [
      { id: "campaign", label: "Your campaigns live here." },
      { id: "new", label: "Start a new cold outreach campaign." },
      { id: "draft", label: "AI drafts messages you can edit & send." },
    ],
  },
  {
    id: "knowledge",
    navKey: "knowledge",
    title: "Knowledge",
    body: "Everything Orbit has read about your network — messages, notes, and AI summaries — searchable in one place and ready for Chat.",
    hotspots: [
      { id: "stats", label: "See how much Orbit knows so far." },
      { id: "entry", label: "Every note, message, and summary." },
    ],
  },
];

export type PreviewProps = {
  reducedMotion?: boolean;
};
