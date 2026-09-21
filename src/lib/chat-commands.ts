/**
 * The chat composer's slash commands — pure, so `scripts/smoke-chat-commands.ts` can pin the
 * trigger rules and the ranking without a browser. The menu is the composer's own type-ahead
 * (`mention-composer.tsx`), the same one `@` opens.
 *
 * v1 commands only PREFILL the box or NAVIGATE. None of them writes anything: a command that
 * changed data from a keystroke would be a second, unconfirmed path around the confirm cards
 * that chat-proposed actions go through. `/remind` and `/log` therefore open the page that
 * does it, and the prefills leave the person to read the sentence and press send.
 *
 * Ranking and hidden-surface filtering are the command palette's own (`rankEntries`,
 * `visibleEntries`), so `/` cannot become a side door into a page an operator has hidden.
 */
import { rankEntries, visibleEntries, type PaletteEntry } from "@/lib/command-palette";

export type ChatCommand = PaletteEntry & {
  /** What is typed after the slash. Also matched as a keyword, so `/followup` finds "Follow up". */
  slug: string;
  /** One line under the label in the menu. */
  hint: string;
  /**
   * Text that replaces the typed token. `mention` means it ends in an `@` and the people menu
   * should open straight away, so the command reads as "pick who".
   */
  prefill?: { text: string; mention: boolean };
};

export const CHAT_COMMANDS: readonly ChatCommand[] = [
  {
    id: "cmd:draft",
    slug: "draft",
    label: "Draft a message",
    hint: "Write to someone — pick them next",
    keywords: "draft write message email reach out text",
    prefill: { text: "Draft a message to @", mention: true },
  },
  {
    id: "cmd:followup",
    slug: "followup",
    label: "Follow up",
    hint: "Suggest a follow-up for someone",
    keywords: "followup follow up check in nudge",
    prefill: { text: "Suggest a follow-up for @", mention: true },
  },
  {
    id: "cmd:summarize",
    slug: "summarize",
    label: "Summarize a person",
    hint: "What you know about them, in a few lines",
    keywords: "summarize summary recap catch up brief about",
    prefill: { text: "Summarize what I know about @", mention: true },
  },
  {
    id: "cmd:intro",
    slug: "intro",
    label: "Suggest an intro",
    hint: "Who they should meet",
    keywords: "intro introduce introduction connect meet",
    prefill: { text: "Who should I introduce @ to?", mention: false },
  },
  {
    id: "cmd:remind",
    slug: "remind",
    label: "New reminder",
    hint: "Opens Reminders",
    href: "/reminders?new=1",
    keywords: "remind reminder task todo due",
  },
  {
    id: "cmd:log",
    slug: "log",
    label: "Log a note",
    hint: "Opens Capture",
    href: "/capture",
    keywords: "log note capture record interaction meeting",
  },
];

/** The longest command word worth treating as a command; past it the slash is just a slash. */
const SLASH_QUERY_MAX_LEN = 20;

export type SlashQuery = {
  /** Index of the `/`. */
  start: number;
  /** What has been typed after it, which may be empty. */
  query: string;
};

/**
 * The slash-token the caret is sitting inside, or null.
 *
 * A command only exists at the start of the message or of a line, and only until the first
 * space: `/draft` is a command, `and/or`, `https://x.com/a` and `1/2` are not, and neither is
 * `/etc/hosts` once the second slash lands. Letters and hyphens only, so a path or a date can
 * never open the menu.
 */
export function slashQueryAt(text: string, caret: number): SlashQuery | null {
  if (caret < 1 || caret > text.length) return null;
  for (let i = caret - 1; i >= 0 && caret - i <= SLASH_QUERY_MAX_LEN + 1; i--) {
    const ch = text[i]!;
    if (ch === "/") {
      if (i !== 0 && text[i - 1] !== "\n") return null;
      return { start: i, query: text.slice(i + 1, caret) };
    }
    if (!/[A-Za-z-]/.test(ch)) return null;
  }
  return null;
}

/** Commands for what has been typed, best first, minus anything the viewer's nav has hidden. */
export function commandsFor(query: string, hidden: ReadonlySet<string>): ChatCommand[] {
  return rankEntries(visibleEntries([...CHAT_COMMANDS], hidden), query);
}
