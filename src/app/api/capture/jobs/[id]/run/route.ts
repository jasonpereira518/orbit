import { NextResponse } from "next/server";
import { after } from "next/server";
import { isInternalRequest } from "@/lib/internal-auth";
import { runCaptureJobById } from "@/lib/capture-job-runner";

// A two-pass parse over a long note, or a save that writes a contact per person.
export const maxDuration = 300;

type Params = { params: Promise<{ id: string }> };

/**
 * Internal kick for a capture job — the phone handoff's "done" and any caller that has
 * already spent its own invocation. Not user-facing: fail-closed shared secret, see
 * `internal-auth.ts`. The same shape as `/api/imports/[id]/continue`.
 */
export async function POST(request: Request, { params }: Params) {
  if (!isInternalRequest(request)) {
    return new NextResponse(null, { status: 401 });
  }
  const { id } = await params;
  after(() => runCaptureJobById(id).catch(() => {}));
  return NextResponse.json({ ok: true });
}
