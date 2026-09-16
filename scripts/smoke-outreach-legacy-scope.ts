/**
 * Legacy Outreach is closed to generation-2 campaigns (spec §5.11, §14).
 *
 * A user outside the release gate — an admin viewing as a user today, everyone after a flag
 * rollback — still gets the legacy workspace, and the legacy actions used to look campaigns
 * up by owner alone. A generation-2 campaign then opened in the legacy UI, where draft
 * generation reads its `status = 'selected'` as ready to draft and the legacy sender could mail
 * the Apollo-sourced addresses it holds with none of generation 2's suppression or review.
 * Every legacy read and mutation is now scoped to `generation = 1`: a generation-2 campaign,
 * prospect or message behaves exactly like one that does not exist.
 *
 * The legacy actions resolve the user from the session, so this drives them in demo mode —
 * no Clerk keys and NODE_ENV=development make `requireUserId()` return `demo-user` — with the
 * demo-workspace seed switched off. Every assertion is scoped to the rows this script creates,
 * since `demo-user` is shared with other scripts, and those rows are deleted at the end.
 *
 * Run: npx tsx scripts/smoke-outreach-legacy-scope.ts
 */
import "./smoke/_env";

import { and, count, eq, inArray } from "drizzle-orm";
import { run } from "./smoke/_env";
import { getDb } from "../src/db";
import { outreachCampaigns, outreachMessages, outreachProspects } from "../src/db/schema";
import {
  generateOutreachDrafts,
  getCampaign,
  getOutreachPerformanceSummary,
  listCampaigns,
  logMessageOutcome,
  markMessageAction,
  previewBulkSendQuality,
  sendOutreachMessageAction,
  updateOutreachMessage,
  updateProspectSelection,
} from "../src/actions/outreach";
import { createCampaignV2 } from "../src/lib/outreach/campaigns";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const USER = "demo-user";
const env = process.env as Record<string, string | undefined>;

async function refusal(fn: () => Promise<unknown>) {
  try {
    await fn();
    return "";
  } catch (err) {
    return (err as Error).message;
  }
}

async function main() {
  const prior = {
    publishable: env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
    secret: env.CLERK_SECRET_KEY,
    nodeEnv: env.NODE_ENV,
    demoData: env.ORBIT_DEMO_DATA,
  };
  delete env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  delete env.CLERK_SECRET_KEY;
  env.NODE_ENV = "development";
  env.ORBIT_DEMO_DATA = "off";

  const db = await getDb();
  const created: string[] = [];
  try {
    const [legacy] = await db
      .insert(outreachCampaigns)
      .values({ userId: USER, name: "Legacy-scope smoke (gen 1)", status: "active" })
      .returning();
    created.push(legacy.id);
    const [legacyProspect] = await db
      .insert(outreachProspects)
      .values({ userId: USER, campaignId: legacy.id, externalId: "legacy-scope:lena", fullName: "Lena Legacy", status: "selected" })
      .returning();
    const [legacyMessage] = await db
      .insert(outreachMessages)
      .values({ prospectId: legacyProspect.id, channel: "email", subject: "Hello", body: "Hi Lena — a note", status: "generated" })
      .returning();

    const { id: nextId } = await createCampaignV2(USER, {
      brief: { purpose: "Meet partnership leads in fintech", desiredOutcome: "Intro calls" }, channel: "email",
    });
    created.push(nextId);
    // Exactly what legacy draft generation and sending would act on: selected, with an address.
    const [nextProspect] = await db
      .insert(outreachProspects)
      .values({
        userId: USER, campaignId: nextId, externalId: "li:legacy-scope-nora", fullName: "Nora Next",
        status: "selected", email: "nora@apollo.example", emailSource: "apollo",
      })
      .returning();
    const [nextMessage] = await db
      .insert(outreachMessages)
      .values({ prospectId: nextProspect.id, channel: "email", subject: null, body: "", status: "generated" })
      .returning();
    const nextMessageRow = async () => (await db.select().from(outreachMessages).where(eq(outreachMessages.id, nextMessage.id)))[0];
    const nextProspectRow = async () => (await db.select().from(outreachProspects).where(eq(outreachProspects.id, nextProspect.id)))[0];

    console.log("Legacy reads never see a generation-2 campaign...");
    const listed = await listCampaigns();
    check("the legacy list shows the generation-1 campaign", listed.some((c) => c.id === legacy.id));
    check("…and not the generation-2 one", !listed.some((c) => c.id === nextId), JSON.stringify(listed.map((c) => [c.id, c.generation])));
    check("the legacy workspace refuses to open it", (await refusal(() => getCampaign(nextId))) === "Campaign not found");
    check("…while a generation-1 campaign still opens", (await getCampaign(legacy.id)).id === legacy.id);
    const [{ n: gen1Count }] = await db
      .select({ n: count() })
      .from(outreachCampaigns)
      .where(and(eq(outreachCampaigns.userId, USER), eq(outreachCampaigns.generation, 1)));
    const summary = await getOutreachPerformanceSummary();
    check("the performance summary counts generation-1 campaigns only",
      summary.accountMetrics.campaignCount === Number(gen1Count), `${summary.accountMetrics.campaignCount} vs ${gen1Count}`);
    const preview = await previewBulkSendQuality({ campaignId: legacy.id, messageIds: [legacyMessage.id, nextMessage.id] });
    check("a send preview only assesses messages of the campaign it names",
      preview.issues.every((i) => i.messageId !== nextMessage.id) && preview.blocking.every((i) => i.messageId !== nextMessage.id),
      JSON.stringify(preview.issues));

    console.log("Legacy mutations refuse a generation-2 campaign...");
    check("the legacy sender refuses its message", (await refusal(() => sendOutreachMessageAction(nextMessage.id))) === "Message not found");
    check("…leaving it unsent", (await nextMessageRow()).status === "generated");
    check("marking it opened is refused", (await refusal(() => markMessageAction({ messageId: nextMessage.id, status: "opened" }))) === "Message not found");
    check("logging an outcome is refused", (await refusal(() => logMessageOutcome({ messageId: nextMessage.id, outcome: "positive_reply" }))) === "Message not found");
    check("editing it is refused", (await refusal(() => updateOutreachMessage({ messageId: nextMessage.id, body: "Rewritten by the legacy editor" }))) === "Message not found");
    const untouched = await nextMessageRow();
    check("…so the message is exactly as it was", untouched.body === "" && untouched.outcome === null && untouched.sentAt === null, JSON.stringify(untouched));
    check("legacy draft generation refuses the campaign", (await refusal(() => generateOutreachDrafts({ campaignId: nextId }))) === "Campaign not found");
    const drafts = await db.select().from(outreachMessages).where(eq(outreachMessages.prospectId, nextProspect.id));
    check("…and drafts nothing for its selected people", drafts.length === 1, String(drafts.length));
    check("legacy selection refuses it",
      (await refusal(() => updateProspectSelection({ campaignId: nextId, prospectIds: [nextProspect.id], status: "excluded" }))) === "Campaign not found");
    check("…leaving the person selected", (await nextProspectRow()).status === "selected");
  } finally {
    if (created.length) await db.delete(outreachCampaigns).where(inArray(outreachCampaigns.id, created));
    for (const [key, name] of [
      ["publishable", "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"],
      ["secret", "CLERK_SECRET_KEY"],
      ["nodeEnv", "NODE_ENV"],
      ["demoData", "ORBIT_DEMO_DATA"],
    ] as const) {
      if (prior[key] === undefined) delete env[name];
      else env[name] = prior[key];
    }
  }
  console.log("All legacy outreach scope checks passed.");
}

run(main);
