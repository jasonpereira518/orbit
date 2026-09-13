import {
  CalendarDays,
  Camera,
  FileText,
  Mail,
  Mic,
  NotebookPen,
  type LucideIcon,
} from "lucide-react";
import type { CaptureSourceKind } from "@/lib/note-batches";

/** How each way into Capture is labelled wherever a capture is listed or shown. */
export const CAPTURE_SOURCE_META: Record<CaptureSourceKind, { icon: LucideIcon; label: string }> = {
  voice: { icon: Mic, label: "Voice note" },
  photo: { icon: Camera, label: "Photo" },
  calendar: { icon: CalendarDays, label: "Calendar invite" },
  email: { icon: Mail, label: "Email" },
  file: { icon: FileText, label: "File" },
  text: { icon: NotebookPen, label: "Typed notes" },
};

/** Where a capture photo is served from. Owner-only — see the route. */
export function capturePhotoSrc(id: string, opts: { download?: boolean } = {}) {
  return `/api/capture/photos/${id}${opts.download ? "?download=1" : ""}`;
}
