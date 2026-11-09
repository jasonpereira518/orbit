/**
 * Where each file of a drop on /capture goes.
 *
 * Capture takes any drop, so a folder can hold a LinkedIn export, a year of meeting PDFs and
 * a voice memo at once. Import detection is asked first because it is the stricter reader:
 * a `Connections.csv` full of messages is a messages import, not a note, and an `.ics` is a
 * calendar import even though the notes picker also lists it. Only what detection calls
 * "not something Orbit reads" is offered to the notes and audio pickers' own accept lists.
 * Members of a LinkedIn export it set aside stay with the export — they are not stray files.
 *
 * Pure apart from reading the files' heads (detection's own job). No React, no network.
 */
import { AUDIO_FILE_ACCEPT, CAPTURE_FILE_ACCEPT } from "@/lib/capture/ingest-client";
import type { DroppedFile } from "@/lib/capture/file-drop";
import {
  LINKEDIN_LEFT_OUT,
  LINKEDIN_PRIVATE,
  NOT_READ,
  detectImportFiles,
  type DetectOptions,
  type DetectionResult,
} from "@/lib/imports/detect-import-file";
import { extractLinkedInProfileRefs } from "@/lib/linkedin-paste";

export type RoutedDrop = {
  /** For `stageDrop`; its `ignored` no longer lists what went to notes or audio. */
  imports: DetectionResult;
  chats: File[];
  audio: File[];
  /** Kept with their folder paths: the notes sorter groups by them. */
  notes: DroppedFile[];
  linkedinUrls: string[];
  /** Nothing takes these. Shown with their reason. */
  ignored: { name: string; reason: string }[];
};

/** `<input accept>` semantics: `.ext`, `type/*` or an exact MIME type. */
export function matchesAccept(accept: string, file: Pick<File, "name" | "type">): boolean {
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();
  return accept.split(",").some((raw) => {
    const rule = raw.trim().toLowerCase();
    if (!rule) return false;
    if (rule.startsWith(".")) return name.endsWith(rule);
    if (rule.endsWith("/*")) return type.startsWith(rule.slice(0, -1));
    return type === rule;
  });
}

export async function routeDrop(
  files: readonly DroppedFile[],
  options: DetectOptions & { text?: string } = {},
): Promise<RoutedDrop> {
  const { text = "", ...detect } = options;
  const imports = await detectImportFiles(files, detect);

  const audio: File[] = [];
  const notes: DroppedFile[] = [];
  const stillIgnored = imports.ignored.filter((d) => {
    if (d.reason !== NOT_READ) return true;
    if (matchesAccept(AUDIO_FILE_ACCEPT, d.file)) audio.push(d.file);
    else if (matchesAccept(CAPTURE_FILE_ACCEPT, d.file)) notes.push({ file: d.file, path: d.path });
    else return true;
    return false;
  });

  return {
    imports: { ...imports, ignored: stillIgnored },
    chats: imports.chatFiles,
    audio,
    notes,
    linkedinUrls: extractLinkedInProfileRefs(text).map((r) => r.url),
    ignored: [
      // Export members set aside are part of the export, not a skipped file.
      ...stillIgnored.filter((d) => d.reason !== LINKEDIN_LEFT_OUT && d.reason !== LINKEDIN_PRIVATE),
      ...imports.skipped,
    ].map((d) => ({ name: d.displayName, reason: d.reason })),
  };
}

export function hasImports(routed: RoutedDrop): boolean {
  return routed.imports.staged.length > 0 || routed.imports.exportFiles.length > 0;
}

function count(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/** Each destination's share of the drop, in words — "12 notes", "1 LinkedIn export". */
export function routeParts(routed: RoutedDrop): string[] {
  const parts: string[] = [];
  if (routed.notes.length) parts.push(count(routed.notes.length, "note"));
  if (routed.audio.length) parts.push(count(routed.audio.length, "recording"));
  const staged = routed.imports.staged.map((d) => d.target);
  const linkedIn = staged.filter((t) => t.startsWith("linkedin_")).length;
  if (routed.imports.exportFiles.length) parts.push("1 LinkedIn export");
  else if (linkedIn) parts.push(count(linkedIn, "LinkedIn file"));
  const calendars = staged.filter((t) => t.startsWith("calendar_")).length;
  if (calendars) parts.push(count(calendars, "calendar file"));
  const contacts = staged.filter((t) => t === "contacts_file").length;
  if (contacts) parts.push(count(contacts, "contacts file"));
  if (routed.chats.length) parts.push(count(routed.chats.length, "chat"));
  if (routed.linkedinUrls.length) parts.push(count(routed.linkedinUrls.length, "LinkedIn profile"));
  return parts;
}

/** "12 notes, 1 LinkedIn export, 3 skipped". */
export function summarizeRoute(routed: RoutedDrop): string {
  const parts = routeParts(routed);
  if (routed.ignored.length) parts.push(`${routed.ignored.length} skipped`);
  return parts.join(", ");
}

/** More than one place to send things: say how it splits before anything runs. */
export function isMixedDrop(routed: RoutedDrop): boolean {
  const destinations = [
    routed.notes.length,
    routed.audio.length,
    hasImports(routed),
    routed.chats.length,
    routed.linkedinUrls.length,
  ].filter(Boolean).length;
  return destinations > 1;
}
