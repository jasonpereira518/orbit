/**
 * Pins the read paths that moved their filtering, capping and counting into SQL to what the
 * JavaScript they replaced computed, on fixtures built to hit every edge of the old code:
 *
 *   - Outreach metrics (`campaignMetricAggregates`, `listCampaigns`,
 *     `getOutreachPerformanceSummary`) against `computeCampaignMetrics` over the full
 *     prospect/message tree — every predicate, NULL and '' outcomes, the scheduled-for
 *     boundary at microsecond precision, prospects without messages, campaigns without
 *     prospects, and another account's campaign.
 *   - The dashboard's reminder and suggestion cards (`loadDashboardReminders`,
 *     `loadDashboardSuggestions`, `getDashboardData`) against the old read-everything-then-
 *     filter code: the generated-reminder/due-contact drop, suggestion dedupe, ghosts,
 *     another account's contacts, a non-canonical id, the caps and the totals past them.
 *   - Outreach prior notes (`priorNotesForContacts` via `generateOutreachDrafts`, and
 *     `priorNotesForContact` via `regenerateOutreachDraft`): the three newest of the caller's
 *     own interactions only, and the 500-character cut unchanged by trimming in SQL.
 *   - The chat history list (`listChatThreads`): untitled threads left out, pages that
 *     neither skip nor repeat a thread across ties and sub-millisecond `updated_at`s.
 *   - A thread's sent-draft claims (`getChatThread().sent`): this thread's only, none lost
 *     among hundreds of the account's other claims, none of another account's.
 *
 * Runs the real server actions as demo mode's `demo-user` (like smoke-batched-writes),
 * against a throwaway PGlite, with the model stubbed at `fetch`.
 *
 * Run: npx tsx scripts/smoke-bounded-reads.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../src/db";
import {
  aiSuggestions,
  chatMessages,
  chatThreads,
  contacts,
  interactions,
  outreachCampaigns,
  outreachMessages,
  outreachProspects,
  reminders,
  userSettings,
} from "../src/db/schema";
import { encrypt } from "../src/lib/crypto";
import { ensureUserSettings } from "../src/lib/user-settings";
import {
  generateOutreachDrafts,
  getOutreachPerformanceSummary,
  listCampaigns,
  regenerateOutreachDraft,
} from "../src/actions/outreach";
import { getChatThread, listChatThreads } from "../src/actions/chat";
import { computeCampaignMetrics } from "../src/lib/outreach-metrics";
import { campaignMetricAggregates, metricsFromAggregates } from "../src/lib/outreach-metrics-sql";
import { getDashboardData, loadDashboardReminders, loadDashboardSuggestions } from "../src/lib/reminders";

delete process.env.RESEND_API_KEY;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.APOLLO_API_KEY;
delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
delete process.env.CLERK_SECRET_KEY;
process.env.ORBIT_DEMO_DATA = "off";
(process.env as Record<string, string>).NODE_ENV = "development";

const USER = "demo-user";
const OTHER = "smoke-bounded-other-tenant";
const DASH_USER = "smoke-bounded-dashboard";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

/** `revalidatePath` throws outside a request, after the action's writes have landed. */
async function outsideRequest<T>(work: Promise<T>): Promise<T | undefined> {
  try {
    return await work;
  } catch (err) {
    if (err instanceof Error && err.message.includes("static generation store")) return undefined;
    throw err;
  }
}

const json = (v: unknown) => JSON.stringify(v);

// ---- model stub: every prompt the model is sent ----
const prompts: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (/api\.openai\.com/.test(url)) {
    const raw = init?.body ?? (input instanceof Request ? await input.clone().text() : "");
    const text = typeof raw === "string" ? raw : "";
    prompts.push(text);
    return Response.json({
      id: "c1", object: "chat.completion", created: 0, model: "gpt-4o-mini",
      choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ subject: "S", body: "B" }) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
  }
  return realFetch(input, init);
}) as typeof fetch;

