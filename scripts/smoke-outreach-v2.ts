import "./smoke/_env";
import { run } from "./smoke/_env";
import assert from "node:assert/strict";
import { and, eq, sql } from "drizzle-orm";
import { getDb, reconcileSchema, SCHEMA_VERSION } from "../src/db";
import {
  userSettings,
  outreachCampaigns,
  outreachProspects,
  outreachMessages,
  outreachJobs,
  outreachCreditLedger,
  outreachConversations,
  outreachConversationMessages,
  gmailConnections,
  contacts,
  interactions,
} from "../src/db/schema";
import {
  allowance,
  campaignFor,
  claimJob,
  enqueue,
  reserveResearch,
  releaseResearch,
  consumeResearch,
} from "../src/lib/outreach-v2/store";
import {
  approve,
  editDraft,
  queueSend,
  upgradeLegacy,
} from "../src/lib/outreach-v2/service";
import {
  startSession,
  nextBrowserTask,
  checkpoint,
} from "../src/lib/outreach-v2/browser";
import { reconcileSend } from "../src/lib/outreach-v2/reconcile";
import { reserveSendDay } from "../src/lib/outreach-v2/mail";
import {
  ensureConversation,
  ingestMessage,
  classifyMail,
} from "../src/lib/outreach-v2/conversations";
import {
  fullBody,
  fundingWindow,
  identityKeys,
  rankCandidate,
  followUpDue,
  validateDraft,
} from "../src/lib/outreach-v2/policy";
import type { Candidate, Sender, Brief } from "../src/lib/outreach-v2/types";

