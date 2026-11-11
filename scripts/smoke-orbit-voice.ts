/** Real PGlite boundaries, fake vendor: never makes a live provider request. */
import "./smoke/_env";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, and, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import {
  contacts,
  chatMessages,
  chatThreads,
  orbitVoiceSessions,
  interactions,
  siteSettings,
} from "../src/db/schema";
import {
  getVoiceSettings,
  requireVoiceEnabled,
  setVoiceEnabled,
  VoiceUnavailableError,
} from "../src/lib/voice/settings";
import {
  startVoiceSession,
  callVoiceTool,
  endVoiceSession,
  requireVoiceSession,
  guardVoiceProposal,
} from "../src/lib/voice/sessions";
import { voiceAvailable, VOICE_MAX_TOOL_CALLS } from "../src/lib/voice/policy";
import {
  ORBIT_VOICE_AGENT_CONFIG,
  isSafeVoiceAgent,
} from "../src/lib/voice/agent-config";
import {
  voiceReadTools,
  voiceToolsFor,
  voiceSink,
} from "../src/lib/voice/tools";
import { commitProposedAction } from "../src/actions/chat-actions";
import { bootstrapAuthenticatedUser } from "../src/lib/auth";

delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
delete process.env.CLERK_SECRET_KEY;
(process.env as Record<string, string>).NODE_ENV = "development";
process.env.ORBIT_DEMO_DATA = "off";
process.env.ELEVENLABS_API_KEY = "fake-voice-test-key";
process.env.ELEVENLABS_AGENT_ID = "fake-private-agent";
const USER = "demo-user";
const OTHER = "voice-other-user";
async function main() {
  const db = await getDb();
  await bootstrapAuthenticatedUser(USER);
  assert.equal(voiceAvailable(undefined, true), false);
  assert.equal(voiceAvailable(null, true), false);
  assert.equal(voiceAvailable(true, false), false);
  assert.equal((await getVoiceSettings()).enabled, false);
  let providerCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    providerCalls++;
    assert.equal(
      new Headers(init?.headers).get("xi-api-key"),
      "fake-voice-test-key",
    );
    if (url.includes("/agents/"))
      return Response.json(ORBIT_VOICE_AGENT_CONFIG);
    assert.match(url, /get-signed-url/);
    return Response.json({
      signed_url: "wss://api.elevenlabs.io/v1/convai/conversation?test=only",
    });
  };
  const fixtureContactIds: string[] = [];
  const fixtureThreadIds: string[] = [];
  try {
    await assert.rejects(startVoiceSession(USER, "UTC"), VoiceUnavailableError);
    assert.equal(providerCalls, 0, "off must cause zero provider calls");
    console.log("ok default off prevents API usage");
    const [mine] = await db
      .insert(contacts)
      .values({
        userId: USER,
        fullName: "Voice Test Ada",
        notes: "Met at our design workshop",
        aiSummary: "Works on compilers",
      })
      .returning();
    const [theirs] = await db
      .insert(contacts)
      .values({
        userId: OTHER,
        fullName: "Private Other Contact",
        notes: "other-user-secret",
      })
      .returning();
    fixtureContactIds.push(mine.id, theirs.id);
    await setVoiceEnabled("test-admin", true);
    const started = await startVoiceSession(USER, "UTC");
    assert.equal(providerCalls, 2);
    assert.ok(
      !started.instructions.includes(mine.notes!),
      "no account dump in system prompt",
    );
    await assert.rejects(
      requireVoiceSession(OTHER, started.sessionId),
      VoiceUnavailableError,
    );
    await assert.rejects(
      callVoiceTool(OTHER, started.sessionId, "get_contact", {
        contactId: mine.id,
      }),
      VoiceUnavailableError,
    );
    const hidden = await callVoiceTool(USER, started.sessionId, "get_contact", {
      contactId: theirs.id,
    });
    assert.ok(!hidden.result.includes("other-user-secret"));
    assert.ok(!hidden.result.includes("Private Other Contact"));
    const found = await callVoiceTool(USER, started.sessionId, "get_contact", {
      contactId: mine.id,
    });
    assert.ok(found.result.includes("Voice Test Ada"));
    assert.ok(found.result.includes("Works on compilers"));
    assert.equal(found.proposal, null);
    console.log(
      "ok reads and sessions are account scoped and include existing AI knowledge",
    );
    const [large] = await db
      .insert(contacts)
      .values({ userId: USER, fullName: "Voice Large Result" })
      .returning();
    fixtureContactIds.push(large.id);
    const read = voiceReadTools().find((t) => t.name === "get_contact")!;
    const originalRun = read.run;
    try {
      read.run = async () => ({
        id: large.id,
        name: large.fullName,
        notes: "x".repeat(20000),
      });
      const oversized = await callVoiceTool(
        USER,
        started.sessionId,
        "get_contact",
        { contactId: large.id },
      );
      assert.match(oversized.result, /Result too large/);
      const unseenLarge = await callVoiceTool(
        USER,
        started.sessionId,
        "log_note",
        { contactId: large.id, text: "Must not be proposed" },
      );
      assert.equal(
        unseenLarge.proposal,
        null,
        "discarded output cannot authorize IDs for a later proposal",
      );
    } finally {
      read.run = originalRun;
    }

    await assert.rejects(
      callVoiceTool(USER, started.sessionId, "request_send", {}),
      /isn’t available/,
    );
    const invalid = await callVoiceTool(
      USER,
      started.sessionId,
      "get_contact",
      { contactId: "invalid" },
    );
    assert.match(invalid.result, /error/);
    const unseen = await callVoiceTool(USER, started.sessionId, "log_note", {
      contactId: theirs.id,
      text: "attack",
    });
    assert.equal(unseen.proposal, null);
    const proposal = await callVoiceTool(USER, started.sessionId, "log_note", {
      contactId: mine.id,
      text: "Discussed the launch plan",
    });
    assert.ok(proposal.proposal);
    assert.equal(proposal.proposal.action.status, "proposed");
    let notes = await db.query.interactions.findMany({
      where: and(
        eq(interactions.contactId, mine.id),
        eq(interactions.rawNotes, "Discussed the launch plan"),
      ),
    });
    assert.equal(notes.length, 0, "agent cannot modify CRM by proposing");
    const card = proposal.proposal;
    const committed = await commitProposedAction(
      card.messageId,
      card.action.id,
    );
    assert.equal(committed.ok, true);
    assert.equal(
      (await commitProposedAction(card.messageId, card.action.id)).ok,
      false,
      "double click cannot commit twice",
    );
    notes = await db.query.interactions.findMany({
      where: and(
        eq(interactions.contactId, mine.id),
        eq(interactions.rawNotes, "Discussed the launch plan"),
      ),
    });
    assert.equal(notes.length, 1);
    console.log("ok writes require stored human confirmation and commit once");
    const pending = await callVoiceTool(USER, started.sessionId, "log_note", {
      contactId: mine.id,
      text: "Do not save while off",
    });
    assert.ok(pending.proposal);
    await setVoiceEnabled("test-admin", false);
    const callsBefore = providerCalls;
    await assert.rejects(startVoiceSession(USER, "UTC"), VoiceUnavailableError);
    await assert.rejects(
      callVoiceTool(USER, started.sessionId, "get_contact", {
        contactId: mine.id,
      }),
      VoiceUnavailableError,
    );
    await assert.rejects(
      commitProposedAction(
        pending.proposal.messageId,
        pending.proposal.action.id,
      ),
      VoiceUnavailableError,
    );
    assert.equal(providerCalls, callsBefore);
    // Ordinary text proposals are unaffected by the voice switch.
    const [textThread] = await db
      .insert(chatThreads)
      .values({ userId: USER, title: "Text chat" })
      .returning();
    fixtureThreadIds.push(textThread.id);
    const [textMessage] = await db
      .insert(chatMessages)
      .values({
        userId: USER,
        threadId: textThread.id,
        role: "assistant",
        content: "Text reply",
      })
      .returning();
    await guardVoiceProposal(USER, textMessage.id);
    await endVoiceSession(USER, started.sessionId);
    console.log(
      "ok disabling blocks starts, tools and direct confirmation, and preserves text chat and cleanup",
    );
    await setVoiceEnabled("test-admin", true);
    await assert.rejects(
      requireVoiceSession(USER, started.sessionId),
      VoiceUnavailableError,
    );
    const active = await startVoiceSession(USER, "UTC");
    await db
      .update(orbitVoiceSessions)
      .set({ expiresAt: new Date(0) })
      .where(eq(orbitVoiceSessions.id, active.sessionId));
    await assert.rejects(
      callVoiceTool(USER, active.sessionId, "get_contact", {
        contactId: mine.id,
      }),
      VoiceUnavailableError,
    );
    const limited = await startVoiceSession(OTHER, "UTC");
    await db
      .update(orbitVoiceSessions)
      .set({ toolCalls: VOICE_MAX_TOOL_CALLS })
      .where(eq(orbitVoiceSessions.id, limited.sessionId));
    await assert.rejects(
      callVoiceTool(OTHER, limited.sessionId, "get_contact", {
        contactId: theirs.id,
      }),
      /lookup limit/,
    );
    console.log(
      "ok ended and expired sessions fail closed; tool budget is enforced in the database",
    );
    const oldFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      Response.json({
        ...ORBIT_VOICE_AGENT_CONFIG,
        platform_settings: { auth: { enable_auth: false } },
      });
    await assert.rejects(
      startVoiceSession("public-agent-test", "UTC"),
      /needs configuration/,
    );
    globalThis.fetch = oldFetch;
    assert.equal(isSafeVoiceAgent(ORBIT_VOICE_AGENT_CONFIG), true);
    assert.equal(isSafeVoiceAgent({}), false);
    assert.ok(voiceReadTools().every((t) => t.scope === "read"));
    const tools = await voiceToolsFor(USER, voiceSink({}, "UTC"));
    assert.ok(tools.some((t) => t.name === "log_note"));
    assert.ok(tools.every((t) => t.scope === "read"));
    assert.ok(!tools.some((t) => t.name === "delete_contact"));
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes("/agents/"))
        return Response.json({
          ...ORBIT_VOICE_AGENT_CONFIG,
          conversation_config: {
            ...ORBIT_VOICE_AGENT_CONFIG.conversation_config,
            agent: {
              ...ORBIT_VOICE_AGENT_CONFIG.conversation_config.agent,
              prompt: {
                ...ORBIT_VOICE_AGENT_CONFIG.conversation_config.agent.prompt,
                tools: undefined,
                tool_ids: ["tool_current_api"],
              },
            },
          },
        });
      if (url.includes("/tools/"))
        return Response.json({
          tool_config:
            ORBIT_VOICE_AGENT_CONFIG.conversation_config.agent.prompt.tools[0],
        });
      return Response.json({
        signed_url: "wss://api.elevenlabs.io/v1/convai/conversation?current=1",
      });
    };
    const modern = await startVoiceSession(USER, "America/New_York");
    assert.ok(modern.instructions.includes("America/New_York"));
    assert.ok(modern.instructions.includes("Current time:"));
    console.log(
      "ok current tool_ids API resolves and validates the private client tool",
    );

    let racedProviderCalls = 0;
    globalThis.fetch = async () => {
      racedProviderCalls++;
      await setVoiceEnabled("test-admin", false);
      return Response.json(ORBIT_VOICE_AGENT_CONFIG);
    };
    await assert.rejects(
      startVoiceSession("voice-disable-race", "UTC"),
      VoiceUnavailableError,
    );
    assert.equal(
      racedProviderCalls,
      1,
      "disabling during preflight must prevent signed-URL minting",
    );
    console.log(
      "ok disabling during provider preflight prevents session issuance",
    );
    delete process.env.ELEVENLABS_API_KEY;
    await assert.rejects(requireVoiceEnabled(), VoiceUnavailableError);
    console.log(
      "ok private bounded agent, read-only registry, allowlists and missing-key enforcement",
    );
    const sessionBefore = await db.query.orbitVoiceSessions.findFirst({
      where: eq(orbitVoiceSessions.id, limited.sessionId),
    });
    await endVoiceSession(USER, limited.sessionId);
    const sessionAfter = await db.query.orbitVoiceSessions.findFirst({
      where: eq(orbitVoiceSessions.id, limited.sessionId),
    });
    assert.equal(
      sessionBefore?.endedAt,
      sessionAfter?.endedAt,
      "cross-account stop cannot alter a session",
    );
    await assert.rejects(
      requireVoiceSession(USER, randomUUID()),
      VoiceUnavailableError,
    );
    await db
      .update(siteSettings)
      .set({ orbitVoiceEnabled: false })
      .where(eq(siteSettings.id, 1));
    console.log("Orbit Voice smoke passed");
  } finally {
    globalThis.fetch = originalFetch;
    const sessions = await db.query.orbitVoiceSessions.findMany({
      where: inArray(orbitVoiceSessions.userId, [USER, OTHER]),
    });
    const threadIds = [...fixtureThreadIds, ...sessions.map((s) => s.threadId)];
    if (threadIds.length)
      await db.delete(chatThreads).where(inArray(chatThreads.id, threadIds));
    if (fixtureContactIds.length)
      await db.delete(contacts).where(inArray(contacts.id, fixtureContactIds));
  }
}
main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