async function cleanup() {
  const db = await getDb();
  const users = [USER, OTHER, DASH_USER];
  await db.delete(outreachCampaigns).where(inArray(outreachCampaigns.userId, users));
  await db.delete(reminders).where(inArray(reminders.userId, users));
  await db.delete(aiSuggestions).where(inArray(aiSuggestions.userId, users));
  await db.delete(chatThreads).where(inArray(chatThreads.userId, users));
  await db.delete(interactions).where(inArray(interactions.userId, users));
  await db.delete(contacts).where(inArray(contacts.userId, users));
  await db.delete(userSettings).where(inArray(userSettings.userId, users));
}

/** The whole tree, as `listCampaigns` and the dashboard card used to read it. */
async function campaignTrees(userId: string) {
  const db = await getDb();
  return db.query.outreachCampaigns.findMany({
    where: eq(outreachCampaigns.userId, userId),
    orderBy: [desc(outreachCampaigns.updatedAt)],
    with: {
      prospects: {
        columns: { id: true, status: true },
        with: {
          messages: {
            columns: {
              id: true, status: true, outcome: true, stepIndex: true, channel: true,
              sentAt: true, scheduledFor: true, repliedAt: true,
            },
          },
        },
      },
    },
  });
}

async function outreachMetricsSection() {
  console.log("outreach metrics: SQL aggregates vs computeCampaignMetrics");
  const db = await getDb();
  const DAY = 86_400_000;
  const past = new Date(Date.now() - DAY);
  const future = new Date(Date.now() + DAY);
  const t0 = Date.now();
  const [c1, c2, c3, c4] = await db
    .insert(outreachCampaigns)
    .values([
      { userId: USER, name: "Metrics everything", updatedAt: new Date(t0 - 1000) },
      { userId: USER, name: "Metrics no prospects", updatedAt: new Date(t0 - 2000) },
      { userId: USER, name: "Metrics nothing sent", updatedAt: new Date(t0 - 3000) },
      { userId: USER, name: "Metrics good rate", updatedAt: new Date(t0 - 4000) },
    ])
    .returning();
  const [foreign] = await db.insert(outreachCampaigns).values({ userId: OTHER, name: "Not yours" }).returning();

  const prospects = await db
    .insert(outreachProspects)
    .values([
      { campaignId: c1.id, externalId: "m-a", fullName: "A", status: "selected" },
      { campaignId: c1.id, externalId: "m-b", fullName: "B", status: "selected" },
      { campaignId: c1.id, externalId: "m-c", fullName: "C", status: "suggested" },
      // No messages at all: counted as a prospect, never as a message.
      { campaignId: c1.id, externalId: "m-d", fullName: "D", status: "selected" },
      { campaignId: c3.id, externalId: "m-e", fullName: "E", status: "suggested" },
      { campaignId: c4.id, externalId: "m-f", fullName: "F", status: "contacted" },
      { campaignId: foreign.id, externalId: "m-x", fullName: "X", status: "selected" },
    ])
    .returning();
  const [pa, pb, pc, , pe, pf, px] = prospects;
  const msg = (prospectId: string, over: Partial<typeof outreachMessages.$inferInsert>) => ({
    prospectId, channel: "email", body: "", status: "draft", stepIndex: 0, ...over,
  });
  await db.insert(outreachMessages).values([
    msg(pa.id, { status: "sent" }), // delivered, awaiting
    msg(pa.id, { status: "opened", outcome: "positive_reply" }), // delivered, reply, positive
    msg(pa.id, { status: "draft", outcome: "" }), // '' outcome: NOT delivered, not awaiting
    msg(pa.id, { status: "draft", outcome: "bounced" }), // delivered via outcome, bounced
    msg(pa.id, { status: "draft", sentAt: past }), // delivered via sent_at, awaiting
    msg(pa.id, { status: "sent", outcome: "" }), // delivered, awaiting ('' is no outcome)
    msg(pb.id, { status: "copied", outcome: "negative_reply" }),
    msg(pb.id, { status: "sent", outcome: "neutral_reply" }),
    msg(pb.id, { status: "sent", outcome: "unsubscribed" }), // delivered, not a reply
    msg(pb.id, { status: "generated", stepIndex: 1 }), // pending follow-up
    msg(pb.id, { status: "generated", stepIndex: 1, sentAt: past }), // delivered, so not pending
    msg(pb.id, { status: "generated", stepIndex: 0 }), // step 0: not pending
    msg(pb.id, { status: "generated", stepIndex: 2, outcome: "neutral_reply" }), // delivered via outcome
    msg(pc.id, { status: "scheduled", scheduledFor: past, stepIndex: 1 }), // pending
    msg(pc.id, { status: "scheduled", scheduledFor: future, stepIndex: 1 }), // not yet
    msg(pc.id, { status: "scheduled", scheduledFor: null, stepIndex: 1 }), // never
    msg(pc.id, { status: "failed" }),
    msg(pe.id, { status: "draft" }),
    msg(pe.id, { status: "generated", stepIndex: 0 }),
    msg(pf.id, { status: "sent", outcome: "positive_reply" }),
    msg(pf.id, { status: "sent", outcome: "positive_reply" }),
    msg(pf.id, { status: "sent" }),
    msg(px.id, { status: "sent", outcome: "positive_reply" }),
  ]);
  // The boundary, at microsecond precision: stored 500 µs AFTER `boundaryNow`, which a
  // JavaScript Date (and so computeCampaignMetrics) truncates to exactly `boundaryNow`.
  const boundaryNow = new Date("2026-01-01T00:00:00.000Z");
  await db.execute(sql`
    insert into outreach_messages (prospect_id, channel, body, status, step_index, scheduled_for)
    values (${pc.id}, 'email', '', 'scheduled', 1, '2026-01-01T00:00:00.000500Z'::timestamptz),
           (${pc.id}, 'email', '', 'scheduled', 1, '2026-01-01T00:00:00.001000Z'::timestamptz)
  `);

  const trees = await campaignTrees(USER);
  const nonTrivial = trees.find((t) => t.id === c1.id);
  check(
    "fixture: the everything-campaign has messages of every kind",
    (nonTrivial?.prospects.flatMap((p) => p.messages).length ?? 0) >= 18
  );

  // 1. The aggregate itself, at fixed instants — including the microsecond boundary.
  for (const [label, now] of [["now", new Date()], ["the scheduled_for boundary", boundaryNow]] as const) {
    const rows = await db
      .select({ id: outreachCampaigns.id, counts: campaignMetricAggregates(now) })
      .from(outreachCampaigns)
      .leftJoin(outreachProspects, eq(outreachProspects.campaignId, outreachCampaigns.id))
      .leftJoin(outreachMessages, eq(outreachMessages.prospectId, outreachProspects.id))
      .where(eq(outreachCampaigns.userId, USER))
      .groupBy(outreachCampaigns.id);
    for (const tree of trees) {
      const expected = computeCampaignMetrics(tree.prospects, now);
      const got = rows.find((r) => r.id === tree.id);
      check(
        `aggregate = computeCampaignMetrics for "${tree.name}" at ${label}`,
        Boolean(got) && json(metricsFromAggregates(got!.counts)) === json(expected),
        `sql ${json(got && metricsFromAggregates(got.counts))}\n       js  ${json(expected)}`
      );
    }
  }
  check(
    "the boundary case is live: one boundary message is due to JS, one is not",
    computeCampaignMetrics(nonTrivial!.prospects, boundaryNow).pendingFollowUpCount ===
      computeCampaignMetrics(nonTrivial!.prospects, new Date(boundaryNow.getTime() - 1)).pendingFollowUpCount + 1
  );

  // 2. listCampaigns: every campaign row, same order, metrics as before.
  const listed = await listCampaigns();
  check(
    "listCampaigns returns exactly this account's campaigns, newest first",
    json(listed.map((c) => c.id)) === json(trees.map((t) => t.id)),
    `${json(listed.map((c) => c.name))} vs ${json(trees.map((t) => t.name))}`
  );
  for (const tree of trees) {
    const got = listed.find((c) => c.id === tree.id);
    const expected = computeCampaignMetrics(tree.prospects);
    check(
      `listCampaigns metrics for "${tree.name}" match`,
      json(got?.metrics) === json(expected),
      `${json(got?.metrics)} vs ${json(expected)}`
    );
    check(
      `listCampaigns prospectCount for "${tree.name}" is the prospect count the card showed`,
      got?.metrics.prospectCount === tree.prospects.length
    );
  }
  const fullRow = await db.query.outreachCampaigns.findFirst({ where: eq(outreachCampaigns.id, c1.id) });
  const { metrics: _m, ...listedRow } = listed.find((c) => c.id === c1.id)!;
  check("listCampaigns still returns the whole campaign row", json(listedRow) === json(fullRow), json(listedRow));
  check("listCampaigns no longer ships the prospect tree", !("prospects" in listedRow));

  // 3. The dashboard card: the old computation, run over the tree.
  const summary = await getOutreachPerformanceSummary();
  const withMetrics = trees.map((c) => ({ ...c, metrics: computeCampaignMetrics(c.prospects) }));
  const expectedTop = [...withMetrics]
    .filter((c) => c.metrics.sentCount > 0)
    .sort((a, b) => {
      const aRate = a.metrics.successfulReplyRate ?? -1;
      const bRate = b.metrics.successfulReplyRate ?? -1;
      if (bRate !== aRate) return bRate - aRate;
      return b.metrics.positiveReplyCount - a.metrics.positiveReplyCount;
    })
    .slice(0, 5)
    .map((c) => ({ id: c.id, name: c.name, metrics: c.metrics, defaultChannel: c.defaultChannel, status: c.status }));
  const totals = withMetrics.reduce(
    (acc, c) => {
      acc.sent += c.metrics.sentCount;
      acc.bounced += c.metrics.bouncedCount;
      acc.positive += c.metrics.positiveReplyCount;
      acc.replies += c.metrics.replyCount;
      return acc;
    },
    { sent: 0, bounced: 0, positive: 0, replies: 0 }
  );
  const eligible = Math.max(0, totals.sent - totals.bounced);
  const expectedSummary = {
    topCampaigns: expectedTop,
    accountMetrics: {
      sentCount: totals.sent,
      replyCount: totals.replies,
      positiveReplyCount: totals.positive,
      successfulReplyRate: eligible > 0 ? totals.positive / eligible : null,
      campaignCount: trees.length,
    },
  };
  check(
    "getOutreachPerformanceSummary is unchanged",
    json(summary) === json(expectedSummary),
    `${json(summary)}\n       ${json(expectedSummary)}`
  );
  check("fixture: the summary ranks more than one campaign", summary.topCampaigns.length >= 2);
  void c2;
}

