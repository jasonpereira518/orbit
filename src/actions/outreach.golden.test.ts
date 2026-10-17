import "../../scripts/smoke/_env";

// The outreach actions authenticate with `requireOutreachUser()` -> `requireUserId()`. With no
// Clerk keys on a non-production localhost that resolves to the shared "demo-user" (the same
// route scripts/smoke-batched-writes.ts takes), so the state machine is reachable without a
// session. `scheduleNextFollowUpIfNeeded` is module-private; it is exercised through its two
// callers, `markMessageAction` ("opened") and (not covered here) `sendOutreachMessageNow`.
delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
delete process.env.CLERK_SECRET_KEY;
delete process.env.RESEND_API_KEY;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.APOLLO_API_KEY;
process.env.ORBIT_DEMO_DATA = "off";
(process.env as Record<string, string>).NODE_ENV = "development";

import { after, before, describe, it, mock } from "node:test";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { outreachCampaigns, outreachMessages, outreachProspects, userSettings } from "@/db/schema";
import { encrypt } from "@/lib/crypto";
import { ensureUserSettings } from "@/lib/user-settings";
import { setSurfaceComingSoon } from "@/lib/surface-visibility";
import { generateDueFollowUps, logMessageOutcome, markMessageAction } from "@/actions/outreach";
import { daysAhead, expectGolden, freezeClock, sortBy } from "@/test-support/golden";
import { fixedId } from "@/test-support/fixtures";

const USER = "demo-user";

/** Never reaches a provider: the one OpenAI call shape the drafter makes is answered locally. */
const realFetch = globalThis.fetch;
const prompts: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (/api\.openai\.com/.test(url)) {
    const raw = init?.body ?? (input instanceof Request ? await input.clone().text() : "");
    const text = typeof raw === "string" ? raw : "";
    prompts.push(text);
    const who = ["Ann Opened", "Ben Positive", "Cat Replied", "Dan Dup"].find((n) => text.includes(n)) ?? "someone";
    return Response.json({
      id: "c1", object: "chat.completion", created: 0, model: "gpt-4o-mini",
      choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ subject: `Subject for ${who}`, body: `Body for ${who}` }) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
  }
  return realFetch(input, init);
}) as typeof fetch;

/** `revalidatePath` throws outside a request, after the action's writes have landed. */
async function outsideRequest<T>(work: Promise<T>): Promise<T | undefined> {
  try {
    return await work;
  } catch (err) {
    if (err instanceof Error && err.message.includes("static generation store")) return undefined;
    throw err;
  }
}

