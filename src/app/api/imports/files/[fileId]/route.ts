import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { withMediaResourcePolicy } from "@/lib/media-headers";
import { getDb } from "@/db";
import { importFiles } from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import { gunzipExportFile } from "@/lib/linkedin-export-store";

type Params = { params: Promise<{ fileId: string }> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Download one kept LinkedIn export file, to the person who uploaded it. Someone else's file
 * 404s rather than 403s, so the response never confirms a guessed id exists (as
 * `/api/capture/photos/[photoId]` does).
 */
async function serve(_req: Request, { params }: Params) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch {
    return new NextResponse(null, { status: 401 });
  }

  const { fileId } = await params;
  if (!UUID.test(fileId)) return new NextResponse(null, { status: 404 });

  const db = await getDb();
  const file = await db.query.importFiles.findFirst({
    where: eq(importFiles.id, fileId),
    columns: { userId: true, path: true, gz: true },
  });
  if (!file || file.userId !== userId) return new NextResponse(null, { status: 404 });

  let text: string;
  try {
    text = gunzipExportFile(file.gz);
  } catch {
    return new NextResponse(null, { status: 404 });
  }
  const name = (file.path.split("/").pop() ?? "linkedin.csv").replace(/[^\w.\- ]+/g, "_").slice(0, 120);
  return new NextResponse(text, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/** Every response, redirects and misses included, is same-origin only (audit L-09). */
export async function GET(_req: Request, ctx: Params) {
  return withMediaResourcePolicy(await serve(_req, ctx));
}
