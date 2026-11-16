import { z } from "zod";

/** What the browser may send to `beginChatImport` (`src/actions/chat-imports.ts`). */
export const beginChatImportSchema = z.object({
  source: z.enum(["whatsapp", "imessage"]),
  fileName: z.string(),
  selfNames: z.array(z.string()),
});
