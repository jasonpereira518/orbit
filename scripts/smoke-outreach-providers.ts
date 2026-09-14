import "./smoke/_env";
import { run } from "./smoke/_env";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import {
  userSettings,
  contacts,
  gmailConnections,
  outlookConnections,
  outreachCampaigns,
  outreachProspects,
  outreachMessages,
  outreachConversations,
} from "../src/db/schema";
import { encrypt } from "../src/lib/crypto";
import { claimJob, enqueue } from "../src/lib/outreach-v2/store";
import { sendConnected } from "../src/lib/outreach-v2/mail";
import {
  recordSent,
  syncConversation,
} from "../src/lib/outreach-v2/conversations";
import {
  BraveSearch,
  ApolloEnrichment,
} from "../src/lib/outreach-v2/discovery";
import type { Candidate, Sender } from "../src/lib/outreach-v2/types";
run(async () => {
  process.env.OUTREACH_V2_ENABLED = "1";
  const db = await getDb(),
    userId = "outreach-provider-smoke";
  await db.insert(userSettings).values({ userId, compedPlan: "orbit" });
  const token = encrypt("fake-test-token");
  await db.insert(gmailConnections).values({
    userId,
    emailAddress: "alex@example.test",
    accessTokenEncrypted: token,
    tokenExpiresAt: new Date(Date.now() + 3600000),
    scopes:
      "https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly",
    status: "active",
  });
  await db.insert(outlookConnections).values({
    userId,
    emailAddress: "alex@example.test",
    accessTokenEncrypted: token,
    tokenExpiresAt: new Date(Date.now() + 3600000),
    scopes: "Mail.Send Mail.ReadWrite",
    status: "active",
  });
  const [contact] = await db
    .insert(contacts)
    .values({ userId, fullName: "Taylor", email: "taylor@example.test" })
    .returning();
  async function make(transport: "gmail" | "outlook") {
    const sender: Sender = {
      transport,
      address: "alex@example.test",
      introduction: "Alex",
      signature: "Alex",
      invitationLimit: 200,
    };
    const [c] = await db
      .insert(outreachCampaigns)
      .values({
        userId,
        name: transport,
        version: 2,
        sender,
        defaultChannel: "email",
      })
      .returning();
    const [p] = await db
      .insert(outreachProspects)
      .values({
        campaignId: c.id,
        externalId: transport,
        fullName: "Taylor",
        email: "taylor@example.test",
        contactId: contact.id,
      })
      .returning();
    const [m] = await db
      .insert(outreachMessages)
      .values({
        prospectId: p.id,
        channel: "email",
        subject: "A conversation",
        body: "Hi Taylor",
        signature: "Alex",
        toAddress: p.email,
        senderSnapshot: sender,
        approvedRevision: 1,
        executionStatus: "queued",
      })
      .returning();
    await enqueue(userId, c.id, "send", `send:${m.id}:1`, { messageId: m.id });
    return { c, p, m, job: (await claimJob(["send"], userId, c.id))! };
  }
  const google = await make("gmail");
  let sentRaw = "",
    historyReset = false;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/messages/send")) {
      sentRaw = Buffer.from(
        JSON.parse(String(init?.body)).raw,
        "base64url",
      ).toString("utf8");
      return Response.json({ id: "g-send", threadId: "g-thread" });
    }
    if (url.includes("/history?")) {
      historyReset = true;
      return new Response("expired", { status: 404 });
    }
    if (url.includes("/threads/g-thread"))
      return Response.json({
        historyId: "20",
        messages: [
          {
            id: "g-reply",
            threadId: "g-thread",
            internalDate: String(Date.now()),
            payload: {
              mimeType: "text/plain",
              headers: [
                { name: "From", value: "Taylor <taylor@example.test>" },
                { name: "Subject", value: "Re: A conversation" },
                { name: "Message-ID", value: "<reply@example.test>" },
              ],
              body: {
                data: Buffer.from("Happy to chat").toString("base64url"),
              },
            },
          },
        ],
      });
    throw new Error(`Unexpected provider request: ${url}`);
  };
  const sent = await sendConnected(google.job);
  assert.equal(sent.status, "confirmed");
  assert.ok(sentRaw.endsWith("Hi Taylor\n\nAlex"));
  assert.ok(
    sentRaw.includes(`Message-ID: <orbit-${google.m.id}-1@outreach.orbit>`),
  );
  assert.ok(!sentRaw.includes("remove you"));
  await recordSent(userId, google.m.id, sent);
  let conversation = (await db.query.outreachConversations.findFirst({
    where: eq(outreachConversations.prospectId, google.p.id),
  }))!;
  await db
    .update(outreachConversations)
    .set({ cursor: { historyId: "expired" } })
    .where(eq(outreachConversations.id, conversation.id));
  await syncConversation(userId, conversation.id);
  assert.equal(historyReset, true);
  conversation = (await db.query.outreachConversations.findFirst({
    where: eq(outreachConversations.id, conversation.id),
  }))!;
  assert.ok(conversation.lastHumanReplyAt);
  assert.equal(conversation.cursor?.historyId, "20");
  console.log(
    "ok: Gmail exact content, stable message ID, expired history recovery, threaded reply ingestion",
  );
  const microsoft = await make("outlook");
  let graphDraft: Record<string, unknown> = {};
  let submitted = false;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/messages") && init?.method === "POST") {
      graphDraft = JSON.parse(String(init.body));
      return Response.json({
        id: "o-send",
        conversationId: "o-thread",
        webLink: "https://outlook.office.com/mail/id/o-thread",
      });
    }
    if (url.endsWith("/messages/o-send/send")) {
      submitted = true;
      return new Response(null, { status: 202 });
    }
    if (url.includes("messages/delta"))
      return Response.json({
        value: [],
        "@odata.deltaLink":
          "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?token=next",
      });
    if (url.includes("/messages/o-send?"))
      return Response.json({
        id: "o-send",
        conversationId: "o-thread",
        isDraft: false,
        webLink: "https://outlook.office.com/mail/id/o-thread",
      });
    throw new Error(`Unexpected provider request: ${url}`);
  };
  const accepted = await sendConnected(microsoft.job);
  assert.equal(accepted.status, "accepted");
  assert.equal(submitted, true);
  assert.deepEqual(graphDraft.body, {
    contentType: "Text",
    content: "Hi Taylor\n\nAlex",
  });
  await recordSent(userId, microsoft.m.id, accepted);
  assert.equal(
    (
      await db.query.outreachMessages.findFirst({
        where: eq(outreachMessages.id, microsoft.m.id),
      })
    )?.sentAt,
    null,
  );
  const conv = (await db.query.outreachConversations.findFirst({
    where: eq(outreachConversations.prospectId, microsoft.p.id),
  }))!;
  await syncConversation(userId, conv.id);
  assert.equal(
    (
      await db.query.outreachMessages.findFirst({
        where: eq(outreachMessages.id, microsoft.m.id),
      })
    )?.executionStatus,
    "confirmed",
  );
  console.log(
    "ok: Outlook immutable draft, exact content, accepted distinct from confirmed, sent-folder confirmation",
  );
  globalThis.fetch = async (input) =>
    String(input).includes("search.brave.com")
      ? Response.json({
          web: {
            results: [
              {
                url: "https://www.linkedin.com/in/taylor",
                title: "Taylor",
                description: "Product designer",
              },
            ],
          },
        })
      : Response.json({
          person: {
            name: "Someone else",
            linkedin_url: "https://www.linkedin.com/in/other",
          },
        });
  assert.equal(
    (await new BraveSearch("test-key").search("designer")).length,
    1,
  );
  const candidate: Candidate = {
    fullName: "Taylor",
    title: null,
    company: null,
    location: null,
    email: null,
    linkedinUrl: "https://www.linkedin.com/in/taylor",
    externalId: "test",
    research: {
      identities: [],
      evidence: [],
      score: 0,
      reasons: [],
      confidence: "low",
      emailStatus: "unknown",
      eligibility: "uncertain",
    },
  };
  await assert.rejects(
    () => new ApolloEnrichment("test-key").enrich(candidate),
    /different profile|Identity needs review/,
  );
  console.log(
    "ok: search source preservation and conflicting enrichment identity rejection",
  );
});