async function dashboardSection() {
  console.log("\ndashboard reminders + suggestions: SQL filters vs the old JavaScript");
  const db = await getDb();
  const DAY = 86_400_000;
  const now = new Date();
  const [due, notDue, noFollowUp, dueToo] = await db
    .insert(contacts)
    .values([
      { userId: DASH_USER, fullName: "Due Dana", nextFollowUpAt: new Date(now.getTime() - DAY) },
      { userId: DASH_USER, fullName: "Later Lee", nextFollowUpAt: new Date(now.getTime() + DAY) },
      { userId: DASH_USER, fullName: "Nobody Ned" },
      { userId: DASH_USER, fullName: "Due Dev", nextFollowUpAt: new Date(now.getTime() - 2 * DAY) },
    ])
    .returning();
  const [foreignDue] = await db
    .insert(contacts)
    .values({ userId: OTHER, fullName: "Their Due", nextFollowUpAt: new Date(now.getTime() - DAY) })
    .returning();
  const at = (days: number) => new Date(now.getTime() + days * DAY);
  const rem = (over: Partial<typeof reminders.$inferInsert>) => ({
    userId: DASH_USER, title: "r", status: "pending", reminderType: "manual", ...over,
  });
  await db.insert(reminders).values([
    rem({ title: "generated, due contact (dropped)", reminderType: "generated", contactId: due.id, dueDate: at(-10) }),
    rem({ title: "generated, other due contact (dropped)", reminderType: "generated", contactId: dueToo.id, dueDate: at(-9.5) }),
    rem({ title: "generated, not-due contact", reminderType: "generated", contactId: notDue.id, dueDate: at(-9) }),
    rem({ title: "generated, no follow-up", reminderType: "generated", contactId: noFollowUp.id, dueDate: at(-8) }),
    rem({ title: "manual, due contact", contactId: due.id, dueDate: at(-7) }),
    rem({ title: "generated, no contact", reminderType: "generated", dueDate: at(-6) }),
    rem({ title: "ai_suggested, due contact", reminderType: "ai_suggested", contactId: due.id, dueDate: at(-5) }),
    rem({ title: "completed (not pending)", status: "completed", dueDate: at(-4) }),
    rem({ title: "no due date", dueDate: null }),
    // Past the cap of twenty, so the total has to come from past the LIMIT.
    ...Array.from({ length: 24 }, (_, i) => rem({ title: `filler ${i}`, dueDate: at(i + 1) })),
  ]);
  await db.insert(reminders).values(rem({ userId: OTHER, title: "not yours", dueDate: at(-20) }));

  const sug = (over: Partial<typeof aiSuggestions.$inferInsert>) => ({
    userId: DASH_USER, suggestionType: "dormant_high_value", title: "s", status: "pending", ...over,
  });
  await db.insert(aiSuggestions).values([
    sug({ title: "dup low", relatedContactIds: [notDue.id], confidenceScore: 50 }),
    sug({ title: "dup high (kept)", relatedContactIds: [notDue.id], confidenceScore: 90 }),
    sug({ title: "same contact, other type (kept)", suggestionType: "post_event", relatedContactIds: [notDue.id], confidenceScore: 80 }),
    sug({ title: "due contact (dropped)", relatedContactIds: [due.id], confidenceScore: 95 }),
    sug({ title: "ghost (dropped)", relatedContactIds: ["00000000-0000-4000-8000-00000000dead"], confidenceScore: 94 }),
    sug({ title: "another account's contact (dropped)", relatedContactIds: [foreignDue.id], confidenceScore: 93 }),
    sug({ title: "upper-case id (dropped, as a Set lookup would)", relatedContactIds: [noFollowUp.id.toUpperCase()], confidenceScore: 92 }),
    sug({ title: "not an id at all (dropped)", relatedContactIds: ["nope"], confidenceScore: 91 }),
    sug({ title: "no contacts (kept)", relatedContactIds: [], confidenceScore: 70 }),
    sug({ title: "null contacts (kept)", relatedContactIds: null, confidenceScore: 69 }),
    sug({ title: "empty-string contact (kept)", relatedContactIds: [""], confidenceScore: 68 }),
    sug({ title: "empty-string contact, same type (deduped away)", relatedContactIds: [""], confidenceScore: 67 }),
    sug({ title: "second contact only (kept)", relatedContactIds: [noFollowUp.id, due.id], confidenceScore: 66 }),
    sug({ title: "null confidence", relatedContactIds: [dueToo.id, notDue.id], confidenceScore: null }),
    sug({ title: "dismissed", status: "dismissed", relatedContactIds: [], confidenceScore: 99 }),
    // Past the cap of forty.
    ...Array.from({ length: 45 }, (_, i) => sug({ title: `filler ${i}`, suggestionType: "job_posting_signal", confidenceScore: 10 + i })),
  ]);
  await db.insert(aiSuggestions).values(sug({ userId: OTHER, title: "not yours", confidenceScore: 100 }));

  // The old code, verbatim in effect: read everything, filter in JavaScript, then cap.
  const scan = await db.query.contacts.findMany({ where: eq(contacts.userId, DASH_USER), columns: { id: true, nextFollowUpAt: true } });
  const allContactIds = new Set(scan.map((c) => c.id));
  const dueFollowUpIds = new Set(scan.filter((c) => c.nextFollowUpAt && new Date(c.nextFollowUpAt) <= now).map((c) => c.id));
  const pending = await db.query.reminders.findMany({
    where: and(eq(reminders.userId, DASH_USER), eq(reminders.status, "pending")),
    orderBy: [asc(reminders.dueDate)],
  });
  const expectedReminders = pending.filter((r) => {
    if (r.reminderType !== "generated") return true;
    if (!r.contactId) return true;
    return !dueFollowUpIds.has(r.contactId);
  });
  const pendingSuggestions = await db.query.aiSuggestions.findMany({
    where: and(eq(aiSuggestions.userId, DASH_USER), eq(aiSuggestions.status, "pending")),
    orderBy: [desc(aiSuggestions.confidenceScore)],
  });
  const seen = new Set<string>();
  const expectedSuggestions = pendingSuggestions.filter((s) => {
    const contactId = s.relatedContactIds?.[0];
    const key = `${s.suggestionType}:${contactId ?? s.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    if (!contactId) return true;
    if (!allContactIds.has(contactId)) return false;
    return !dueFollowUpIds.has(contactId);
  });

  const gotReminders = await loadDashboardReminders(DASH_USER, now);
  check(
    "reminders: the same first twenty, whole rows, in the same order",
    json(gotReminders.rows) === json(expectedReminders.slice(0, 20)),
    `${json(gotReminders.rows.map((r) => r.title))}\n       ${json(expectedReminders.slice(0, 20).map((r) => r.title))}`
  );
  check(
    "reminders: the total counts past the cap",
    gotReminders.total === expectedReminders.length && gotReminders.total > 20,
    `${gotReminders.total} vs ${expectedReminders.length}`
  );
  const gotSuggestions = await loadDashboardSuggestions(DASH_USER, now);
  check(
    "suggestions: the same first forty, whole rows, in the same order",
    json(gotSuggestions.rows) === json(expectedSuggestions.slice(0, 40)),
    `${json(gotSuggestions.rows.map((s) => s.title))}\n       ${json(expectedSuggestions.slice(0, 40).map((s) => s.title))}`
  );
  check(
    "suggestions: the total counts past the cap",
    gotSuggestions.total === expectedSuggestions.length && gotSuggestions.total > 40,
    `${gotSuggestions.total} vs ${expectedSuggestions.length}`
  );
  const keptTitles = new Set(expectedSuggestions.map((s) => s.title));
  check(
    "fixture: every suggestion edge is exercised",
    keptTitles.has("dup high (kept)") && !keptTitles.has("dup low") && !keptTitles.has("ghost (dropped)") &&
      !keptTitles.has("upper-case id (dropped, as a Set lookup would)") && keptTitles.has("empty-string contact (kept)") &&
      !keptTitles.has("empty-string contact, same type (deduped away)") && !keptTitles.has("due contact (dropped)")
  );

  const dashboard = await getDashboardData(DASH_USER);
  check(
    "getDashboardData: reminders card and stat",
    json(dashboard.reminders.map((r) => r.id)) === json(expectedReminders.slice(0, 20).map((r) => r.id)) &&
      dashboard.stats.pendingReminders === expectedReminders.length
  );
  check(
    "getDashboardData: suggestions card and total",
    json(dashboard.suggestions.map((s) => s.id)) === json(expectedSuggestions.slice(0, 40).map((s) => s.id)) &&
      dashboard.totalSuggestions === expectedSuggestions.length
  );
  check(
    "getDashboardData: every contact the two cards name is hydrated",
    [...dashboard.reminders.map((r) => r.contactId), ...dashboard.suggestions.map((s) => s.relatedContactIds?.[0])]
      .filter((id): id is string => Boolean(id))
      .every((id) => dashboard.contactById.has(id))
  );
}

async function priorNotesSection() {
  console.log("\noutreach prior notes: three newest, the caller's own, cut the same");
  const db = await getDb();
  const [who] = await db.insert(contacts).values({ userId: USER, fullName: "Nora Notes" }).returning();
  const base = Date.now() - 10 * 86_400_000;
  const long = "PN-2 " + "y".repeat(600);
  await db.insert(interactions).values([
    { userId: USER, contactId: who.id, interactionDate: new Date(base + 1000), aiSummary: "PN-oldest" },
    { userId: USER, contactId: who.id, interactionDate: new Date(base + 2000), aiSummary: "", rawNotes: long },
    { userId: USER, contactId: who.id, interactionDate: new Date(base + 3000), aiSummary: null, rawNotes: null },
    { userId: USER, contactId: who.id, interactionDate: new Date(base + 4000), aiSummary: "PN-4", rawNotes: "ignored raw" },
    // Another account's row on the same contact id, and the newest of all: never read.
    { userId: OTHER, contactId: who.id, interactionDate: new Date(base + 5000), aiSummary: "PN-FOREIGN" },
  ]);
  // The old string: three newest by date, summary || raw, falsy dropped, joined, cut at 500.
  const expected = ["PN-4", null, long].filter(Boolean).join(" | ").slice(0, 500);

  const [campaign] = await db
    .insert(outreachCampaigns)
    .values({ userId: USER, name: "Prior notes", audienceQuery: "people", defaultChannel: "email" })
    .returning();
  const [prospect] = await db
    .insert(outreachProspects)
    .values({ campaignId: campaign.id, externalId: "pn-1", fullName: "Nora Notes", contactId: who.id, email: "n@example.org", title: "PM", company: "Acme", status: "selected" })
    .returning();
  prompts.length = 0;
  await outsideRequest(generateOutreachDrafts({ campaignId: campaign.id, prospectIds: [prospect.id], channel: "email", excludeLowSignal: false }));
  const batchPrompt = prompts.find((p) => p.includes("Nora Notes")) ?? "";
  check("batched: the prompt carries the same prior-notes string", batchPrompt.includes(`Prior context: ${expected}`), batchPrompt.slice(0, 400));
  check("batched: another account's interaction never reaches it", !batchPrompt.includes("PN-FOREIGN"));
  check("batched: only the three newest", !batchPrompt.includes("PN-oldest"));

  prompts.length = 0;
  await outsideRequest(regenerateOutreachDraft({ campaignId: campaign.id, prospectId: prospect.id, channel: "email" }));
  const singlePrompt = prompts.find((p) => p.includes("Nora Notes")) ?? "";
  check("single: the prompt carries the same prior-notes string", singlePrompt.includes(`Prior context: ${expected}`), singlePrompt.slice(0, 400));
  check("single: another account's interaction never reaches it", !singlePrompt.includes("PN-FOREIGN"));
}

async function chatThreadListSection() {
  console.log("\nlistChatThreads: titled only, keyset pages that neither skip nor repeat");
  const db = await getDb();
  const titled = await db
    .insert(chatThreads)
    .values(Array.from({ length: 230 }, (_, i) => ({ userId: USER, title: `Thread ${i}` })))
    .returning();
  const untitled = await db
    .insert(chatThreads)
    .values([
      { userId: USER, title: null },
      { userId: USER, title: "" },
      { userId: USER, title: "   " },
    ])
    .returning();
  await db.insert(chatThreads).values({ userId: OTHER, title: "Theirs" });
  // Both page boundaries land where a sloppy cursor would break: positions 91-110 are one
  // MICROsecond apart (one millisecond to a JavaScript Date) across the first boundary, and
  // 191-210 share one instant across the second. The untitled threads are the newest of all,
  // so a filter applied after the LIMIT would show as a short page.
  await db.execute(sql`
    with numbered as (
      select id, row_number() over (order by title) as n from chat_threads
      where user_id = ${USER} and title like 'Thread %'
    )
    update chat_threads t set updated_at = case
      when n between 91 and 110
        then '2026-03-01T12:00:00Z'::timestamptz - interval '91 seconds' - (n || ' microseconds')::interval
      when n between 191 and 210
        then '2026-03-01T12:00:00Z'::timestamptz - interval '191 seconds'
      else '2026-03-01T12:00:00Z'::timestamptz - (n || ' seconds')::interval
    end
    from numbered where t.id = numbered.id
  `);
  await db.execute(sql`update chat_threads set updated_at = '2026-04-01T00:00:00Z' where id in ${sql.raw(`('${untitled.map((t) => t.id).join("','")}')`)}`);

  const first = await listChatThreads();
  check("the first page is a full page of 100", first.threads.length === 100, String(first.threads.length));
  check("and says there is more", first.nextCursor !== null);
  check("no untitled thread is listed", first.threads.every((t) => t.title?.trim()));
  const second = await listChatThreads(first.nextCursor);
  check("the second page is another full page", second.threads.length === 100 && second.nextCursor !== null, `${second.threads.length} ${second.nextCursor}`);
  const third = await listChatThreads(second.nextCursor);
  check("the third page is the rest, and the last", third.threads.length === 30 && third.nextCursor === null, `${third.threads.length} ${third.nextCursor}`);
  const ids = [...first.threads, ...second.threads, ...third.threads].map((t) => t.id);
  check(
    "every titled thread exactly once across the pages",
    ids.length === 230 && new Set(ids).size === 230 && titled.every((t) => ids.includes(t.id)),
    `${ids.length} listed, ${new Set(ids).size} distinct`
  );
  const expectedOrder = await db
    .select({ id: chatThreads.id })
    .from(chatThreads)
    .where(and(eq(chatThreads.userId, USER), sql`${chatThreads.title} like 'Thread %'`))
    .orderBy(desc(chatThreads.updatedAt), desc(chatThreads.id));
  check("newest first, ties broken by id", json(ids) === json(expectedOrder.map((r) => r.id)));
  check(
    "the rows carry exactly what the rail reads",
    json(Object.keys(first.threads[0] ?? {}).sort()) === json(["createdAt", "id", "title", "updatedAt"])
  );
  const bad = await listChatThreads("not-a-cursor").then(
    () => "returned",
    (err: unknown) => (err instanceof Error ? err.message : String(err))
  );
  check("a malformed cursor is refused before it reaches SQL", bad === "Invalid history cursor", bad);
}

async function chatClaimsSection() {
  console.log("\ngetChatThread: this thread's sent-draft claims only, none lost");
  const db = await getDb();
  const [who, other] = await db
    .insert(contacts)
    .values([
      { userId: USER, fullName: "Claim One" },
      { userId: USER, fullName: "Claim Two" },
    ])
    .returning();
  const [thread] = await db.insert(chatThreads).values({ userId: USER, title: "Claims" }).returning();
  const [elsewhere] = await db.insert(chatThreads).values({ userId: USER, title: "Elsewhere" }).returning();
  const [m1, m2, u1] = await db
    .insert(chatMessages)
    .values([
      { threadId: thread.id, userId: USER, role: "assistant", content: "draft one" },
      { threadId: thread.id, userId: USER, role: "assistant", content: "draft two" },
      { threadId: thread.id, userId: USER, role: "user", content: "question" },
    ])
    .returning();
  const [e1] = await db.insert(chatMessages).values({ threadId: elsewhere.id, userId: USER, role: "assistant", content: "x" }).returning();
  const old = new Date(Date.now() - 30 * 86_400_000);
  const claim = (userId: string, messageId: string, contactId: string, when: Date) => ({
    userId, contactId, interactionType: "email", direction: "out" as const, source: "chat_send",
    externalId: `chat-send:${messageId}:${contactId}`, interactionDate: when,
  });
  await db.insert(interactions).values([
    claim(USER, m1.id, who.id, old),
    claim(USER, m1.id, other.id, old),
    claim(USER, m2.id, who.id, old),
    // A claim on a user message's id is not a draft claim; the old code ignored it too.
    claim(USER, u1.id, who.id, old),
    claim(USER, e1.id, who.id, new Date()),
    // Six hundred of the account's other claims, all newer: the old unordered LIMIT 500 had
    // no reason to include this thread's among them.
    ...Array.from({ length: 600 }, (_, i) =>
      claim(USER, `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, who.id, new Date(Date.now() - i * 1000))
    ),
  ]);
  await db.insert(interactions).values(claim(OTHER, m2.id, other.id, new Date()));

  const loaded = await getChatThread(thread.id);
  const expected = {
    [m1.id]: { [who.id]: old.toISOString(), [other.id]: old.toISOString() },
    [m2.id]: { [who.id]: old.toISOString() },
  };
  const sorted = (v: Record<string, Record<string, string>>) =>
    json(Object.keys(v).sort().map((k) => [k, Object.keys(v[k]!).sort().map((c) => [c, v[k]![c]])]));
  check("sent names exactly this thread's drafts and recipients", sorted(loaded.sent) === sorted(expected), json(loaded.sent));
}

run(async () => {
  await cleanup();
  const db = await getDb();
  await ensureUserSettings(USER);
  await db
    .update(userSettings)
    .set({ aiProvider: "openai", aiModel: "gpt-4o-mini", openaiApiKeyEncrypted: encrypt("fake-openai") })
    .where(eq(userSettings.userId, USER));

  await outreachMetricsSection();
  await dashboardSection();
  await priorNotesSection();
  await chatThreadListSection();
  await chatClaimsSection();

  await cleanup();
  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall bounded-read checks passed");
});
