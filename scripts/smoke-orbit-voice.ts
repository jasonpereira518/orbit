/** Disposable PGlite, mocked credentials, both providers. Never calls a live provider. */
import "./smoke/_env";
import { run, setDeepgramEnabledForSmoke } from "./smoke/_env";
import assert from "node:assert/strict";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import {
  contacts,
  interactions,
  chatThreads,
  chatMessages,
  orbitVoiceSessions,
  siteSettings,
} from "../src/db/schema";
import { bootstrapAuthenticatedUser } from "../src/lib/auth";
import {
  getVoiceSettings,
  setVoiceEnabled,
  setVoiceConfig,
  voicePublicState,
  VoiceUnavailableError,
} from "../src/lib/voice/settings";
import {
  startVoiceSession,
  callVoiceTool,
  endVoiceSession,
  requireVoiceSession,
  connectVoiceSession,
  heartbeatVoiceSession,
  guardVoiceProposal,
} from "../src/lib/voice/sessions";
import {
  ORBIT_VOICE_AGENT_CONFIG,
  isSafeVoiceAgent,
} from "../src/lib/voice/agent-config";
import {
  DEFAULT_VOICE_CONFIG,
  voiceConfigSchema,
  selectedVoiceProvider,
  type VoiceProvider,
} from "../src/lib/voice/config";
import {
  VoiceProviderError,
  voiceCredentials,
} from "../src/lib/voice/providers";
import { voiceUsageSummary } from "../src/lib/voice/admin";
import { voiceReadTools } from "../src/lib/voice/tools";
import { VOICE_MAX_TOOL_CALLS } from "../src/lib/voice/policy";
import { commitProposedAction } from "../src/actions/chat-actions";

delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
delete process.env.CLERK_SECRET_KEY;
(process.env as Record<string, string>).NODE_ENV = "development";
process.env.ORBIT_DEMO_DATA = "off";
setDeepgramEnabledForSmoke(true);
process.env.ELEVENLABS_API_KEY = "fake-voice-test-key";
process.env.ELEVENLABS_AGENT_ID = "fake-private-agent";
const USER = "demo-user";
const OTHER = "voice-other-user";
async function main() {
  const db = await getDb();
  await bootstrapAuthenticatedUser(USER);
  await db
    .insert(siteSettings)
    .values({
      id: 1,
      orbitVoiceEnabled: false,
      orbitVoiceConfig: DEFAULT_VOICE_CONFIG,
    })
    .onConflictDoUpdate({
      target: siteSettings.id,
      set: { orbitVoiceEnabled: false, orbitVoiceConfig: DEFAULT_VOICE_CONFIG },
    });
  const originalFetch = globalThis.fetch;
  let calls = 0;
  let rejectDeepgram = false;
  let unsafeEleven = false;
  let onGrant: (() => Promise<void>) | undefined;
  globalThis.fetch = async (input, init) => {
    calls++;
    const url = String(input);
    if (url.includes("/auth/grant")) {
      assert.equal(JSON.parse(String(init?.body)).ttl_seconds, 30);
      assert.equal(
        new Headers(init?.headers).get("Authorization"),
        "Token smoke-placeholder-not-a-key",
      );
      if (onGrant) await onGrant();
      return rejectDeepgram
        ? new Response("private provider failure", { status: 503 })
        : Response.json({
            access_token: "short-lived-fake-token",
            expires_in: 30,
          });
    }
    assert.equal(
      new Headers(init?.headers).get("xi-api-key"),
      "fake-voice-test-key",
    );
    if (url.includes("/agents/"))
      return Response.json(unsafeEleven ? {} : ORBIT_VOICE_AGENT_CONFIG);
    if (url.includes("/tools/"))
      return Response.json({
        tool_config:
          ORBIT_VOICE_AGENT_CONFIG.conversation_config.agent.prompt.tools[0],
      });
    assert.match(url, /get-signed-url/);
    return Response.json({
      signed_url: "wss://api.elevenlabs.io/v1/convai/conversation?test=1",
    });
  };
  const fixtureContacts: string[] = [];
  const fixtureThreads: string[] = [];
  try {
    assert.equal((await getVoiceSettings()).config.provider, "deepgram");
    assert.equal((await getVoiceSettings()).enabled, false);
    assert.throws(() =>
      voiceConfigSchema.parse({ provider: "arbitrary-host" }),
    );
    assert.throws(() => selectedVoiceProvider(DEFAULT_VOICE_CONFIG, true));
    await assert.rejects(startVoiceSession(USER, "UTC"), VoiceUnavailableError);
    assert.equal(calls, 0);
    console.log(
      "ok Deepgram default, fallback opt-in and default-off enforcement",
    );
    const [mine] = await db
      .insert(contacts)
      .values({
        userId: USER,
        fullName: "Voice Ada",
        notes: "Workshop notes",
        aiSummary: "Compiler researcher",
      })
      .returning();
    const [other] = await db
      .insert(contacts)
      .values({
        userId: OTHER,
        fullName: "Private stranger",
        notes: "other-account-secret",
      })
      .returning();
    fixtureContacts.push(mine.id, other.id);
    const sessions: string[] = [];
    for (const provider of ["deepgram", "elevenlabs"] as VoiceProvider[]) {
      await setVoiceConfig("test-admin", { ...DEFAULT_VOICE_CONFIG, provider });
      await setVoiceEnabled("test-admin", true);
      const start = await startVoiceSession(USER, "America/New_York", false, [
        { source: "user", text: "Prepare for Ada" },
      ]);
      sessions.push(start.sessionId);
      assert.equal(start.credentials.provider, provider);
      if (start.credentials.provider === "deepgram") {
        assert.equal(start.credentials.accessToken, "short-lived-fake-token");
        const agent = start.credentials.agent as {
          think?: {
            prompt?: string;
            functions?: Array<{
              endpoint?: unknown;
              defer_until_eot?: boolean;
            }>;
          };
        };
        assert.ok(agent.think?.prompt?.includes("Prepare for Ada"));
        assert.ok(agent.think?.prompt?.includes("America/New_York"));
        assert.ok(
          agent.think?.functions?.every(
            (f) => !f.endpoint && f.defer_until_eot,
          ),
        );
        assert.ok(
          !JSON.stringify(start).includes("smoke-placeholder-not-a-key"),
        );
      } else {
        assert.ok(start.credentials.instructions.includes("America/New_York"));
        assert.ok(!JSON.stringify(start).includes("fake-voice-test-key"));
      }
      await assert.rejects(
        requireVoiceSession(OTHER, start.sessionId),
        VoiceUnavailableError,
      );
      const hidden = await callVoiceTool(USER, start.sessionId, "get_contact", {
        contactId: other.id,
      });
      assert.ok(!hidden.result.includes("other-account-secret"));
      const found = await callVoiceTool(USER, start.sessionId, "get_contact", {
        contactId: mine.id,
      });
      assert.ok(found.result.includes("Compiler researcher"));
      await assert.rejects(
        callVoiceTool(USER, start.sessionId, "request_send", {}),
        /isn’t available/,
      );
      const unseen = await callVoiceTool(USER, start.sessionId, "log_note", {
        contactId: other.id,
        text: "attack",
      });
      assert.equal(unseen.proposal, null);
      const text = `Confirmed ${provider} note`;
      const proposal = await callVoiceTool(USER, start.sessionId, "log_note", {
        contactId: mine.id,
        text,
      });
      assert.ok(proposal.proposal);
      assert.equal(
        (
          await db.query.interactions.findMany({
            where: and(
              eq(interactions.contactId, mine.id),
              eq(interactions.rawNotes, text),
            ),
          })
        ).length,
        0,
      );
      assert.equal(
        (
          await commitProposedAction(
            proposal.proposal.messageId,
            proposal.proposal.action.id,
          )
        ).ok,
        true,
      );
      assert.equal(
        (
          await commitProposedAction(
            proposal.proposal.messageId,
            proposal.proposal.action.id,
          )
        ).ok,
        false,
      );
      await connectVoiceSession(USER, start.sessionId);
      await heartbeatVoiceSession(USER, start.sessionId);
      const row = await requireVoiceSession(USER, start.sessionId);
      assert.ok(row.connectedAt && row.lastSeenAt);
      assert.equal(row.provider, provider);
      await endVoiceSession(OTHER, start.sessionId);
      assert.ok(!(await requireVoiceSession(USER, start.sessionId)).endedAt);
      console.log(
        `ok ${provider}: scoped CRM + AI knowledge, confirmation-only writes, connection usage`,
      );
    }
    await assert.rejects(
      requireVoiceSession(USER, sessions[0]),
      VoiceUnavailableError,
    );
    console.log("ok switching provider invalidates old sessions server-side");
    await setVoiceConfig("test-admin", {
      ...DEFAULT_VOICE_CONFIG,
      provider: "deepgram",
    });
    const callsBefore = calls;
    await assert.rejects(
      startVoiceSession(OTHER, "UTC", true),
      VoiceUnavailableError,
    );
    assert.equal(calls, callsBefore);
    await setVoiceConfig("test-admin", {
      ...DEFAULT_VOICE_CONFIG,
      fallback: "offer-alternative",
    });
    const fallback = await startVoiceSession(OTHER, "UTC", true);
    assert.equal(fallback.credentials.provider, "elevenlabs");
    assert.equal(
      (await requireVoiceSession(OTHER, fallback.sessionId)).fallback,
      true,
    );
    await assert.rejects(
      callVoiceTool(USER, fallback.sessionId, "get_contact", {
        contactId: other.id,
      }),
      VoiceUnavailableError,
    );
    await db
      .update(orbitVoiceSessions)
      .set({ toolCalls: VOICE_MAX_TOOL_CALLS })
      .where(eq(orbitVoiceSessions.id, fallback.sessionId));
    await assert.rejects(
      callVoiceTool(OTHER, fallback.sessionId, "get_contact", {
        contactId: other.id,
      }),
      /lookup limit/,
    );
    await db
      .update(orbitVoiceSessions)
      .set({ expiresAt: new Date(0) })
      .where(eq(orbitVoiceSessions.id, fallback.sessionId));
    await assert.rejects(
      requireVoiceSession(OTHER, fallback.sessionId),
      VoiceUnavailableError,
    );
    assert.equal((await voicePublicState()).fallbackProvider, "elevenlabs");
    console.log(
      "ok fallback requires configuration and explicit request; tool and time budgets are enforced",
    );
    // The third allowed start for USER exercises truncation without widening proposal scope.
    const lease = await startVoiceSession(USER, "UTC");
    const read = voiceReadTools().find((t) => t.name === "get_contact")!;
    const originalRun = read.run;
    try {
      read.run = async () => ({
        id: mine.id,
        name: mine.fullName,
        notes: "x".repeat(20000),
      });
      assert.match(
        (
          await callVoiceTool(USER, lease.sessionId, "get_contact", {
            contactId: mine.id,
          })
        ).result,
        /Result too large/,
      );
      assert.equal(
        (
          await callVoiceTool(USER, lease.sessionId, "log_note", {
            contactId: mine.id,
            text: "Must not authorize",
          })
        ).proposal,
        null,
      );
    } finally {
      read.run = originalRun;
    }
    await callVoiceTool(USER, lease.sessionId, "get_contact", {
      contactId: mine.id,
    });
    const pending = await callVoiceTool(USER, lease.sessionId, "log_note", {
      contactId: mine.id,
      text: "Do not commit while off",
    });
    assert.ok(pending.proposal);
    await setVoiceEnabled("test-admin", false);
    const beforeOff = calls;
    await assert.rejects(startVoiceSession(USER, "UTC"), VoiceUnavailableError);
    await assert.rejects(
      callVoiceTool(USER, lease.sessionId, "get_contact", {
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
    assert.equal(calls, beforeOff);
    const [textThread] = await db
      .insert(chatThreads)
      .values({ userId: USER, title: "Text unaffected" })
      .returning();
    fixtureThreads.push(textThread.id);
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
    await endVoiceSession(USER, lease.sessionId);
    await setVoiceEnabled("test-admin", true);
    rejectDeepgram = true;
    await assert.rejects(
      startVoiceSession("voice-failed-start", "UTC"),
      VoiceProviderError,
    );
    assert.equal((await getVoiceSettings()).health.deepgram?.status, "error");
    rejectDeepgram = false;
    onGrant = () => setVoiceEnabled("test-admin", false);
    await assert.rejects(
      startVoiceSession("voice-race", "UTC"),
      VoiceUnavailableError,
    );
    onGrant = undefined;
    assert.ok(isSafeVoiceAgent(ORBIT_VOICE_AGENT_CONFIG));
    unsafeEleven = true;
    await assert.rejects(
      voiceCredentials("elevenlabs", "No CRM", { ...DEFAULT_VOICE_CONFIG }),
      VoiceProviderError,
    );
    assert.equal((await getVoiceSettings()).health.elevenlabs?.status, "error");
    const usage = await voiceUsageSummary();
    assert.ok(usage.some((row) => row.provider === "deepgram"));
    assert.ok(usage.some((row) => row.provider === "elevenlabs"));
    assert.ok(
      (
        await db.query.orbitVoiceSessions.findFirst({
          where: eq(orbitVoiceSessions.userId, "voice-failed-start"),
        })
      )?.outcome === "failed",
    );

    await setVoiceEnabled("test-admin", true);
    await Promise.all([setVoiceEnabled("test-admin", false), setVoiceConfig("test-admin", DEFAULT_VOICE_CONFIG)]);
    assert.equal((await getVoiceSettings()).enabled, false, "concurrent provider save cannot re-enable voice");
    console.log("ok concurrent provider configuration preserves the master disable");
    setDeepgramEnabledForSmoke(false);
    assert.equal((await getVoiceSettings()).providers.deepgram, false);
    console.log(
      "ok disabled state, text independence, preflight race, failed usage and sanitized health for both providers",
    );
  } finally {
    globalThis.fetch = originalFetch;
    const leases = await db.query.orbitVoiceSessions.findMany({
      where: inArray(orbitVoiceSessions.userId, [
        USER,
        OTHER,
        "voice-failed-start",
        "voice-race",
      ]),
    });
    const threads = [
      ...fixtureThreads,
      ...leases.map((lease) => lease.threadId),
    ];
    if (threads.length)
      await db.delete(chatThreads).where(inArray(chatThreads.id, threads));
    if (fixtureContacts.length)
      await db.delete(contacts).where(inArray(contacts.id, fixtureContacts));
    await db
      .update(siteSettings)
      .set({ orbitVoiceEnabled: false, orbitVoiceConfig: DEFAULT_VOICE_CONFIG })
      .where(eq(siteSettings.id, 1));
  }
}
run(main);
