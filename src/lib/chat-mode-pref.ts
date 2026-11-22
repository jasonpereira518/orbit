import { parseWebChoice, type WebChoice } from "@/lib/chat-web-decision";

/**
 * The composer's two switches, remembered per browser like the history rail (`chat-rail-pref`):
 * Deep (a thorough answer that may take minutes) and web search.
 *
 * Deep defaults to a quick answer. Web search is NOT a browser-wide switch: it is a choice per
 * chat (auto / on / off, `@/lib/chat-web-decision`), and a chat with no stored choice is auto.
 * The old browser-wide key (`orbit:chat-web`) is ignored.
 */
const DEEP_KEY = "orbit:chat-deep";
const WEB_BY_CHAT_KEY = "orbit:chat-web-by-chat";
/** Enough for a long history; the oldest choices fall off first. */
const WEB_BY_CHAT_MAX = 200;

function read(key: string, fallback: boolean): boolean {
  if (typeof window === "undefined") return fallback;
  try {
    const stored = window.localStorage.getItem(key);
    return stored === null ? fallback : stored === "1";
  } catch {
    return fallback;
  }
}

function write(key: string, on: boolean) {
  try {
    window.localStorage.setItem(key, on ? "1" : "0");
  } catch {
    // Private mode or blocked storage: the switch still works, it just is not remembered.
  }
}

export const readChatDeep = () => read(DEEP_KEY, false);
export const writeChatDeep = (on: boolean) => write(DEEP_KEY, on);

function readWebMap(): Record<string, WebChoice> {
  if (typeof window === "undefined") return {};
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(WEB_BY_CHAT_KEY) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, WebChoice>) : {};
  } catch {
    return {};
  }
}

/** This chat's web choice: what the person set, else auto. */
export function readChatWebChoice(threadId: string | null): WebChoice {
  return threadId ? parseWebChoice(readWebMap()[threadId]) : "auto";
}

/** Remember a chat's choice. Auto is the absence of one, so it removes the entry. */
export function writeChatWebChoice(threadId: string | null, choice: WebChoice) {
  if (!threadId) return;
  try {
    const map = readWebMap();
    delete map[threadId];
    if (choice !== "auto") map[threadId] = choice;
    const keep = Object.entries(map).slice(-WEB_BY_CHAT_MAX);
    window.localStorage.setItem(WEB_BY_CHAT_KEY, JSON.stringify(Object.fromEntries(keep)));
  } catch {
    // Private mode or blocked storage: the choice still works, it just is not remembered.
  }
}
