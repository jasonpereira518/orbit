/** Client-safe limits and allowlists. Voice never exposes arbitrary MCP or web tools. */
export const VOICE_DURATION_SECONDS = 600;
export const VOICE_MAX_TOOL_CALLS = 60;
/** Small changes one Cosmo call may apply without a click; the rest wait on a card. */
export const VOICE_AUTO_APPLY_CAP = 5;
export function voiceAvailable(
  enabled: boolean | null | undefined,
  configured: boolean,
): boolean {
  return enabled === true && configured;
}

/**
 * The pages Orbit Voice may open (`open_page`). Runs in the browser, never on the server: the
 * call itself survives navigation (VoiceDock), so "show me Ada" can open her profile mid-call.
 * A fixed map, never a model-written URL; record pages take only a UUID.
 */
export const VOICE_PAGES = {
  dashboard: "/dashboard",
  contacts: "/contacts",
  contact: "/contacts/:id",
  chat: "/chat",
  capture: "/capture",
  reminders: "/reminders",
  meetings: "/meetings",
  events: "/events",
  event: "/events/:id",
  constellation: "/graph",
  knowledge: "/knowledge",
  radar: "/radar",
  recruiters: "/recruiters",
  outreach: "/outreach",
  find_people: "/find",
  settings: "/settings",
} as const;
export type VoicePage = keyof typeof VOICE_PAGES;
export const OPEN_PAGE_TOOL = "open_page";
/** Browser-side tools besides open_page: run in voice-panel, never on the server. */
export const ASK_CHAT_TOOL = "ask_chat";
export const START_RECORDING_TOOL = "start_recording";
export const SET_THEME_TOOL = "set_theme";
export const SET_CAPTIONS_TOOL = "set_captions";
export const LOOK_AT_SCREEN_TOOL = "look_at_screen";
export const POINT_AT_TOOL = "point_at";
export const VOICE_THEMES = ["light", "dark", "system"] as const;

/**
 * The filters a page reads from its URL, so "show me everyone at Google" lands on a filtered
 * list. Only these names pass, each a short plain string; the page validates values itself.
 */
export const VOICE_PAGE_FILTERS: Partial<Record<VoicePage, readonly string[]>> = {
  contacts: ["q", "company", "tag", "school", "followUp"],
  reminders: ["view", "q", "new", "title", "due"],
  meetings: ["q"],
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The app path for a page, or null when the page is unknown or a record page lacks a valid id. */
export function voicePagePath(page: unknown, id?: unknown, filters?: unknown): string | null {
  if (typeof page !== "string" || !Object.hasOwn(VOICE_PAGES, page)) return null;
  let path: string = VOICE_PAGES[page as VoicePage];
  if (path.includes(":id")) {
    if (typeof id !== "string" || !UUID.test(id)) return null;
    path = path.replace(":id", id);
  }
  const allowed = VOICE_PAGE_FILTERS[page as VoicePage] ?? [];
  const query = new URLSearchParams();
  if (filters && typeof filters === "object")
    for (const name of allowed) {
      const value = (filters as Record<string, unknown>)[name];
      if (typeof value === "string" && value.trim()) query.set(name, value.trim().slice(0, 120));
    }
  const qs = query.toString();
  return qs ? `${path}?${qs}` : path;
}
