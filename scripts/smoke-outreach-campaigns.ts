/**
 * Generation-2 campaigns: creation validates the brief and never orphans a half-made campaign,
 * criteria are only ever stored confirmed (each confirmation is a new version), and confirming
 * after people exist queues exactly one rerank for that version. Tenancy on every read.
 *
 * Run: npx tsx scripts/smoke-outreach-campaigns.ts
 */
import "./smoke/_env";

import { and, eq } from "drizzle-orm";
import { run } from "./smoke/_env";
import { getDb } from "../src/db";
import { outreachJobs, outreachProspects, userSettings } from "../src/db/schema";
import {
  createCampaignV2,
  getCampaignV2,
  getDefaultSenderIntro,
  listCampaignsForUser,
  saveCriteria,
  suggestCriteria,
  updateCampaignBrief,
} from "../src/lib/outreach/campaigns";
import { ensureUserSettings } from "../src/lib/user-settings";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const USER = "smoke-campaigns-user";
const OTHER = "smoke-campaigns-other";
const brief = { purpose: "Meet partnership leads at fintech startups in New York", desiredOutcome: "Three intro calls" };

async function rejects(fn: () => Promise<unknown>) {
  try {
    await fn();
    return "";
  } catch (err) {
    return (err as Error).message;
  }
}

async function main() {
  const db = await getDb();
  await ensureUserSettings(USER);
  await ensureUserSettings(OTHER);

  check("a thin brief is refused in the house voice",
    (await rejects(() => createCampaignV2(USER, { brief: { purpose: "hi", desiredOutcome: "x" }, channel: "email" }))).length > 0);

  const { id } = await createCampaignV2(USER, {
    brief, channel: "email", senderIntro: "I run a small fintech newsletter.", saveIntroAsDefault: true,
  });
  const campaign = await getCampaignV2(USER, id);
  check("a campaign is created at the audience step", campaign?.setupStep === "audience" && campaign.criteriaVersion === 0);
  check("its name comes from the purpose", campaign?.name === "Meet partnership leads at fintech startups in New York");
  check("the sender introduction can become the default", (await getDefaultSenderIntro(USER)) === "I run a small fintech newsletter.");
  check("another user cannot read it", (await getCampaignV2(OTHER, id)) === null);
  check("another user cannot update it",
    (await rejects(() => updateCampaignBrief(OTHER, id, { brief: { ...brief, desiredOutcome: "Hijacked outcome" } }))).length > 0);

  await updateCampaignBrief(USER, id, { brief: { ...brief, notes: "Prefer Series A-C" } });
  check("the brief updates", (await getCampaignV2(USER, id))?.brief.notes === "Prefer Series A-C");

  const suggested = await suggestCriteria(USER, id, async () =>
    JSON.stringify({ required: [{ kind: "role", label: "Partnerships", values: ["Head of Partnerships"] }], preferred: [], exclusions: [] })
  );
  check("suggestions come back", suggested.source === "ai" && suggested.criteria.required.length === 1);
  check("…without being saved", (await getCampaignV2(USER, id))?.criteria.required.length === 0);

  check("confirming nothing is refused", (await rejects(() => saveCriteria(USER, id, { required: [], preferred: [], exclusions: [] }))).length > 0);
  const first = await saveCriteria(USER, id, suggested.criteria);
  const afterFirst = await getCampaignV2(USER, id);
  check("confirming bumps the version", first.criteriaVersion === 1 && Boolean(afterFirst?.criteriaConfirmedAt));
  check("…and advances to the people step", afterFirst?.setupStep === "people");
  check("no people yet, so no rerank", !first.rerankQueued);

  await db.insert(outreachProspects).values({ userId: USER, campaignId: id, externalId: "li:ada", fullName: "Ada Lovelace" });
  const second = await saveCriteria(USER, id, { ...suggested.criteria, exclusions: [{ kind: "organization", label: "Banks", values: ["JPMorgan"] }] });
  check("with people, confirming queues a rerank", second.criteriaVersion === 2 && second.rerankQueued);
  const reranks = await db.select().from(outreachJobs).where(and(eq(outreachJobs.userId, USER), eq(outreachJobs.kind, "ranking.rerank")));
  check("exactly one rerank for that version", reranks.length === 1 && reranks[0].payload.criteriaVersion === 2);
  check("another user cannot confirm criteria here", (await rejects(() => saveCriteria(OTHER, id, suggested.criteria))).length > 0);

  await db.update(userSettings).set({ compedPlan: "orbit" }).where(eq(userSettings.userId, USER));
  const list = await listCampaignsForUser(USER);
  check("the list shows the campaign with its people count", list.length === 1 && list[0].prospectCount === 1 && list[0].generation === 2);
  check("the other user's list is empty", (await listCampaignsForUser(OTHER)).length === 0);

  console.log("All outreach campaign checks passed.");
}

run(main);
