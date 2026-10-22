import { z } from "zod";
import type { CaptureMediaFile } from "@/lib/capture-ingest";

/**
 * A photo as the phone's scan page posts it (`/api/scan/[token]/pages`). The route is reachable
 * with a QR-code token and no session, so the body is whatever a phone, or anything holding the
 * token, sent. Before this, `base64: 5` threw a TypeError at `file.base64.length` and answered 500.
 */
export const captureMediaFileSchema = z.object({
  filename: z.string(),
  mimeType: z.string(),
  base64: z.string(),
}) satisfies z.ZodType<CaptureMediaFile>;

export const captureMediaFilesSchema = z.array(captureMediaFileSchema);
