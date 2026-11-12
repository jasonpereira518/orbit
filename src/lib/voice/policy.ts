/** Client-safe limits and allowlists. Voice never exposes arbitrary MCP or web tools. */
export const VOICE_DURATION_SECONDS = 600;
export const VOICE_MAX_TOOL_CALLS = 60;
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The app path for a page, or null when the page is unknown or a record page lacks a valid id. */
export function voicePagePath(page: unknown, id?: unknown): string | null {
  if (typeof page !== "string" || !Object.hasOwn(VOICE_PAGES, page)) return null;
  const path: string = VOICE_PAGES[page as VoicePage];
  if (!path.includes(":id")) return path;
  return typeof id === "string" && UUID.test(id) ? path.replace(":id", id) : null;
}
