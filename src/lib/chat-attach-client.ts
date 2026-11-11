import { discardCaptureJob } from "@/actions/capture-jobs";
import { uploadCaptureMedia } from "@/lib/capture/ingest-client";
import { prepareUploadFiles } from "@/lib/capture/prepare-upload";
import { clampAttachment, type ChatAttachment } from "@/lib/chat-attachments";
import { MISSING_AI_API_KEY_MESSAGE, friendlyError, isMissingAiApiKeyError } from "@/lib/errors";

/** What the composer's file picker offers. Audio is left to dictation and Capture. */
export const CHAT_ATTACH_ACCEPT = "image/*,application/pdf,text/plain,text/markdown,.txt,.md,.pdf";

export type ReadAttachment = { ok: true; attachment: ChatAttachment } | { ok: false; error: string; aborted?: boolean };

function kindOf(file: File): ChatAttachment["kind"] | null {
  const name = file.name.toLowerCase();
  if (file.type.startsWith("image/")) return "image";
  if (file.type === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  if (file.type.startsWith("text/") || name.endsWith(".txt") || name.endsWith(".md")) return "text";
  return null;
}

/**
 * Turn a file into the text a chat question can carry (browser only).
 *
 * A text file is read here. A photo or a PDF goes through Capture's own reader: the same
 * prepare step (a PDF becomes page images) and the same upload, which reads the pages with
 * the vision model and so uses AI credits. That upload leaves a capture job behind, meant
 * for the Capture page; this is not a capture, so the job is discarded as soon as its text
 * is in hand and it never shows up there.
 */
export async function readAttachment(file: File, signal?: AbortSignal): Promise<ReadAttachment> {
  const kind = kindOf(file);
  if (!kind) return { ok: false, error: `${file.name} isn’t a photo, PDF or text file` };
  try {
    if (kind === "text") {
      const text = await file.text();
      if (!text.trim()) return { ok: false, error: `${file.name} is empty` };
      return { ok: true, attachment: clampAttachment({ name: file.name, kind, text }) };
    }
    const prepared = await prepareUploadFiles([file]);
    if (!prepared.files.length) {
      return { ok: false, error: prepared.failures[0]?.message ?? `Couldn’t open ${file.name}` };
    }
    const res = await uploadCaptureMedia({ sourceKind: "messy", files: prepared.files, signal });
    if (!res.ok) {
      if (res.aborted) return { ok: false, error: "", aborted: true };
      return { ok: false, error: isMissingAiApiKeyError(res.error) ? MISSING_AI_API_KEY_MESSAGE : res.error };
    }
    void discardCaptureJob(res.job.id).catch(() => {});
    if (!res.text.trim()) return { ok: false, error: `Couldn’t find any text in ${file.name}` };
    return { ok: true, attachment: clampAttachment({ name: file.name, kind, text: res.text }) };
  } catch (err) {
    if (signal?.aborted) return { ok: false, error: "", aborted: true };
    return { ok: false, error: friendlyError(err, `Couldn’t read ${file.name} — try again?`) };
  }
}
