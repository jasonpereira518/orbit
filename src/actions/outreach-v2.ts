"use server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { requireOutreachUser } from "@/lib/plan-guards";
import { getDb, runAtomicWrite } from "@/db";
import {
  outreachConversations,
  outreachProspects,
  outreachMessages,
  contacts,
} from "@/db/schema";
import * as service from "@/lib/outreach-v2/service";
import {
  campaignFor,
  cancelQueued,
  enqueue,
  requireAccess,
} from "@/lib/outreach-v2/store";
import { researchKeys } from "@/lib/outreach-v2/discovery";
import { runOutreachJobs } from "@/lib/outreach-v2/runner";
import {
  promoteContact,
  syncConversation,
} from "@/lib/outreach-v2/conversations";
const uuid = z.string().uuid();
const ids = z.array(uuid).min(1).max(500);
async function user() {
  const id = await requireOutreachUser();
  await requireAccess(id);
  return id;
}
function kick(userId: string, campaignId: string) {
  after(async () => {
    await runOutreachJobs({ userId, campaignId, budgetMs: 240000 });
  });
}
export async function getOutreachSetup() {
  return service.settingsFor(await user());
}
export async function interpretOutreachBrief(
  description: string,
  outcome: string,
) {
  return service.parseBrief(
    await user(),
    z.string().min(10).max(5000).parse(description),
    z.string().min(3).max(1000).parse(outcome),
  );
}
export async function createOutreachCampaign(input: unknown) {
  const u = await user();
  const data = z
    .object({
      name: z.string().max(160),
      brief: service.briefSchema,
      sender: service.senderSchema,
      channel: z.enum(["email", "linkedin"]),
    })
    .parse(input);
  const c = await service.create(u, data);
  revalidatePath("/outreach");
  return c.id;
}
export async function getOutreachWorkspace(id: string) {
  return service.snapshot(await user(), uuid.parse(id));
}
export async function saveOutreachAudience(id: string, brief: unknown) {
  await service.updateBrief(
    await user(),
    uuid.parse(id),
    service.briefSchema.parse(brief),
  );
  revalidatePath(`/outreach/${id}`);
}
export async function searchOutreachPeople(
  id: string,
  funding: "hosted" | "personal",
  limit: number,
) {
  const u = await user();
  uuid.parse(id);
  z.enum(["hosted", "personal"]).parse(funding);
  z.number().int().min(1).max(100).parse(limit);
  await researchKeys(u, funding);
  await enqueue(u, id, "search", `search:${randomUUID()}`, { funding, limit });
  kick(u, id);
}
export async function draftOutreachMessages(
  id: string,
  people: string[],
  instructions: string,
  kind: "initial" | "follow_up" | "reply" = "initial",
) {
  const u = await user();
  await service.queueDrafts(
    u,
    uuid.parse(id),
    ids.parse(people),
    z.string().max(2000).parse(instructions),
    z.enum(["initial", "follow_up", "reply"]).parse(kind),
  );
  kick(u, id);
}
export async function saveOutreachDraft(
  id: string,
  revision: number,
  input: unknown,
) {
  return service.editDraft(
    await user(),
    uuid.parse(id),
    z.number().int().positive().parse(revision),
    z
      .object({
        toAddress: z.string().max(300),
        subject: z.string().max(250),
        body: z.string().max(5000),
        signature: z.string().max(2000),
      })
      .parse(input),
  );
}
export async function approveOutreachDrafts(
  id: string,
  messages: Array<{ id: string; revision: number }>,
  acceptUnverified: boolean,
) {
  const revisions = z
    .array(z.object({ id: uuid, revision: z.number().int().positive() }))
    .min(1)
    .max(500)
    .parse(messages);
  await service.approve(
    await user(),
    uuid.parse(id),
    revisions.map((m) => m.id),
    z.boolean().parse(acceptUnverified),
    Object.fromEntries(revisions.map((m) => [m.id, m.revision])),
  );
}
export async function sendOutreachDrafts(id: string, messages: string[]) {
  const u = await user();
  await service.queueSend(u, uuid.parse(id), ids.parse(messages));
  kick(u, id);
}
export async function pauseOutreachCampaign(id: string, paused: boolean) {
  const u = await user();
  await service.setPaused(u, uuid.parse(id), z.boolean().parse(paused));
  if (!paused) kick(u, id);
}
export async function cancelOutreachQueue(id: string) {
  await cancelQueued(await user(), uuid.parse(id));
}
export async function updateOutreachPeople(
  id: string,
  people: string[],
  status: "selected" | "suggested" | "skipped",
) {
  const u = await user();
  await campaignFor(u, uuid.parse(id));
  ids.parse(people);
  z.enum(["selected", "suggested", "skipped"]).parse(status);
  const db = await getDb();
  for (const p of people)
    await db
      .update(outreachProspects)
      .set({ status })
      .where(
        and(eq(outreachProspects.campaignId, id), eq(outreachProspects.id, p)),
      );
}
export async function saveOutreachPerson(id: string) {
  const contactId = await promoteContact(await user(), uuid.parse(id));
  if (!contactId)
    throw new Error(
      "This person's identity is ambiguous. Resolve the matching contacts in Contacts → Duplicates before saving.",
    );
  return contactId;
}
export async function updateOutreachConversation(id: string, input: unknown) {
  const u = await user();
  uuid.parse(id);
  const patch = z
    .object({
      unread: z.boolean().optional(),
      closed: z.boolean().optional(),
      url: z.string().url().max(2000).optional(),
      outcome: z
        .enum([
          "positive_reply",
          "negative_reply",
          "neutral_reply",
          "unsubscribed",
          "bounced",
        ])
        .optional(),
    })
    .parse(input);
  const db = await getDb();
  const conversation = await db.query.outreachConversations.findFirst({
    where: and(
      eq(outreachConversations.id, id),
      eq(outreachConversations.userId, u),
    ),
  });
  if (!conversation) throw new Error("Conversation not found.");
  if (patch.url) {
    const campaign = await campaignFor(u, conversation.campaignId),
      url = new URL(patch.url);
    const hosts =
      campaign.sender?.transport === "linkedin"
        ? ["www.linkedin.com"]
        : campaign.sender?.transport === "gmail_web"
          ? ["mail.google.com"]
          : campaign.sender?.transport === "outlook_web"
            ? [
                "outlook.live.com",
                "outlook.office.com",
                "outlook.office365.com",
              ]
            : [];
    if (url.protocol !== "https:" || !hosts.includes(url.hostname))
      throw new Error("Use the conversation link from the selected provider.");
  }
  await runAtomicWrite(db, (w) => [
    ...(patch.outcome
      ? [
          w
            .update(outreachMessages)
            .set({ outcome: patch.outcome })
            .where(
              and(
                eq(outreachMessages.prospectId, conversation.prospectId),
                eq(outreachMessages.executionStatus, "confirmed"),
              ),
            ),
        ]
      : []),
    w
      .update(outreachConversations)
      .set({
        ...patch,
        ...(patch.outcome === "unsubscribed"
          ? { optedOut: true, closed: true }
          : {}),
      })
      .where(
        and(
          eq(outreachConversations.id, id),
          eq(outreachConversations.userId, u),
        ),
      ),
  ]);
}
export async function resolveOutreachIdentity(
  prospectId: string,
  contactId: string | null,
) {
  const u = await user(),
    db = await getDb();
  const p = await db.query.outreachProspects.findFirst({
    where: eq(outreachProspects.id, uuid.parse(prospectId)),
  });
  if (!p?.research) throw new Error("Person not found.");
  await campaignFor(u, p.campaignId);
  if (contactId) {
    if (
      !(await db.query.contacts.findFirst({
        where: and(
          eq(contacts.id, uuid.parse(contactId)),
          eq(contacts.userId, u),
        ),
      }))
    )
      throw new Error("Contact not found.");
  } else {
    const { identityKeys } = await import("@/lib/outreach-v2/policy");
    const known = await db.query.contacts.findMany({
      where: eq(contacts.userId, u),
    });
    if (
      known.some((k) =>
        identityKeys(k).some((i) => p.research!.identities.includes(i)),
      )
    )
      throw new Error(
        "An existing contact holds this profile or email. Select that contact or correct the identity before saving separately.",
      );
  }
  await db
    .update(outreachProspects)
    .set({ contactId, research: { ...p.research, ambiguous: false } })
    .where(eq(outreachProspects.id, p.id));
  if (contactId) await promoteContact(u, p.id);
}
export async function refreshOutreachConversations(id: string) {
  const u = await user();
  await campaignFor(u, uuid.parse(id));
  const db = await getDb();
  const conversations = await db.query.outreachConversations.findMany({
    where: and(
      eq(outreachConversations.campaignId, id),
      eq(outreachConversations.userId, u),
    ),
  });
  after(async () => {
    const deadline = Date.now() + 210000;
    for (
      let i = 0;
      i < conversations.length && Date.now() < deadline - 30000;
      i += 4
    )
      await Promise.all(
        conversations.slice(i, i + 4).map((c) => syncConversation(u, c.id)),
      );
  });
}
export async function saveOutreachSearchKey(key: string) {
  await service.saveResearchKey(await user(), z.string().max(500).parse(key));
}
export async function upgradeOutreachCampaign(
  id: string,
  sender: unknown,
  brief: unknown,
) {
  await service.upgradeLegacy(
    await user(),
    uuid.parse(id),
    service.senderSchema.parse(sender),
    service.briefSchema.parse(brief),
  );
  revalidatePath(`/outreach/${id}`);
}
export async function verifyOutreachSend(id: string) {
  return (await import("@/lib/outreach-v2/reconcile")).reconcileSend(
    await user(),
    uuid.parse(id),
  );
}
export async function resolveBrowserSend(id: string, sent: boolean) {
  return (await import("@/lib/outreach-v2/reconcile")).reconcileSend(
    await user(),
    uuid.parse(id),
    z.boolean().parse(sent),
  );
}
