"use server";

/**
 * WhatsApp / iMessage imports: preview, then a chunked upload of rows the browser built.
 * Each action is `requireUserId` + one call into `src/lib/chat-import-preview.ts`, which owns
 * the feature gate, ownership checks and row validation. Refusals come back as `{ error }`
 * data — a thrown message is replaced by a digest in production.
 */
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { requireUserId } from "@/lib/auth";
import { actionFailure } from "@/lib/action-failure";
import {
  appendStagedRows,
  beginStaging,
  buildChatPreview,
  startStaged,
  type ChatPreviewConversation,
  type ChatPreviewResult,
} from "@/lib/chat-import-preview";
import { isUserFacingError } from "@/lib/errors";
import { runImportJobById } from "@/lib/import-job-dispatch";

type Refusal = { error: string };

/** Typed, for the reason `refusal` in `src/actions/imports.ts` gives: `"error" in res` must narrow. */
function refusal(message: string): Refusal {
  return { error: message };
}

/** A `UserFacingError` is written for the person; anything else is reported and replaced. */
async function failure(err: unknown, fallback: string, where: string): Promise<Refusal> {
  return refusal(isUserFacingError(err) ? err.message : await actionFailure(err, fallback, where));
}

export async function previewChatConversations(
  convs: ChatPreviewConversation[],
): Promise<ChatPreviewResult | Refusal> {
  const userId = await requireUserId();
  try {
    return await buildChatPreview(userId, convs);
  } catch (err) {
    return failure(err, "Couldn’t match those chats — try again", "chat-imports.preview");
  }
}

export async function beginChatImport(input: {
  source: "whatsapp" | "imessage";
  fileName: string;
  selfNames: string[];
}): Promise<{ importId: string } | Refusal> {
  const userId = await requireUserId();
  try {
    return await beginStaging(userId, input);
  } catch (err) {
    return failure(err, "Couldn’t start that import — try again", "chat-imports.begin");
  }
}

export async function appendChatRows(
  importId: string,
  startIndex: number,
  rows: unknown[],
): Promise<{ appended: number } | Refusal> {
  const userId = await requireUserId();
  try {
    return await appendStagedRows(userId, importId, startIndex, rows);
  } catch (err) {
    return failure(err, "Couldn’t upload that part of the import — start the import again", "chat-imports.append");
  }
}

/**
 * Flips the staged job to `processing` and hands it to the engine in the background, the
 * same way `startLinkedInMessagesImport` does. Survives tab close; the client polls
 * `getImportJobStatus`.
 */
export async function startChatImport(importId: string): Promise<{ totalRows: number } | Refusal> {
  const userId = await requireUserId();
  let started: { totalRows: number };
  try {
    started = await startStaged(userId, importId);
  } catch (err) {
    return failure(err, "Couldn’t start that import — try again", "chat-imports.start");
  }

  after(() => runImportJobById(importId).catch(() => {}));

  revalidatePath("/imports");

  return started;
}
