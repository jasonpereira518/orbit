import { isInternalRequest } from "@/lib/internal-auth";
import { runOutreachJobs } from "@/lib/outreach-v2/runner";
export const maxDuration = 300;
export async function POST(request: Request) {
  if (!isInternalRequest(request))
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  return Response.json(await runOutreachJobs());
}
