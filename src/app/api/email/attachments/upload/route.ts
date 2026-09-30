import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextResponse } from "next/server";
import { hasBlobStorage } from "@/lib/contact-avatar";
import { attachmentPrefixFor, isBlockedFilename } from "@/lib/email/attachment-paths";
import { MAX_ATTACHMENT_BYTES_GMAIL } from "@/lib/email/config";
import { requireUserForSurface } from "@/lib/plan-guards";
import { COMPOSE_SURFACE_KEY } from "@/lib/surfaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Issues a one-file upload token for an email attachment (direct-email P4). The browser uploads
 * straight to Blob, so the 4.5 MB function body limit never applies. A token is only good for a
 * path under the caller's own prefix, and enqueue re-checks the prefix and reads the real size
 * from Blob before anything is sent. No completion callback: the send, not the upload, is what
 * records an attachment — and Blob's callback would arrive without a session.
 */
export async function POST(request: Request) {
  if (!hasBlobStorage()) {
    return NextResponse.json({ error: "Attachments aren’t available" }, { status: 503 });
  }
  let userId: string;
  try {
    userId = await requireUserForSurface(COMPOSE_SURFACE_KEY);
  } catch {
    return new NextResponse(null, { status: 401 });
  }
  let body: HandleUploadBody;
  try {
    body = (await request.json()) as HandleUploadBody;
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  if (body.type !== "blob.generate-client-token") {
    return NextResponse.json({ error: "Unsupported" }, { status: 400 });
  }
  try {
    const json = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        if (!pathname.startsWith(attachmentPrefixFor(userId)) || pathname.includes("..")) {
          throw new Error("Invalid upload path");
        }
        if (isBlockedFilename(pathname)) throw new Error("That file type can’t be sent by email");
        return {
          addRandomSuffix: true,
          maximumSizeInBytes: MAX_ATTACHMENT_BYTES_GMAIL,
          tokenPayload: JSON.stringify({ userId }),
        };
      },
    });
    return NextResponse.json(json);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Upload refused" }, { status: 400 });
  }
}
