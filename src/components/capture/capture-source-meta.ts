import {
  CalendarDays,
  Camera,
  FileText,
  Mail,
  Mic,
  NotebookPen,
  type LucideIcon,
} from "lucide-react";
import type { NoteSource } from "@/components/capture/note-source-mark";
import type { CaptureMethod, CaptureSourceKind } from "@/lib/note-batches";

/** How each way into Capture is labelled wherever a capture is listed or shown. */
export const CAPTURE_SOURCE_META: Record<CaptureSourceKind, { icon: LucideIcon; label: string }> = {
  voice: { icon: Mic, label: "Voice note" },
  photo: { icon: Camera, label: "Photo" },
  calendar: { icon: CalendarDays, label: "Calendar invite" },
  email: { icon: Mail, label: "Email" },
  file: { icon: FileText, label: "File" },
  text: { icon: NotebookPen, label: "Typed notes" },
};

/**
 * The history row's footer label for how a capture arrived, and the notes source its left
 * tile shows: typed, scanned, filed and phone captures were all taken in Orbit.
 */
export const CAPTURE_METHOD_META: Record<CaptureMethod, { label: string; source: NoteSource }> = {
  notes: { label: "Typed notes", source: "orbit" },
  meeting: { label: "Meeting recorded", source: "audio" },
  voice: { label: "Voice note", source: "audio" },
  scan: { label: "Scanned notes", source: "orbit" },
  granola: { label: "From Granola", source: "granola" },
  drive: { label: "From Google Drive", source: "drive" },
  onedrive: { label: "From OneDrive", source: "onedrive" },
  file: { label: "File", source: "orbit" },
  calendar: { label: "Calendar invite", source: "orbit" },
  email: { label: "Email", source: "orbit" },
  phone: { label: "From your phone", source: "orbit" },
};

/** Where a capture photo is served from. Owner-only — see the route. */
export function capturePhotoSrc(id: string, opts: { download?: boolean } = {}) {
  return `/api/capture/photos/${id}${opts.download ? "?download=1" : ""}`;
}
