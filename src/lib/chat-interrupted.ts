import type { buildChatBlocks } from "@/lib/chat-context";
import { expandLists, stripInvalidDirectives } from "@/lib/chat-directives";
import { citedIds, stripUnresolvedMarkers, type EvidenceSource } from "@/lib/chat-evidence";
import { markTurnStopped, persistAssistantTurn, wasTurnStopped } from "@/lib/chat-persist";
import type { ChatStep } from "@/lib/chat-stream-protocol";

/**
 * Store the part of an answer that streamed before the connection dropped (audit L-25), then
 * re-read the Stop mark: a Stop that landed between the route's first check and this insert
 * would otherwise find no answer to discard, so the route discards it itself.
 */
export async function persistInterruptedAnswer(input: {
  userId: string;
  threadId: string | null;
  turnId: string | null;
  question: string;
  title: string | null;
  answer: string;
  evidence: Record<string, EvidenceSource>;
  blocks: ReturnType<typeof buildChatBlocks>;
  activity: ChatStep[];
}) {
  const { text: unmarked } = stripUnresolvedMarkers(input.answer, new Set(Object.keys(input.evidence)));
  const { text: clean } = stripInvalidDirectives(unmarked, {
    people: new Set(Object.keys(input.blocks.people)),
    lists: new Set(Object.keys(input.blocks.lists)),
  });
  if (!clean.trim()) return;
  const cited = Object.fromEntries(
    citedIds(clean)
      .filter((id) => input.evidence[id])
      .map((id) => [id, input.evidence[id]!])
  );
  await persistAssistantTurn(input.userId, input.threadId, input.title, input.question, {
    answer: expandLists(clean, input.blocks.lists),
    recommendations: [],
    activity: input.activity,
    evidence: cited,
    interrupted: { clientTurnId: input.turnId },
  });
  if (input.turnId && input.threadId && (await wasTurnStopped(input.userId, input.threadId, input.turnId))) {
    await markTurnStopped(input.userId, input.threadId, input.turnId);
  }
}
