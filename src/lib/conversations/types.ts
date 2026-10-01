/**
 * A chat export, normalized. Pure data — this module and everything under
 * src/lib/conversations/ runs in the browser: no @/db, node:*, or next/* imports.
 */
export type ChatSource = "whatsapp" | "imessage";

export type ChatParticipant = {
  /** Stable within one conversation: the sender label exactly as the export spells it. */
  key: string;
  displayName: string;
  phoneE164: string | null;
  email: string | null;
  isSelf: boolean;
};

export type ChatMessage = {
  senderKey: string;
  /** ISO 8601. Export times carry no zone; they are read as the browser's local time. */
  at: string;
  text: string;
};

export type Conversation = {
  source: ChatSource;
  fileName: string;
  /** iMessage: from the file name. WhatsApp: from "WhatsApp Chat with X.txt", else the other sender. */
  title: string;
  isGroup: boolean;
  participants: ChatParticipant[];
  /** Oldest first. */
  messages: ChatMessage[];
  /** True when day/month order could not be proven from the file and the locale decided. */
  dateOrderGuessed: boolean;
  /** Lines that looked like messages but could not be read. */
  skippedLines: number;
};

export type ChatSession = {
  startAt: string;
  endAt: string;
  messageCount: number;
  /** Direction of the LAST message: "out" from the owner, "in" otherwise, null if the owner is unknown. */
  direction: "in" | "out" | null;
  transcript: string;
};

export const SESSION_GAP_MS = 6 * 60 * 60 * 1000;
export const SESSION_MAX_MESSAGES = 200;
export const SESSION_MAX_CHARS = 12_000;
/** Rows per appendChatRows call; client batching and the server cap share it. */
export const MAX_APPEND_ROWS = 200;
