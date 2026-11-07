import type { ComponentType } from "react";
import {
  CalendarDays,
  Camera,
  FileText,
  Mail,
  Mic,
  Monitor,
  NotebookPen,
  ScanLine,
  Smartphone,
  type LucideIcon,
} from "lucide-react";
import { GranolaMark } from "@/components/settings/provider-marks";
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

/** The history row's icon and footer label for how a capture arrived. */
export const CAPTURE_METHOD_META: Record<
  CaptureMethod,
  { icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>; label: string }
> = {
  notes: { icon: NotebookPen, label: "Typed notes" },
  meeting: { icon: Monitor, label: "Meeting recorded" },
  voice: { icon: Mic, label: "Voice note" },
  scan: { icon: ScanLine, label: "Scanned notes" },
  granola: { icon: GranolaMark, label: "From Granola" },
  file: { icon: FileText, label: "File" },
  calendar: { icon: CalendarDays, label: "Calendar invite" },
  email: { icon: Mail, label: "Email" },
  phone: { icon: Smartphone, label: "From your phone" },
};

/** Where a capture photo is served from. Owner-only — see the route. */
export function capturePhotoSrc(id: string, opts: { download?: boolean } = {}) {
  return `/api/capture/photos/${id}${opts.download ? "?download=1" : ""}`;
}
