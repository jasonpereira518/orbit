import { NextResponse } from "next/server";
import { requireUserId } from "@/lib/auth";
import { readImportJobStatus } from "@/lib/imports/import-job-status";

type Params = { params: Promise<{ id: string }> };

/**
 * The import progress poll. A plain GET rather than the `getImportJobStatus` action, so it
 * runs beside the person's own Server Actions instead of in their queue. Someone else's
 * import 404s, as a missing one does.
 */
export async function GET(_req: Request, { params }: Params) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch {
    return new NextResponse(null, { status: 401 });
  }

  const { id } = await params;
  const status = await readImportJobStatus(userId, id);
  if (!status) return new NextResponse(null, { status: 404 });
  return NextResponse.json(status, { headers: { "Cache-Control": "no-store" } });
}