describe("outreach follow-up state machine (golden)", () => {
  before(() => freezeClock());
  after(() => mock.timers.reset());

  it("schedules, skips and generates follow-ups step by step", async () => {
    const db = await getDb();
    await ensureUserSettings(USER);
    await setSurfaceComingSoon("golden-outreach-admin", "page.outreach", false);
    await db
      .update(userSettings)
      .set({ aiProvider: "openai", aiModel: "gpt-4o-mini", openaiApiKeyEncrypted: encrypt("fake-openai") })
      .where(eq(userSettings.userId, USER));

    await db.insert(outreachCampaigns).values({
      id: fixedId(1, 6), userId: USER, name: "Golden", audienceQuery: "engineers at Acme", audienceFilters: {},
      status: "active", defaultChannel: "email",
      // delayDays 0 on step 2: `delayDays || 3` means "0" silently becomes 3 days. Pinned as-is.
      sequenceSteps: [{ delayDays: 5, intent: "Gentle nudge" }, { delayDays: 0, intent: "Last call" }],
    });
    const prospects = [
      { n: 1, fullName: "Ann Opened" },
      { n: 2, fullName: "Ben Positive" },
      { n: 3, fullName: "Cat Replied" },
      { n: 4, fullName: "Dan Dup" },
    ];
    await db.insert(outreachProspects).values(
      prospects.map((p) => ({
        id: fixedId(p.n, 7), campaignId: fixedId(1, 6), externalId: `golden-${p.n}`, fullName: p.fullName,
        company: "Acme", title: "Engineer", status: "selected", createdAt: daysAhead(-p.n),
      }))
    );
    const step0 = (n: number) => ({
      id: fixedId(n, 8), prospectId: fixedId(n, 7), channel: "email", subject: "Hello", body: `Hi ${n}, a note long enough to pass.`,
      status: "generated", stepIndex: 0, createdAt: daysAhead(-n),
    });
    await db.insert(outreachMessages).values([step0(1), step0(2), step0(3), step0(4)]);
    // Dan already has his step-1 follow-up: opening step 0 must not schedule a second one.
    await db.insert(outreachMessages).values({
      id: fixedId(14, 8), prospectId: fixedId(4, 7), channel: "email", body: "", status: "scheduled", stepIndex: 1,
      parentMessageId: fixedId(4, 8), scheduledFor: daysAhead(1), createdAt: daysAhead(-4),
    });

    const trace: Record<string, unknown> = {};
    const snapshot = async () => {
      const prospectRows = await db.select().from(outreachProspects).where(eq(outreachProspects.campaignId, fixedId(1, 6)));
      const nameOf = (id: string) => prospectRows.find((p) => p.id === id)?.fullName ?? "";
      const msgs = await db.select().from(outreachMessages);
      return {
        prospects: sortBy(prospectRows, (p) => p.fullName).map((p) => ({ name: p.fullName, status: p.status })),
        messages: sortBy(msgs, (m) => `${nameOf(m.prospectId)}|${String(m.stepIndex).padStart(2, "0")}`).map((m) => ({
          prospect: nameOf(m.prospectId), step: m.stepIndex, status: m.status, outcome: m.outcome, subject: m.subject, body: m.body,
          scheduledFor: m.scheduledFor, sentAt: m.sentAt, hasParent: m.parentMessageId !== null,
        })),
      };
    };

    // 1. Opening step 0 marks the prospect contacted and schedules step 1 (5 days out).
    await outsideRequest(markMessageAction({ messageId: fixedId(1, 8), status: "opened" }));
    await outsideRequest(markMessageAction({ messageId: fixedId(4, 8), status: "opened" }));
    // 2. Doing it again is a no-op (already delivered): nothing is scheduled twice.
    const again = await outsideRequest(markMessageAction({ messageId: fixedId(1, 8), status: "opened" }));
    trace.secondOpenReturned = again ?? null;
    trace.afterOpen = await snapshot();

    // 3. A positive reply: prospect becomes interested; its scheduled follow-ups are skipped.
    await outsideRequest(markMessageAction({ messageId: fixedId(2, 8), status: "opened" }));
    await outsideRequest(logMessageOutcome({ messageId: fixedId(2, 8), outcome: "positive_reply", notes: "Wants a call" }));
    await outsideRequest(markMessageAction({ messageId: fixedId(3, 8), status: "opened" }));
    await outsideRequest(logMessageOutcome({ messageId: fixedId(3, 8), outcome: "neutral_reply" }));
    trace.afterReplies = await snapshot();

    // 4. Six days on, everything scheduled is due. Ann and Dan are drafted (the model is the
    //    local stub); Ben and Cat were skipped when they replied.
    mock.timers.setTime(daysAhead(6).getTime());
    prompts.length = 0;
    trace.generateResult = (await outsideRequest(generateDueFollowUps(fixedId(1, 6)))) ?? null;
    trace.modelCalls = prompts.length;
    trace.afterGenerate = await snapshot();

    // 5. Opening the generated step 1 schedules step 2 (delayDays 0 -> 3 days); the sequence ends after it.
    await outsideRequest(markMessageAction({ messageId: (await db.select().from(outreachMessages).where(eq(outreachMessages.prospectId, fixedId(1, 7)))).find((m) => m.stepIndex === 1)!.id, status: "opened" }));
    trace.afterSecondStep = await snapshot();

    expectGolden(import.meta.url, "outreach-follow-ups", trace);
  });
});
