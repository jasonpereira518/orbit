/**
 * A glanceable preview of a staged file, so the sorting dialog shows what a thing IS rather
 * than what it is called.
 *
 * Deliberately images and text only. A PDF preview means rasterising in the browser, and a
 * folder of forty scanned PDFs would lock the tab up for as long as that takes — for a
 * thumbnail nobody is going to read anyway. PDFs get a labelled tile; the page count and the
 * content arrive at the real parse.
 *
 * ## The two costs this is shaped around
 *
 * DECODING. Forty full-size phone photos decoded at once is hundreds of megabytes of bitmaps
 * and a stalled main thread, so previews are built through a small concurrency gate and each
 * is drawn down to a thumbnail immediately. The bitmap is closed before the next one opens.
 *
 * LEAKAGE. Every image preview is an object URL, and an object URL not revoked holds its
 * blob for the life of the document. `revokePreview` exists so the dialog can let go of forty
 * of them when it closes, and it is called from a cleanup rather than an event handler —
 * closing is not the only way a dialog goes away.
 */
import { fitWithin } from "@/lib/capture-image-shrink";

/** Long edge of a preview thumbnail. Twice the rendered size, for a crisp tile on a 2x screen. */
export const PREVIEW_MAX_EDGE = 192;
/** How much of a text file to read for the snippet. Enough for a heading and a first line. */
const TEXT_SNIFF_BYTES = 4096;
const SNIPPET_CHARS = 180;
/** Decodes in flight. Low on purpose: this is competing with the person's scrolling. */
const PREVIEW_CONCURRENCY = 3;

export type FilePreview =
  | { kind: "image"; url: string }
  | { kind: "text"; snippet: string }
  | { kind: "label"; label: string };

const TEXT_EXTENSIONS = /\.(txt|md|markdown|csv|log|json|rtf)$/i;

function extensionLabel(name: string): string {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toUpperCase() : "";
  return ext.length > 0 && ext.length <= 5 ? ext : "FILE";
}

/** Whether a file's bytes are worth reading as text at all. */
export function looksTextual(file: { name: string; type: string }): boolean {
  if (file.type.startsWith("text/")) return true;
  if (file.type === "message/rfc822" || file.type === "application/json") return true;
  return TEXT_EXTENSIONS.test(file.name) || /\.(eml|ics)$/i.test(file.name);
}

/**
 * The most useful line in a calendar invite or an email, rather than its envelope.
 *
 * Without this an `.ics` previews as "BEGIN:VCALENDAR" and an `.eml` as "Delivered-To:",
 * which is the same non-answer for every file of that kind — worse than no preview, because
 * it looks like the preview worked.
 */
export function snippetFromText(name: string, raw: string): string {
  const text = raw.replace(/\r\n/g, "\n");
  if (/\.ics$/i.test(name)) {
    const summary = /^SUMMARY:(.+)$/im.exec(text)?.[1]?.trim();
    if (summary) return summary.slice(0, SNIPPET_CHARS);
  }
  if (/\.eml$/i.test(name) || /^(delivered-to|received|from):/im.test(text)) {
    const subject = /^Subject:(.+)$/im.exec(text)?.[1]?.trim();
    if (subject) return subject.slice(0, SNIPPET_CHARS);
  }
  // Markdown headings make a good title; blank lines and rules make a bad one.
  const firstLine = text
    .split("\n")
    .map((l) => l.replace(/^#+\s*/, "").trim())
    .find((l) => l.length > 0 && !/^[-=*_]{3,}$/.test(l));
  return (firstLine ?? "").slice(0, SNIPPET_CHARS);
}

async function imagePreview(file: File): Promise<FilePreview | null> {
  if (typeof createImageBitmap !== "function") return null;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    // HEIC outside Safari, or a corrupt file. The tile falls back to its label; the upload
    // is unaffected, because the server decides what it can read.
    return null;
  }
  try {
    const target = fitWithin(bitmap.width, bitmap.height, PREVIEW_MAX_EDGE);
    const canvas = document.createElement("canvas");
    canvas.width = target.width;
    canvas.height = target.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, target.width, target.height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.6)
    );
    return blob ? { kind: "image", url: URL.createObjectURL(blob) } : null;
  } catch {
    return null;
  } finally {
    bitmap.close();
  }
}

/** One file's preview. Never throws: a tile with a label is a fine outcome. */
export async function buildPreview(file: File): Promise<FilePreview> {
  const fallback: FilePreview = { kind: "label", label: extensionLabel(file.name) };
  try {
    if (file.type.startsWith("image/")) {
      return (await imagePreview(file)) ?? fallback;
    }
    if (looksTextual(file)) {
      const head = await file.slice(0, TEXT_SNIFF_BYTES).text();
      const snippet = snippetFromText(file.name, head);
      return snippet ? { kind: "text", snippet } : fallback;
    }
    return fallback;
  } catch {
    return fallback;
  }
}

/**
 * Build previews for a whole drop, reporting each one as it lands.
 *
 * Streamed through `onReady` rather than resolved as a batch so the dialog fills in as it
 * goes: forty files is several seconds of decoding, and a dialog that shows nothing until
 * all of it is done reads as broken.
 *
 * `signal` is checked between files, so closing the dialog stops the work rather than
 * finishing it into a component nobody is looking at.
 */
export async function buildPreviews(
  files: readonly { id: string; file: File }[],
  onReady: (id: string, preview: FilePreview) => void,
  signal?: { aborted: boolean }
): Promise<void> {
  let cursor = 0;
  async function worker() {
    for (;;) {
      if (signal?.aborted) return;
      const next = cursor++;
      if (next >= files.length) return;
      const entry = files[next]!;
      const preview = await buildPreview(entry.file);
      if (signal?.aborted) {
        revokePreview(preview);
        return;
      }
      onReady(entry.id, preview);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(PREVIEW_CONCURRENCY, files.length) }, () => worker())
  );
}

/** Let go of an image preview's blob. Safe to call on any preview, or on none. */
export function revokePreview(preview: FilePreview | null | undefined): void {
  if (preview?.kind === "image") URL.revokeObjectURL(preview.url);
}
