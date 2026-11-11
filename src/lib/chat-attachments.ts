/**
 * Files attached to a chat question.
 *
 * What travels is the TEXT read from each file, never the bytes: the browser reads a text
 * file itself, and a photo or PDF goes through capture's reader first. So the answer model
 * sees words, on every provider.
 *
 * ponytail: text only, so a chart, a layout or a face in a picture is invisible to the
 * model. The upgrade is image parts in `createToolDriver`.
 *
 * Pure (no database, no browser), so the route, the prompt and the composer share it.
 */
export type ChatAttachment = {
  /** The file's name as the person saw it. */
  name: string;
  kind: "image" | "pdf" | "text";
  /** What was read from it. */
  text: string;
};

export const CHAT_ATTACHMENTS_MAX = 3;
/** Per file. About three dense pages; a longer file is cut and says so. */
export const CHAT_ATTACHMENT_CHARS = 12_000;
/** Across every file one question's prompt carries, this question's and earlier ones'. */
const PROMPT_CHARS = 24_000;
const NAME_CHARS = 120;
const KINDS: ReadonlySet<string> = new Set(["image", "pdf", "text"]);

/** One attachment, cut to the limits. Shared by the composer (before sending) and the route. */
export function clampAttachment(input: ChatAttachment): ChatAttachment {
  const text = input.text.trim();
  return {
    name: input.name.replace(/[\r\n]+/g, " ").trim().slice(0, NAME_CHARS) || "file",
    kind: input.kind,
    text: text.length > CHAT_ATTACHMENT_CHARS ? `${text.slice(0, CHAT_ATTACHMENT_CHARS)}\n… (cut: the file is longer)` : text,
  };
}

/** Whatever the client sent, as attachments this server will accept. Never throws. */
export function sanitizeAttachments(raw: unknown): ChatAttachment[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatAttachment[] = [];
  for (const item of raw) {
    if (out.length >= CHAT_ATTACHMENTS_MAX) break;
    if (!item || typeof item !== "object") continue;
    const { name, kind, text } = item as Record<string, unknown>;
    if (typeof name !== "string" || typeof text !== "string" || typeof kind !== "string" || !KINDS.has(kind)) continue;
    if (!text.trim()) continue;
    out.push(clampAttachment({ name, kind: kind as ChatAttachment["kind"], text }));
  }
  return out;
}

/**
 * The files block for the prompt: this question's files first, then files from earlier in
 * the conversation, newest first, until the budget is spent. Null when there are none.
 *
 * Earlier files ride along so "what else does it say?" works on the next turn. They come
 * back through here, inside the prompt's untrusted-data fence, rather than as part of the
 * unfenced conversation history.
 */
export function attachmentsForPrompt(
  current: readonly ChatAttachment[],
  earlier: readonly ChatAttachment[] = []
): string | null {
  const parts: string[] = [];
  let used = 0;
  const seen = new Set<string>();
  const add = (file: ChatAttachment, when: string) => {
    const key = `${file.name}\n${file.text}`;
    if (seen.has(key)) return;
    const room = PROMPT_CHARS - used;
    if (room < 200) return;
    seen.add(key);
    const text = file.text.length > room ? `${file.text.slice(0, room)}\n… (cut for length)` : file.text;
    used += text.length;
    parts.push(`File: ${file.name} (${when})\n${text}`);
  };
  for (const file of current) add(file, "attached to this question");
  for (const file of earlier) add(file, "attached earlier in this conversation");
  return parts.length ? parts.join("\n\n---\n\n") : null;
}
