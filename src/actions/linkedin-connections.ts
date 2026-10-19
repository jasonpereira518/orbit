"use server";

/**
 * The chunked LinkedIn connections import — see `src/lib/imports/linkedin-connections-staging.ts`.
 * Each action is `defineAction` (auth, then a shape check) + one call into it. Refusals come back as `{ error }` data:
 * a thrown message is replaced by a digest in production.
 */
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { z } from "zod";
import { defineAction, errorResult } from "@/lib/input/action";
import { anyNumber, uuid } from "@/lib/input/schemas";
import { consumeDailyCap } from "@/lib/rate-limit";
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

export const matchLinkedInConnections = defineAction(
  // Rows are validated row by row inside `matchConnections`; here only that something came.
  { schema: z.tuple([z.unknown()]), invalid: errorResult },
  async (userId, rows: unknown): Promise<{ matches: ConnectionMatch[] } | Refusal> => {
    try {
      return { matches: await matchConnections(userId, rows) };
    } catch (err) {
      return failure(err, "Couldn’t check those connections against your network — try again", "linkedin-connections.match");
    }
  }
);

export const beginLinkedInConnections = defineAction(
  { schema: z.tuple([z.string()]), invalid: errorResult },
  async (userId, fileName: string): Promise<{ importId: string } | Refusal> => {
    try {
      // The same per-day import cap every other import start charges (audit L-22).
      await consumeDailyCap("importDaily", userId);
      return await beginConnectionsStaging(userId, fileName);
    } catch (err) {
      return failure(err, "Couldn’t start that import — try again", "linkedin-connections.begin");
    }
  }
);

export const appendLinkedInConnections = defineAction(
  { schema: z.tuple([uuid, anyNumber, z.unknown()]), invalid: errorResult },
  async (userId, importId: string, startIndex: number, rows: unknown): Promise<{ appended: number } | Refusal> => {
    try {
      return await appendConnectionsRows(userId, importId, startIndex, rows);
    } catch (err) {
      return failure(err, "Couldn’t upload that part of the import — start the import again", "linkedin-connections.append");
    }
  }
);

export const startLinkedInConnections = defineAction(
  { schema: z.tuple([uuid]), invalid: errorResult },
  async (userId, importId: string): Promise<{ totalRows: number } | Refusal> => {
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
);
