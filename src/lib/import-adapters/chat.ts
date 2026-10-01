/**
 * WhatsApp and iMessage conversations, one row per (conversation, participant). Rows are
 * built in the browser after a preview that already decided who each participant is, so
 * `resolvedContactId` usually settles the match; a row with neither a pin nor permission to
 * create (an unticked group member) is skipped, never auto-created.
 */
import type { ChatConversationRowPayload } from "@/db/schema";
import type { ImportAdapter, InteractionInsert } from "@/lib/import-engine";
import { clampCodePoints } from "@/lib/conversations/clamp";
import { sessionExternalId } from "@/lib/conversations/sessions";
import { kickRelationshipRun } from "@/lib/relationship-engine/runner";

export const WHATSAPP_CHAT_IMPORT_TYPE = "whatsapp_chat";
export const IMESSAGE_CHAT_IMPORT_TYPE = "imessage_chat";

const LABEL = { whatsapp: "WhatsApp", imessage: "iMessage" } as const;

function range(p: ChatConversationRowPayload) {
  const starts = p.sessions.map((s) => s.startAt).sort();
  const ends = p.sessions.map((s) => s.endAt).sort();
  return {
    earliest: starts.length ? new Date(starts[0]) : null,
    latest: ends.length ? new Date(ends[ends.length - 1]) : null,
  };
}

export function chatAdapter(source: "whatsapp" | "imessage"): ImportAdapter<ChatConversationRowPayload> {
  return {
    // A long chat is staged as several rows per participant (to-rows' size bounds); they are
    // one person, settled once.
    samePersonPaths: [["conversationKey"], ["participant", "key"]],
    resolvedContactId(p) {
      return p.resolvedContactId ?? null;
    },
    identity(p) {
      if (!p.createIfUnmatched) return null;
      return { fullName: p.participant.displayName, email: p.participant.email ?? undefined };
    },
    toCreate(p) {
      const { earliest, latest } = range(p);
      return {
        fullName: p.participant.displayName,
        phone: p.participant.phoneE164 ?? undefined,
        email: p.participant.email ?? undefined,
        source: `${source}_chat`,
        relationshipScore: 2,
        howMet: `${LABEL[source]} messages`,
        metContext: "online",
        tagNames: [source],
        firstInteractionAt: earliest ?? undefined,
        dateMet: latest ? latest.toISOString() : undefined,
      };
    },
    toMerge(p) {
      // No phone/email: `bulkMergeContactsForUser` COALESCEs the incoming value OVER the
      // stored one, so a chat participant's number would overwrite a curated contact's.
      const { earliest, latest } = range(p);
      return {
        firstInteractionAt: earliest ?? undefined,
        lastInteractionAt: latest ?? undefined,
      };
    },
    interactions(p, contactId, userId): InteractionInsert[] {
      return p.sessions
        .filter((s) => s.transcript.trim())
        .map((s) => ({
          userId,
          contactId,
          interactionType: "message",
          interactionDate: new Date(s.endAt),
          source,
          externalId: sessionExternalId(source, p.conversationKey, s.startAt, contactId),
          rawNotes: s.transcript,
          aiSummary: clampCodePoints(s.transcript, 240),
          topics: [],
          direction: s.direction,
        }));
    },
    async finalize(userId, contactIds) {
      if (contactIds.length === 0) return;
      await kickRelationshipRun(userId);
    },
  };
}