run(async () => {
  process.env.OUTREACH_V2_ENABLED = "1";
  process.env.OUTREACH_PRO_CREDITS = "2";
  // This suite never needs network access. An unexpected provider call is a test failure.
  globalThis.fetch = async () => {
    throw new Error("Unexpected network call in Outreach tests");
  };
  const db = await getDb(),
    userId = "outreach-v2-smoke",
    other = "outreach-v2-other";
  for (const [table, columns] of Object.entries({
    user_settings: ["brave_api_key_encrypted", "outreach_sender_defaults"],
    outreach_campaigns: ["version", "brief", "sender", "paused"],
    outreach_prospects: ["research"],
    outreach_messages: [
      "revision",
      "approved_revision",
      "signature",
      "to_address",
      "sender_snapshot",
      "execution_status",
      "message_kind",
      "provider_thread_id",
    ],
  }))
    for (const column of columns)
      await db.execute(
        sql.raw(`ALTER TABLE ${table} DROP COLUMN ${column} CASCADE`),
      );
  await db.execute(
    sql`UPDATE schema_migrations SET version=${SCHEMA_VERSION - 1}`,
  );
  const migration = await reconcileSchema();
  assert.equal(migration.applied, true);
  assert.deepEqual(migration.failed, []);
  console.log(
    "ok: upgrading a database without v34 columns restores columns and identity indexes",
  );
  await db
    .insert(userSettings)
    .values([
      { userId, compedPlan: "orbit" },
      { userId: other, compedPlan: "lifetime" },
    ])
    .onConflictDoNothing();
  const sender: Sender = {
    transport: "gmail",
    address: "sender@example.test",
    introduction: "Designer",
    signature: "Alex\nDesigner",
    invitationLimit: 200,
  };
  const brief: Brief = {
    description: "Meet product designers in New York",
    outcome: "Ask for an introduction",
    criteria: [
      { field: "title", value: "designer", importance: "required" },
      { field: "location", value: "New York", importance: "preferred" },
    ],
    confirmed: true,
    batchInstructions: "",
  };
  const candidate: Candidate = {
    fullName: "Taylor Example",
    title: "Product designer",
    company: "Climate",
    location: null,
    email: "taylor@example.test",
    linkedinUrl: "https://www.linkedin.com/in/Taylor/?trk=x",
    externalId: "apollo:1",
    research: {
      identities: [],
      evidence: [
        {
          url: "https://example.test/taylor",
          title: "Taylor Example",
          excerpt: "Product designer",
          fetchedAt: new Date().toISOString(),
        },
      ],
      score: 0,
      reasons: [],
      confidence: "low",
      emailStatus: "verified",
      eligibility: "uncertain",
    },
  };
  assert.deepEqual(identityKeys(candidate).slice(0, 2), [
    "linkedin:https://www.linkedin.com/in/taylor",
    "email:taylor@example.test",
  ]);
  assert.equal(rankCandidate(candidate, brief).eligibility, "uncertain");
  assert.equal(rankCandidate(candidate, brief).score, 75);
  assert.equal(
    rankCandidate({ ...candidate, title: "Accountant" }, brief).eligibility,
    "mismatch",
  );
  assert.equal(fullBody("Hello", "Alex", "email"), "Hello\n\nAlex");
  assert.equal(fundingWindow("lifetime"), "lifetime");
  assert.ok(
    validateDraft({
      channel: "linkedin",
      to: candidate.linkedinUrl!,
      subject: "",
      body: "a".repeat(201),
      signature: "",
      sender,
    }).length,
  );
  assert.equal(
    followUpDue({
      channel: "linkedin",
      sentAt: new Date(0),
      acceptedAt: null,
      lastHumanReplyAt: null,
      closed: false,
      optedOut: false,
    }),
    false,
  );
  assert.equal(
    followUpDue({
      channel: "email",
      sentAt: new Date(0),
      acceptedAt: null,
      lastHumanReplyAt: new Date(),
      closed: false,
      optedOut: false,
    }),
    false,
  );
  console.log(
    "ok: ranking, missing facts, identities, exact signatures, invitation limits, follow-ups",
  );
  const reservations = await Promise.all([
    reserveResearch(userId, "person-a", "hosted"),
    reserveResearch(userId, "person-a", "hosted"),
    reserveResearch(userId, "person-b", "hosted"),
  ]);
  assert.ok(reservations.every(Boolean));
  assert.equal((await allowance(userId)).used, 2);
  assert.equal(await reserveResearch(userId, "person-c", "hosted"), false);
  await releaseResearch(userId, ["person-b"]);
  assert.equal((await allowance(userId)).used, 1);
  await consumeResearch(userId, "person-a", 1);
  await releaseResearch(userId, ["person-a"]);
  assert.equal((await allowance(userId)).used, 1);
  assert.ok(await reserveResearch(userId, "personal", "personal"));
  assert.equal((await allowance(userId)).used, 1);
  assert.equal((await allowance(other)).limit, 100);
  console.log(
    "ok: atomic credit reservation, duplicate attempts, exhausted allowance, release, personal funding",
  );
  const [campaign] = await db
    .insert(outreachCampaigns)
    .values({
      userId,
      name: "Test campaign",
      version: 2,
      brief,
      sender,
      defaultChannel: "email",
    })
    .returning();
  const [contact] = await db
    .insert(contacts)
    .values({ userId, fullName: candidate.fullName, email: candidate.email })
    .returning();
  const [person] = await db
    .insert(outreachProspects)
    .values({
      campaignId: campaign.id,
      externalId: candidate.externalId,
      fullName: candidate.fullName,
      email: candidate.email,
      research: candidate.research,
      contactId: contact.id,
    })
    .returning();
  await db.insert(gmailConnections).values({
    userId,
    emailAddress: sender.address,
    accessTokenEncrypted: "unused",
    scopes: "https://www.googleapis.com/auth/gmail.send",
    status: "active",
  });
  const [message] = await db
    .insert(outreachMessages)
    .values({
      prospectId: person.id,
      channel: "email",
      subject: "Hello",
      body: "A personal introduction",
      signature: sender.signature,
      toAddress: candidate.email,
      senderSnapshot: sender,
    })
    .returning();
  await assert.rejects(() => campaignFor(other, campaign.id), /not found/);
  await approve(userId, campaign.id, [message.id], false);
  await editDraft(userId, message.id, 1, {
    toAddress: candidate.email!,
    subject: "Hello",
    body: "Changed introduction",
    signature: sender.signature,
  });
  const fresh = await db.query.outreachMessages.findFirst({
    where: eq(outreachMessages.id, message.id),
  });
  assert.equal(fresh?.approvedRevision, null);
  assert.equal(fresh?.revision, 2);
  await assert.rejects(
    () =>
      editDraft(userId, message.id, 1, {
        toAddress: candidate.email!,
        subject: "Stale",
        body: "Overwrite",
        signature: "",
      }),
    /changed/,
  );
  await assert.rejects(
    () => queueSend(userId, campaign.id, [message.id]),
    /approve/,
  );
  assert.equal(
    (
      await db.query.outreachJobs.findMany({
        where: eq(outreachJobs.campaignId, campaign.id),
      })
    ).length,
    0,
  );
  await approve(userId, campaign.id, [message.id], false);
  await Promise.all([
    queueSend(userId, campaign.id, [message.id]),
    queueSend(userId, campaign.id, [message.id]),
  ]);
  assert.equal(
    (
      await db.query.outreachJobs.findMany({
        where: eq(outreachJobs.campaignId, campaign.id),
      })
    ).length,
    1,
  );
  const claimed = await Promise.all([
    claimJob(["send"], userId, campaign.id),
    claimJob(["send"], userId, campaign.id),
  ]);
  assert.equal(claimed.filter(Boolean).length, 1);
  await assert.rejects(
    () =>
      editDraft(userId, message.id, 2, {
        toAddress: candidate.email!,
        subject: "No",
        body: "Overwrite queued",
        signature: "",
      }),
    /queued/,
  );
  const job = claimed.find(Boolean)!;
  await db
    .update(outreachJobs)
    .set({ leaseUntil: new Date(0) })
    .where(eq(outreachJobs.id, job.id));
  assert.equal(await claimJob(["send"], userId, campaign.id), undefined);
  assert.equal(
    (
      await db.query.outreachJobs.findFirst({
        where: eq(outreachJobs.id, job.id),
      })
    )?.status,
    "needs_verification",
  );
  console.log(
    "ok: tenant isolation, revision approval, stale edit rejection, queue deduplication, leased send recovery",
  );
  await db
    .update(outreachCampaigns)
    .set({ paused: true })
    .where(eq(outreachCampaigns.id, campaign.id));
  await enqueue(userId, campaign.id, "draft", "paused-draft", {
    prospectId: person.id,
  });
  assert.equal(await claimJob(["draft"], userId, campaign.id), undefined);
  const daily = await Promise.all(
    Array.from({ length: 55 }, () => reserveSendDay(userId)),
  );
  assert.equal(daily.filter(Boolean).length, 50);
  const conversation = await ensureConversation(
    userId,
    campaign.id,
    person.id,
    "thread-1",
  );
  const entry = {
    externalId: "reply-1",
    direction: "inbound" as const,
    kind: "human" as const,
    body: "Happy to chat next week",
    sentAt: new Date(),
  };
  await ingestMessage(userId, conversation.id, entry);
  await ingestMessage(userId, conversation.id, entry);
  assert.equal(
    (await db.query.outreachConversationMessages.findMany()).length,
    1,
  );
  assert.equal(
    (
      await db.query.interactions.findMany({
        where: eq(interactions.contactId, contact.id),
      })
    ).length,
    1,
  );
  assert.ok(
    (
      await db.query.outreachConversations.findFirst({
        where: eq(
          (await import("../src/db/schema")).outreachConversations.id,
          conversation.id,
        ),
      })
    )?.lastHumanReplyAt,
  );
  assert.equal(
    classifyMail({ "auto-submitted": "auto-replied" }, "Hi"),
    "automatic",
  );
  assert.equal(
    classifyMail({ from: "mailer-daemon@example.test" }, "Failure"),
    "bounce",
  );
  await assert.rejects(
    () => ingestMessage(other, conversation.id, entry),
    /not found/,
  );
  console.log(
    "ok: pause, 50-email concurrency ceiling, idempotent reply/contact timeline, automatic reply/bounce separation",
  );
  assert.equal(
    (
      await db.query.outreachCreditLedger.findMany({
        where: and(
          eq(outreachCreditLedger.userId, userId),
          eq(outreachCreditLedger.key, "person-a"),
        ),
      })
    ).length,
    1,
  );
  const browserSender: Sender = {
    ...sender,
    transport: "linkedin",
    address: "https://www.linkedin.com/in/sender",
  };
  const [browserCampaign] = await db
    .insert(outreachCampaigns)
    .values({
      userId,
      version: 2,
      name: "Browser fixture",
      defaultChannel: "linkedin",
      sender: browserSender,
      brief,
    })
    .returning();
  const [browserPerson] = await db
    .insert(outreachProspects)
    .values({
      campaignId: browserCampaign.id,
      externalId: "browser-person",
      fullName: "Browser Person",
      linkedinUrl: "https://www.linkedin.com/in/browser-person",
    })
    .returning();
  const [browserMessage] = await db
    .insert(outreachMessages)
    .values({
      prospectId: browserPerson.id,
      channel: "linkedin",
      body: "A reviewed invitation",
      toAddress: browserPerson.linkedinUrl,
      senderSnapshot: browserSender,
    })
    .returning();
  await approve(userId, browserCampaign.id, [browserMessage.id], false);
  await queueSend(userId, browserCampaign.id, [browserMessage.id]);
  await assert.rejects(
    () => startSession(userId, browserCampaign.id, "wrong-account"),
    /match/,
  );
  const session = await startSession(
    userId,
    browserCampaign.id,
    browserSender.address,
  );
  const task = (await nextBrowserTask(userId, session.id))!;
  assert.ok(task);
  const exact = {
    sender: browserSender.address,
    recipient: task.recipient,
    subject: task.subject,
    body: task.body,
  };
  await assert.rejects(
    () =>
      checkpoint(other, session.id, task.jobId, task.leaseToken, {
        ...exact,
        phase: "prepared",
      }),
    /session/,
  );
  await assert.rejects(
    () =>
      checkpoint(userId, session.id, task.jobId, task.leaseToken, {
        ...exact,
        body: "injected content",
        phase: "prepared",
      }),
    /does not match/,
  );
  await assert.rejects(
    () =>
      checkpoint(userId, session.id, task.jobId, task.leaseToken, {
        ...exact,
        phase: "clicked",
      }),
    /not prepared/,
  );
  await checkpoint(userId, session.id, task.jobId, task.leaseToken, {
    ...exact,
    phase: "prepared",
  });
  await db
    .update(outreachCampaigns)
    .set({ paused: true })
    .where(eq(outreachCampaigns.id, browserCampaign.id));
  await assert.rejects(
    () =>
      checkpoint(userId, session.id, task.jobId, task.leaseToken, {
        ...exact,
        phase: "clicked",
      }),
    /paused/,
  );
  await db
    .update(outreachCampaigns)
    .set({ paused: false })
    .where(eq(outreachCampaigns.id, browserCampaign.id));
  await checkpoint(userId, session.id, task.jobId, task.leaseToken, {
    ...exact,
    phase: "clicked",
  });
  await assert.rejects(
    () =>
      checkpoint(userId, session.id, task.jobId, task.leaseToken, {
        ...exact,
        phase: "clicked",
      }),
    /not prepared/,
  );
  await checkpoint(userId, session.id, task.jobId, task.leaseToken, {
    ...exact,
    phase: "failed",
    evidence: "Browser closed after send",
  });
  assert.equal(
    (
      await db.query.outreachJobs.findFirst({
        where: eq(outreachJobs.id, task.jobId),
      })
    )?.status,
    "needs_verification",
  );
  assert.equal(await nextBrowserTask(userId, session.id), null);
  await reconcileSend(userId, task.jobId, false);
  await assert.rejects(
    () => queueSend(userId, browserCampaign.id, [browserMessage.id]),
    /approve/,
  );
  console.log(
    "ok: browser account, tenant and content boundaries, pause, click checkpoint, crash reconciliation, fresh approval",
  );
  const acceptedConversation = await ensureConversation(
    userId,
    browserCampaign.id,
    browserPerson.id,
  );
  const acceptedEntry = {
    externalId: "accepted-connection",
    direction: "inbound" as const,
    kind: "accepted" as const,
    body: "Connection accepted",
    sentAt: new Date(),
  };
  await Promise.all([
    ingestMessage(userId, acceptedConversation.id, acceptedEntry),
    ingestMessage(userId, acceptedConversation.id, acceptedEntry),
  ]);
  assert.equal(
    (
      await db.query.contacts.findMany({
        where: and(
          eq(contacts.userId, userId),
          eq(contacts.linkedinUrl, browserPerson.linkedinUrl!),
        ),
      })
    ).length,
    1,
  );
  assert.ok(
    (
      await db.query.outreachProspects.findFirst({
        where: eq(outreachProspects.id, browserPerson.id),
      })
    )?.contactId,
  );

  await db
    .update(outreachConversations)
    .set({ unread: false, outcome: "negative_reply" })
    .where(eq(outreachConversations.id, conversation.id));
  await ingestMessage(userId, conversation.id, entry);
  const replayed = (await db.query.outreachConversations.findFirst({
    where: eq(outreachConversations.id, conversation.id),
  }))!;
  assert.equal(replayed.unread, false);
  assert.equal(replayed.outcome, "negative_reply");
  await db
    .update(outreachConversations)
    .set({ unread: true })
    .where(eq(outreachConversations.id, conversation.id));
  await ingestMessage(userId, conversation.id, {
    ...entry,
    externalId: "automatic-later",
    kind: "automatic",
    body: "Automatic reply",
  });
  assert.equal(
    (
      await db.query.outreachConversations.findFirst({
        where: eq(outreachConversations.id, conversation.id),
      })
    )?.unread,
    true,
  );

  const [legacy] = await db
    .insert(outreachCampaigns)
    .values({ userId, name: "Legacy history", defaultChannel: "email" })
    .returning();
  const [legacyPerson] = await db
    .insert(outreachProspects)
    .values({
      campaignId: legacy.id,
      externalId: "legacy",
      fullName: "Legacy Person",
      email: "legacy@example.test",
    })
    .returning();
  const [historical] = await db
    .insert(outreachMessages)
    .values({
      prospectId: legacyPerson.id,
      channel: "email",
      body: "Historical content",
      status: "sent",
      sentAt: new Date(),
    })
    .returning();
  const [scheduled] = await db
    .insert(outreachMessages)
    .values({
      prospectId: legacyPerson.id,
      channel: "email",
      body: "Scheduled suggestion",
      status: "scheduled",
      stepIndex: 1,
      scheduledFor: new Date(),
    })
    .returning();
  await upgradeLegacy(userId, legacy.id, sender, brief);
  assert.equal(
    (
      await db.query.outreachMessages.findFirst({
        where: eq(outreachMessages.id, historical.id),
      })
    )?.body,
    "Historical content",
  );
  const migrated = (await db.query.outreachMessages.findFirst({
    where: eq(outreachMessages.id, scheduled.id),
  }))!;
  assert.equal(migrated.status, "generated");
  assert.equal(migrated.approvedRevision, null);
  assert.equal(migrated.messageKind, "follow_up");
  assert.equal(migrated.signature, sender.signature);
  assert.ok(
    await db.query.outreachConversationMessages.findFirst({
      where: eq(
        outreachConversationMessages.externalId,
        `legacy:${historical.id}`,
      ),
    }),
  );
  console.log(
    "ok: replay preserves manual review and unread replies; legacy history and scheduled suggestions migrate",
  );
  await db.execute(sql`DELETE FROM user_settings WHERE user_id='nobody'`);
  console.log("Outreach v2 smoke checks passed.");
});
