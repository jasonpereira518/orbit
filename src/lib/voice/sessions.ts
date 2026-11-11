import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { chatMessages, chatThreads, orbitVoiceSessions } from "@/db/schema";
import { UserFacingError } from "@/lib/errors";
import { consumeBucket } from "@/lib/rate-limit";
import { contactsIn } from "@/lib/tools/chat-executor";
import { runTool, isToolError } from "@/lib/tools/registry";
import { SCOPE_KINDS } from "@/lib/tools/chat-write-kit";
import { VOICE_DURATION_SECONDS, VOICE_MAX_TOOL_CALLS } from "./policy";
import { requireVoiceEnabled, VoiceUnavailableError } from "./settings";
import { isSafeVoiceAgent } from "./agent-config";
import { voiceInstructions, voiceSink, voiceToolsFor } from "./tools";

export async function startVoiceSession(userId: string, timeZone: string) {
  await requireVoiceEnabled();
  await consumeBucket("voice-start-hour", userId, {
    limit: 3,
    windowSec: 3600,
  });
  await consumeBucket("voice-start-day", userId, {
    limit: 6,
    windowSec: 86400,
  });
  await consumeBucket("voice-start-global", "all", {
    limit: 100,
    windowSec: 86400,
  });
  const agentResponse = await fetch(
    `https://api.elevenlabs.io/v1/convai/agents/${encodeURIComponent(process.env.ELEVENLABS_AGENT_ID!)}`,
    {
      headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY! },
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    },
  );
  const agent = agentResponse.ok ? await agentResponse.json() : null;
  const toolIds: unknown = agent?.conversation_config?.agent?.prompt?.tool_ids;
  let resolvedTools: unknown[] | undefined;
  if (toolIds !== undefined && toolIds !== null) {
    if (
      !Array.isArray(toolIds) ||
      toolIds.length !== 1 ||
      typeof toolIds[0] !== "string"
    ) {
      throw new UserFacingError(
        "Orbit Voice’s agent must use only the orbit_tool client tool",
      );
    }
    await requireVoiceEnabled();
    const toolResponse = await fetch(
      `https://api.elevenlabs.io/v1/convai/tools/${encodeURIComponent(toolIds[0])}`,
      {
        headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY! },
        cache: "no-store",
        signal: AbortSignal.timeout(10000),
      },
    );
    resolvedTools = toolResponse.ok
      ? [(await toolResponse.json()).tool_config]
      : [];
  }
  if (!isSafeVoiceAgent(agent, resolvedTools)) {
    throw new UserFacingError(
      "Orbit Voice’s private agent needs configuration. Please contact an administrator",
    );
  }
  const instructions = await voiceInstructions(userId, timeZone);
  await requireVoiceEnabled();
  const response = await fetch(
    `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(process.env.ELEVENLABS_AGENT_ID!)}`,
    {
      headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY! },
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    },
  );
  if (!response.ok)
    throw new UserFacingError(
      "Couldn’t connect to Orbit Voice. Try again in a moment",
    );
  const payload = await response.json();
  if (
    typeof payload.signed_url !== "string" ||
    !payload.signed_url.startsWith("wss://")
  )
    throw new Error("Invalid ElevenLabs session response");
  // A disable racing the vendor request must not issue a session.
  await requireVoiceEnabled();
  const db = await getDb();
  const [thread] = await db
    .insert(chatThreads)
    .values({ userId, title: "Orbit Voice" })
    .returning();
  const [session] = await db
    .insert(orbitVoiceSessions)
    .values({
      userId,
      threadId: thread.id,
      expiresAt: new Date(Date.now() + VOICE_DURATION_SECONDS * 1000),
      timeZone,
    })
    .returning();
  return {
    sessionId: session.id,
    signedUrl: payload.signed_url,
    instructions,
    expiresAt: session.expiresAt.toISOString(),
  };
}

