/**
 * The shape of a chat memory, with no database behind it: shared by the store, the prompt
 * and the browser. See `@/lib/chat-memory` for who may write one.
 */
export const MEMORIES_MAX = 50;
export const MEMORY_MAX_CHARS = 300;
/** What one prompt carries, newest first. */
const PROMPT_CHARS = 2_000;

/** One line, bounded. A memory is a sentence, not a document. */
export function cleanMemoryText(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, MEMORY_MAX_CHARS).trim();
}

/** The memories block for the prompt, newest first, inside its budget. Null when there are none. */
export function memoriesForPrompt(memories: readonly { text: string }[]): string | null {
  const lines: string[] = [];
  let used = 0;
  for (const memory of memories) {
    const line = `- ${cleanMemoryText(memory.text)}`;
    if (line.length <= 2) continue;
    if (used + line.length > PROMPT_CHARS) break;
    used += line.length + 1;
    lines.push(line);
  }
  return lines.length ? lines.join("\n") : null;
}
