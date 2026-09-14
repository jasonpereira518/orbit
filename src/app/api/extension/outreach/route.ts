import { z } from "zod";
import { extensionRoute, preflight } from "@/lib/extension/http";
import * as browser from "@/lib/outreach-v2/browser";
const id = z.string().uuid();
const request = z.discriminatedUnion("op", [
  z.object({ op: z.literal("campaigns") }),
  z.object({
    op: z.literal("start"),
    campaignId: id,
    account: z.string().min(3).max(300),
  }),
  z.object({ op: z.literal("stop"), sessionId: id }),
  z.object({ op: z.literal("next"), sessionId: id }),
  z.object({ op: z.literal("conversations"), sessionId: id }),
  z.object({
    op: z.literal("checkpoint"),
    sessionId: id,
    jobId: id,
    token: id,
    checkpoint: z.object({
      phase: z.enum([
        "prepared",
        "clicked",
        "confirmed",
        "failed",
        "needs_verification",
      ]),
      sender: z.string().max(300),
      recipient: z.string().max(300),
      subject: z.string().max(250),
      body: z.string().max(8000),
      evidence: z.string().max(2000).optional(),
      conversationUrl: z.string().url().max(2000).optional(),
    }),
  }),
  z.object({
    op: z.literal("observe"),
    sessionId: id,
    conversationId: id,
    account: z.string().max(300),
    personUrl: z.string().max(2000),
    observations: z
      .array(
        z.object({
          externalId: z.string().max(300),
          direction: z.enum(["inbound", "outbound"]),
          body: z.string().max(15000),
          subject: z.string().max(250).optional(),
          sentAt: z.string().datetime(),
          kind: z.enum(["human", "automatic", "bounce", "accepted"]),
          conversationUrl: z.string().url(),
        }),
      )
      .max(30),
  }),
  z.object({
    op: z.literal("locate"),
    sessionId: id,
    image: z.string().max(200000),
    target: z.enum([
      "Compose button",
      "Add a note button",
      "Connection request button",
      "Message button",
    ]),
  }),
]);
export const POST = extensionRoute({
  schema: request,
  handler: async ({ userId, input: body }) => {
    switch (body.op) {
      case "campaigns":
        return browser.browserCampaigns(userId);
      case "start":
        return browser.startSession(userId, body.campaignId, body.account);
      case "stop":
        return browser.stopSession(userId, body.sessionId);
      case "next":
        return browser.nextBrowserTask(userId, body.sessionId);
      case "conversations":
        return browser.browserConversations(userId, body.sessionId);
      case "checkpoint":
        return browser.checkpoint(
          userId,
          body.sessionId,
          body.jobId,
          body.token,
          body.checkpoint,
        );
      case "observe":
        return browser.observeConversation(
          userId,
          body.sessionId,
          body.conversationId,
          body.account,
          body.personUrl,
          body.observations,
        );
      case "locate":
        return browser.visualRecovery(
          userId,
          body.sessionId,
          body.image,
          body.target,
        );
    }
  },
});
export const OPTIONS = preflight;
