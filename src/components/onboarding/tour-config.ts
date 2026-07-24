import type { ComponentType } from "react";
import {
  LayoutDashboard,
  Users,
  Sparkles,
  Upload,
  MessageSquare,
  Network,
  Send,
  Bell,
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
  | "start";

export type TourHotspot = {
  /** Matches `data-tour-hotspot` on a preview element. */
  id: string;
  /** Short chat-bubble copy shown while the cursor points here. */
  label: string;
};

export type TourStep = {
  id: TourNavKey;
  /** Sidebar highlight key — recruiters lights up Contacts (product nav model). */
  navKey: TourNavKey | null;
  title: string;
  body: string;
  /** When true, show add-first-people CTAs instead of a preview. */
  isStart?: boolean;
  /** Elements the guided cursor points to, in order, during this step. */
  hotspots?: TourHotspot[];
};

/** Core loop items — order matches `APP_NAV_CORE`. */
export const TOUR_NAV_CORE = [
  { key: "dashboard" as const, label: "Dashboard", icon: LayoutDashboard },
  { key: "contacts" as const, label: "Contacts", icon: Users },
  { key: "capture" as const, label: "Capture", icon: Sparkles },
  { key: "imports" as const, label: "Imports", icon: Upload },
  { key: "reminders" as const, label: "Reminders", icon: Bell },
  { key: "chat" as const, label: "Chat", icon: MessageSquare },
  { key: "graph" as const, label: "Constellation", icon: Network },
];

/** Extra feature items — matches `APP_NAV_EXTRAS` (Outreach only). */
export const TOUR_NAV_EXTRAS = [
  { key: "outreach" as const, label: "Outreach", icon: Send },
];

export const TOUR_NAV = [...TOUR_NAV_CORE, ...TOUR_NAV_EXTRAS];

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
    body: "Follow-ups, reminders, and outreach suggestions — in one place. Press ⌘K anytime to ask your network.",
    hotspots: [
      { id: "due", label: "See who's due a follow-up." },
      { id: "suggestion", label: "AI suggests who to reach out to." },
      { id: "reminder", label: "Open reminders for quick actions." },
    ],
  },
  {
    id: "contacts",
    navKey: "contacts",
    title: "Your contacts",
    body: "Browse, search, and open anyone in your network — closeness shows how strong each orbit is.",
    hotspots: [
      { id: "toggle", label: "Switch to Recruiters anytime." },
      { id: "search", label: "Search anyone in your network." },
      { id: "contact", label: "Open a person for full context." },
      { id: "score", label: "Closeness % and orbit tier at a glance." },
    ],
  },
  {
    id: "recruiters",
    navKey: "contacts",
    title: "Recruiters",
    body: "Track recruiters alongside contacts. Unlock details when you log an interaction — or import threads from Gmail.",
    hotspots: [
      { id: "toggle", label: "Recruiters live next to Contacts." },
      { id: "recruiter", label: "Open a recruiter to log outreach." },
      { id: "gmail", label: "Import recruiter threads from Gmail." },
    ],
  },
  {
    id: "capture",
    navKey: "capture",
    title: "Capture from notes",
    body: "Paste messy meeting notes or use structured mode — AI extracts people for you to confirm.",
    hotspots: [
      { id: "mode", label: "Messy paste or structured log." },
      { id: "notes", label: "Paste raw meeting notes here." },
      { id: "extraction", label: "AI pulls out people & follow-ups." },
    ],
  },
  {
    id: "imports",
    navKey: "imports",
    title: "Import your world",
    body: "Bring in LinkedIn connections, messages, or calendar meetings — then browse everything in Knowledge.",
    hotspots: [
      { id: "linkedin", label: "Import LinkedIn connections." },
      { id: "messages", label: "Enrich from message threads." },
      { id: "calendar", label: "Sync meetings from your calendar." },
      { id: "knowledge", label: "Search imported context in Knowledge." },
    ],
  },
  {
    id: "reminders",
    navKey: "reminders",
    title: "Reminders",
    body: "Organize follow-ups into lists, snooze what can wait, and take quick actions when something's due.",
    hotspots: [
      { id: "list", label: "Group reminders into lists." },
      { id: "item", label: "Open a reminder for quick actions." },
      { id: "action", label: "Done, snooze, or follow up." },
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
    body: "You are the sun — people form constellations by company and school, brightest when closest.",
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
  {
    id: "start",
    navKey: null,
    title: "Add your first people",
    body: "Orbit works best once someone is in your network. Pick how you want to start.",
    isStart: true,
    hotspots: [
      { id: "path-manual", label: "Add someone by hand." },
      { id: "path-capture", label: "Or extract people from notes." },
      { id: "path-import", label: "Or import LinkedIn / calendar." },
    ],
  },
];

export type PreviewProps = {
  reducedMotion?: boolean;
};

export type PreviewComponent = ComponentType<PreviewProps>;
