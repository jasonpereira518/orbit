/**
 * Reads the files a person picked for a chat import, in the browser. A `.txt` is read
 * whole; a `.zip` (WhatsApp's "Export chat" share) yields its one chat `.txt` — media
 * members are never decompressed (`async` is called on the chosen `.txt` only). Pure and
 * browser-safe: no @/db, node:*, or next/* imports.
 */
import { IMESSAGE_HEADER_RE } from "@/lib/conversations/imessage";
import type { ChatSource } from "@/lib/conversations/types";
import { WHATSAPP_LINE_RE } from "@/lib/conversations/whatsapp";
import { MAX_CONTACTS_FILE_BYTES } from "@/lib/imports/import-constants";

export type ChatFile = { fileName: string; text: string; source: ChatSource };

/** Lines looked at for a WhatsApp timestamp: the first can be the encryption banner. */
const WHATSAPP_HEAD_LINES = 5;

function nonEmptyLines(head: string, limit: number): string[] {
  const out: string[] = [];
  for (const line of head.replace(/\r\n?/g, "\n").split("\n")) {
    if (!line.trim()) continue;
    out.push(line);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Rule: WhatsApp when one of the first 5 non-empty lines is a timestamped message line
 * ("Name: text" after the stamp); iMessage when the first non-empty line is an
 * imessage-exporter header; anything else is not a chat.
 */
export function detectChatSource(_fileName: string, head: string): ChatSource | null {
  const lines = nonEmptyLines(head, WHATSAPP_HEAD_LINES);
  if (lines.some((line) => (line.match(WHATSAPP_LINE_RE)?.[8] ?? "").includes(": "))) return "whatsapp";
  if (lines[0] && IMESSAGE_HEADER_RE.test(lines[0].trim())) return "imessage";
  return null;
}

/** The chat member of a zip: `_chat.txt` first, else the first other `.txt`. macOS `__MACOSX/` twins never count. */
export function pickChatMember<T extends { name: string; dir: boolean }>(members: T[]): T | null {
  const txt = members.filter((m) => !m.dir && /\.txt$/i.test(m.name) && !/(^|\/)__MACOSX\//.test(m.name));
  return txt.find((m) => /(^|\/)_chat\.txt$/i.test(m.name)) ?? txt[0] ?? null;
}

async function readText(file: File): Promise<string | null> {
  if (/\.txt$/i.test(file.name)) return file.text();
  if (!/\.zip$/i.test(file.name)) return null;
  const { default: JSZip } = await import("jszip");
  let zip: InstanceType<typeof JSZip>;
  try {
    zip = await JSZip.loadAsync(await file.arrayBuffer());
  } catch {
    return null;
  }
  const member = pickChatMember(Object.values(zip.files));
  // Rule: only the chosen .txt member is ever decompressed.
  return member ? member.async("string") : null;
}

export async function readChatFiles(files: File[]): Promise<{ files: ChatFile[]; ignored: string[] }> {
  const out: ChatFile[] = [];
  const ignored: string[] = [];
  for (const file of files) {
    if (file.size > MAX_CONTACTS_FILE_BYTES) {
      ignored.push(file.name);
      continue;
    }
    const text = await readText(file);
    // A zip's chat member can be far larger than the zip; the same cap applies to it.
    const source = text != null && text.length <= MAX_CONTACTS_FILE_BYTES ? detectChatSource(file.name, text.slice(0, 4096)) : null;
    if (text == null || !source) {
      ignored.push(file.name);
      continue;
    }
    // Rule: a zip keeps its own name — WhatsApp puts the chat title there, not in `_chat.txt`.
    out.push({ fileName: file.name, text, source });
  }
  return { files: out, ignored };
}
