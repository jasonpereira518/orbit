import { after } from "next/server";
import { learnFromEdits } from "@/lib/draft-edits";
import { maybeBuildStyleProfile } from "@/lib/writing-style-profile";

/**
 * Learn how the user writes from their sent mail, once, after the draft they asked for is on
 * its way (`@/lib/writing-style-profile`).
 *
 * `after()` THROWS outside a request scope, and the draft actions are also called from scripts
 * and smokes. Outside a request the build is simply skipped: it exists for the person clicking
 * Draft, and their next draft in the app builds it. Kept out of `writing-style-profile.ts`
 * because tsx scripts import that module, and `next/server` does not belong in their graph.
 */
export function deferStyleProfileBuild(userId: string): void {
  try {
    after(() => maybeBuildStyleProfile(userId));
  } catch {
    // No request: a script or a job. Nothing to learn for.
  }
}

/**
 * Re-learn the changes the user keeps making (`@/lib/draft-edits`) after the response, once
 * enough edited drafts have piled up. Same `after()` guard as above: outside a request it runs
 * nothing, and the next recorded edit starts it again.
 */
export function deferEditLearning(userId: string): void {
  try {
    after(() => learnFromEdits(userId).catch(() => null));
  } catch {
    // No request: a script or a job.
  }
}