export async function requireVoiceSession(userId: string, sessionId: string) {
  const settings = await requireVoiceEnabled();
  const db = await getDb();
  const session = await db.query.orbitVoiceSessions.findFirst({
    where: and(
      eq(orbitVoiceSessions.id, sessionId),
      eq(orbitVoiceSessions.userId, userId),
      isNull(orbitVoiceSessions.endedAt),
      gt(orbitVoiceSessions.expiresAt, new Date()),
    ),
  });
  if (
    !session ||
    (settings.changedAt && session.createdAt < settings.changedAt)
  )
    throw new VoiceUnavailableError();
  return session;
}

export async function callVoiceTool(
  userId: string,
  sessionId: string,
  toolName: string,
  input: Record<string, unknown>,
) {
  const session = await requireVoiceSession(userId, sessionId);
  const db = await getDb();
  const [claimed] = await db
    .update(orbitVoiceSessions)
    .set({ toolCalls: sql`${orbitVoiceSessions.toolCalls} + 1` })
    .where(
      and(
        eq(orbitVoiceSessions.id, session.id),
        eq(orbitVoiceSessions.userId, userId),
        lt(orbitVoiceSessions.toolCalls, VOICE_MAX_TOOL_CALLS),
      ),
    )
    .returning();
  if (!claimed)
    throw new UserFacingError(
      "This voice session has reached its lookup limit. Start a new conversation",
    );
  const sink = voiceSink(session.scope, session.timeZone);
  const tool = (await voiceToolsFor(userId, sink)).find(
    (t) => t.name === toolName,
  );
  if (!tool)
    throw new UserFacingError("That tool isn’t available in Orbit Voice");
  const result = await runTool(tool, userId, input, {
    surface: "chat",
    scopes: ["read"],
  });
  // Only records actually returned to the agent may widen its proposal scope.
  const encoded = JSON.stringify({ untrusted_crm_data: result });
  await requireVoiceSession(userId, sessionId);
  if (encoded.length > 16000) {
    return {
      result: JSON.stringify({ error: "Result too large. Narrow the query." }),
      proposal: null,
    };
  }
  if (!isToolError(result)) {
    sink.harvest(tool.name, result);
    for (const contact of contactsIn(tool.name, result))
      sink.allow("contacts", contact.id, contact.name ?? "Contact");
  }
  // Refuse results and proposals if an admin disabled voice while a lookup was running.
  await requireVoiceSession(userId, sessionId);
  const scope = Object.fromEntries(
    SCOPE_KINDS.map((k) => [k, [...sink.scope[k].entries()]]),
  );
  await db
    .update(orbitVoiceSessions)
    .set({ scope })
    .where(eq(orbitVoiceSessions.id, session.id));
  const proposal = sink.latest();
  let messageId: string | null = null;
  if (proposal) {
    const [message] = await db
      .insert(chatMessages)
      .values({
        userId,
        threadId: session.threadId,
        role: "assistant",
        content: proposal.preview,
        proposedActions: [proposal],
      })
      .returning();
    messageId = message.id;
    await db
      .update(chatThreads)
      .set({ updatedAt: new Date() })
      .where(eq(chatThreads.id, session.threadId));
  }
  return {
    result: encoded,
    proposal: proposal && messageId ? { messageId, action: proposal } : null,
  };
}

export async function endVoiceSession(userId: string, sessionId: string) {
  const db = await getDb();
  await db
    .update(orbitVoiceSessions)
    .set({ endedAt: new Date() })
    .where(
      and(
        eq(orbitVoiceSessions.id, sessionId),
        eq(orbitVoiceSessions.userId, userId),
      ),
    );
}

/** The existing confirmation action must enforce voice's switch too, including direct POSTs. */
export async function guardVoiceProposal(userId: string, messageId: string) {
  const db = await getDb();
  const row = await db.query.chatMessages.findFirst({
    where: and(eq(chatMessages.id, messageId), eq(chatMessages.userId, userId)),
    columns: { threadId: true },
  });
  if (!row) return;
  const session = await db.query.orbitVoiceSessions.findFirst({
    where: and(
      eq(orbitVoiceSessions.threadId, row.threadId),
      eq(orbitVoiceSessions.userId, userId),
    ),
  });
  // Cards remain reviewable in history after a call ends, but the kill switch still applies.
  if (session) {
    const state = await requireVoiceEnabled();
    if (state.changedAt && session.createdAt < state.changedAt)
      throw new VoiceUnavailableError();
  }
}
