import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { outreachJobs, outreachMessages } from "@/db/schema";
import {
  claimJob,
  enabled,
  finishJob,
  requireAccess,
  releaseResearch,
} from "./store";
import { discover, researchPerson } from "./discovery";
import { generateDraft } from "./service";
import { DailyLimitError, sendConnected } from "./mail";
import { recordSent, syncDue } from "./conversations";
import type { MessageKind } from "./types";

export async function runOutreachJobs(
  options: { userId?: string; campaignId?: string; budgetMs?: number } = {},
) {
  if (!enabled()) return { processed: 0 };
  const deadline = Date.now() + (options.budgetMs ?? 180000);
  let processed = 0;
  const db = await getDb();
  if (!options.campaignId)
    await syncDue(100, Math.min(deadline, Date.now() + 90000));
  while (Date.now() < deadline - 60000) {
    const job = await claimJob(
      ["search", "research", "draft", "send"],
      options.userId,
      options.campaignId,
    );
    if (!job) break;
    const token = job.leaseToken!;
    try {
      await requireAccess(job.userId);
      let result: Record<string, unknown> = {};
      if (job.kind === "search")
        result = await discover(
          job.userId,
          job.campaignId,
          job.payload.funding ?? "hosted",
          job.payload.limit ?? 50,
          job.id,
        );
      if (job.kind === "research")
        result = await researchPerson(
          job.userId,
          job.campaignId,
          job.key,
          job.payload.candidate!,
          job.payload.funding ?? "hosted",
        );
      if (job.kind === "draft")
        await generateDraft(
          job.userId,
          job.campaignId,
          job.payload.prospectId!,
          job.payload.instructions ?? "",
          (job.payload.step ?? "initial") as MessageKind,
          job.key,
        );
      if (job.kind === "send") {
        const sent = await sendConnected(job);
        await recordSent(job.userId, job.payload.messageId!, sent);
        result = sent;
      }
      await finishJob(job.id, token, "completed", result);
    } catch (error) {
      if (job.kind === "research") await releaseResearch(job.userId, [job.key]);
      const message =
        error instanceof Error ? error.message : "Execution failed";
      if (error instanceof DailyLimitError) {
        const tomorrow = new Date();
        tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
        tomorrow.setUTCHours(0, 0, 0, 0);
        await db
          .update(outreachJobs)
          .set({ status: "queued", availableAt: tomorrow, error: message })
          .where(
            and(
              eq(outreachJobs.id, job.id),
              eq(outreachJobs.leaseToken, token),
            ),
          );
      } else {
        const m = job.payload.messageId
          ? await db.query.outreachMessages.findFirst({
              where: eq(outreachMessages.id, job.payload.messageId),
            })
          : null;
        const checkpoint = await db.query.outreachJobs.findFirst({
          where: eq(outreachJobs.id, job.id),
        });
        const uncertain =
          job.kind === "send" &&
          m?.executionStatus === "sending" &&
          checkpoint?.result?.phase === "clicked" &&
          !/failed \((400|401|403|404|429)\)|Gmail refused the send/.test(
            message,
          );
        const status = uncertain ? "needs_verification" : "failed";
        // Retain provider identifiers/checkpoints on uncertain failures.
        await db
          .update(outreachJobs)
          .set({ status, error: message, updatedAt: new Date() })
          .where(
            and(
              eq(outreachJobs.id, job.id),
              eq(outreachJobs.leaseToken, token),
            ),
          );
        if (m)
          await db
            .update(outreachMessages)
            .set({ executionStatus: status, errorMessage: message })
            .where(eq(outreachMessages.id, m.id));
      }
    }
    processed++;
  }
  // Repair UI states for sends whose process died after the final click/request.
  await db.execute(
    sql`UPDATE outreach_messages m SET execution_status='needs_verification' FROM outreach_jobs j WHERE j.payload->>'messageId'=m.id::text AND j.status='needs_verification' AND m.execution_status NOT IN ('confirmed','accepted')`,
  );
  return { processed };
}
