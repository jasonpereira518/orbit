import {
  LayoutDashboard,
  Users,
  Sparkles,
  Upload,
  Bell,
  MessageSquare,
  Network,
  Send,
} from "lucide-react";

export const TOUR_INTERVAL_MS = 7000;

export type TourNavKey =
  | "welcome"
  | "dashboard"
  | "contacts"
  | "recruiters"
  | "capture"
  | "imports"
  | "reminders"
  | "chat"
  | "graph"
  | "outreach";

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

/**
 * Core loop items (before the Extras divider in the tour sidebar), in the same order
 * as the real app sidebar (`APP_NAV_CORE`). Recruiters has no entry here — it's a
 * toggle inside Contacts, not its own destination.
 */
export const TOUR_NAV_CORE = [
  { key: "dashboard" as const, label: "Dashboard", icon: LayoutDashboard },
  { key: "contacts" as const, label: "Contacts", icon: Users },
  { key: "capture" as const, label: "Capture", icon: Sparkles },
  { key: "imports" as const, label: "Imports", icon: Upload },
  { key: "reminders" as const, label: "Reminders", icon: Bell },
  { key: "chat" as const, label: "Chat", icon: MessageSquare },
  { key: "graph" as const, label: "Constellation", icon: Network },
];

/** Extra feature items (after the Extras divider), matching `APP_NAV_EXTRAS`. */
export const TOUR_NAV_EXTRAS = [
  { key: "outreach" as const, label: "Outreach", icon: Send },
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
    body: "Follow-ups, dormant ties, and outreach suggestions — in one place.",
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
    id: "recruiters",
    // Highlights Contacts, not a "Recruiters" pill — the real sidebar has no such
    // destination. This step lives right after Contacts because that's where the
    // toggle actually is.
    navKey: "contacts",
    title: "Recruiters",
    body: "Flip the toggle inside Contacts to track recruiters. Share your list to see everyone else's, scan Gmail for threads, and draft outreach you review before it sends.",
    hotspots: [
      { id: "toggle", label: "This toggle lives inside Contacts — not its own tab." },
      { id: "sharing", label: "Share your list to unlock the shared pool." },
      { id: "scan", label: "Scan your whole mailbox for recruiter threads." },
      { id: "compose", label: "Draft outreach — you review before anything sends." },
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
    body: "Bring in LinkedIn connections, messages, or calendar meetings — it all feeds your searchable Knowledge base too.",
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
    body: "Everything due or overdue lands here — filter by status and clear it in one click.",
    hotspots: [
      { id: "status", label: "Filter by Active, Done, or All." },
      { id: "reminder", label: "Overdue and type badges at a glance." },
      { id: "actions", label: "Mark done or snooze a week, right from the list." },
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
    body: "See your network as a sky of connections — clustered by company and closeness.",
    hotspots: [
      { id: "figure", label: "People linked into a constellation." },
      { id: "spica", label: "Brightest stars are your closest ties." },
    ],
  },
  {
    id: "outreach",
    navKey: "outreach",
    title: "Outreach",
    body: "Run cold campaigns — find prospects, generate drafts, and send from your apps.",
    hotspots: [
      { id: "campaign", label: "Your campaigns live here." },
      { id: "new", label: "Start a new cold outreach campaign." },
      { id: "draft", label: "AI drafts messages you can edit & send." },
    ],
  },
];

export type PreviewProps = {
  reducedMotion?: boolean;
};
