"use server";

/**
 * WhatsApp / iMessage imports: preview, then a chunked upload of rows the browser built.
 * Each action is `requireUserId` + one call into `src/lib/chat-import-preview.ts`, which owns
 * the feature gate, ownership checks and row validation. Refusals come back as `{ error }`
 * data — a thrown message is replaced by a digest in production.
 */
import { revalidatePath } from "next/cache";
import { after } from "next/server";
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
import { z } from "zod";
import { defineAction, errorResult } from "@/lib/input/action";
import { anyNumber } from "@/lib/input/schemas";

// Argument shapes, generated from the handlers' parameter types.
const ChatPreviewParticipantSchema = z.looseObject({ key: z.string(), displayName: z.string(), phoneE164: z.string().nullable(), email: z.string().nullable() });
const ChatPreviewConversationSchema = z.looseObject({ key: z.string(), source: z.enum(["whatsapp", "imessage"]), title: z.string(), titleFromFile: z.boolean().optional(), isGroup: z.boolean(), participants: z.array(ChatPreviewParticipantSchema), messageCount: anyNumber, chars: anyNumber, firstAt: z.string(), lastAt: z.string() });

type Refusal = { error: string };

/** Typed, for the reason `refusal` in `src/actions/imports.ts` gives: `"error" in res` must narrow. */
function refusal(message: string): Refusal {
  return { error: message };
}

/** A `UserFacingError` is written for the person; anything else is reported and replaced. */
async function failure(err: unknown, fallback: string, where: string): Promise<Refusal> {
  return refusal(isUserFacingError(err) ? err.message : await actionFailure(err, fallback, where));
}

export const previewChatConversations = defineAction(
  { schema: z.tuple([z.array(ChatPreviewConversationSchema)]), invalid: errorResult },
  async (userId, convs: ChatPreviewConversation[]): Promise<ChatPreviewResult | Refusal> => {
    try {
      return await buildChatPreview(userId, convs);
    } catch (err) {
      return failure(err, "Couldn’t match those chats — try again", "chat-imports.preview");
    }
  }
);

export const beginChatImport = defineAction(
  { schema: z.tuple([z.looseObject({ source: z.enum(["whatsapp", "imessage"]), fileName: z.string(), selfNames: z.array(z.string()) })]), invalid: errorResult },
  async (userId, input: {
    source: "whatsapp" | "imessage";
    fileName: string;
    selfNames: string[];
  }): Promise<{ importId: string } | Refusal> => {
    try {
      return await beginStaging(userId, input);
    } catch (err) {
      return failure(err, "Couldn’t start that import — try again", "chat-imports.begin");
    }
  }
);

export const appendChatRows = defineAction(
  { schema: z.tuple([z.string(), anyNumber, z.array(z.unknown())]), invalid: errorResult },
  async (userId, importId: string, startIndex: number, rows: unknown[]): Promise<{ appended: number } | Refusal> => {
    try {
      return await appendStagedRows(userId, importId, startIndex, rows);
    } catch (err) {
      return failure(err, "Couldn’t upload that part of the import — start the import again", "chat-imports.append");
    }
  }
);

/**
 * Flips the staged job to `processing` and hands it to the engine in the background, the
 * same way `startLinkedInMessagesImport` does. Survives tab close; the client polls
 * `getImportJobStatus`.
 */
export const startChatImport = defineAction(
  { schema: z.tuple([z.string()]), invalid: errorResult },
  async (userId, importId: string): Promise<{ totalRows: number } | Refusal> => {
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
);
