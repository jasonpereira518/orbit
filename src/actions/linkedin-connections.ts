"use server";

/**
 * The chunked LinkedIn connections import — see `src/lib/imports/linkedin-connections-staging.ts`.
 * Each action is `requireUserId` + one call into it. Refusals come back as `{ error }` data:
 * a thrown message is replaced by a digest in production.
 */
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { requireUserId } from "@/lib/auth";
import { actionFailure } from "@/lib/action-failure";
import { isUserFacingError } from "@/lib/errors";
import { runLinkedInImportJob } from "@/lib/import-job-processor";
import {
  appendConnectionsRows,
  beginConnectionsStaging,
  matchConnections,
  startConnectionsStaged,
} from "@/lib/imports/linkedin-connections-staging";
import type { ConnectionMatch } from "@/lib/imports/linkedin-connections-chunks";

type Refusal = { error: string };

async function failure(err: unknown, fallback: string, where: string): Promise<Refusal> {
  return { error: isUserFacingError(err) ? err.message : await actionFailure(err, fallback, where) };
}

export async function matchLinkedInConnections(rows: unknown): Promise<{ matches: ConnectionMatch[] } | Refusal> {
  const userId = await requireUserId();
  try {
    return { matches: await matchConnections(userId, rows) };
  } catch (err) {
    return failure(err, "Couldn’t check those connections against your network — try again", "linkedin-connections.match");
  }
}

export async function beginLinkedInConnections(fileName: string): Promise<{ importId: string } | Refusal> {
  const userId = await requireUserId();
  try {
    return await beginConnectionsStaging(userId, fileName);
  } catch (err) {
    return failure(err, "Couldn’t start that import — try again", "linkedin-connections.begin");
  }
}

export async function appendLinkedInConnections(
  importId: string,
  startIndex: number,
  rows: unknown,
): Promise<{ appended: number } | Refusal> {
  const userId = await requireUserId();
  try {
    return await appendConnectionsRows(userId, importId, startIndex, rows);
  } catch (err) {
    return failure(err, "Couldn’t upload that part of the import — start the import again", "linkedin-connections.append");
  }
}

export async function startLinkedInConnections(importId: string): Promise<{ totalRows: number } | Refusal> {
  const userId = await requireUserId();
  let started: { totalRows: number };
  try {
    started = await startConnectionsStaged(userId, importId);
  } catch (err) {
    return failure(err, "Couldn’t start that import — try again", "linkedin-connections.start");
  }
  after(() => runLinkedInImportJob(importId).catch(() => {}));
  revalidatePath("/imports");
  return started;
}
