/**
 * The composer's two switches, remembered per browser like the history rail (`chat-rail-pref`):
 * Deep (a thorough answer that may take minutes) and web search.
 *
 * Defaults are what chat did before the switches existed: a quick answer, web lookups allowed.
 */
const DEEP_KEY = "orbit:chat-deep";
const WEB_KEY = "orbit:chat-web";

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
export const readChatWeb = () => read(WEB_KEY, true);
export const writeChatWeb = (on: boolean) => write(WEB_KEY, on);
