/**
 * Radar v2 Engine End-to-End Smoke:
 *   - Semantic goal/project/steering matcher (`semantic-match.ts`, lexical fallback)
 *   - Graph & Warm-Path synthesis (`graph-opportunities.ts`: open_opportunity, warm_path)
 *   - Multi-slot contact scoring (`pickContactCards`)
 *   - Reactive cadence (`composeReactive`: pin-on-seen + immediate surfacing)
 *   - Plays & Steering (`saveRadarSteeringForUser`, `advanceDoubleOptInIntroForUser`, `trackRadarOpportunityForUser`)
 *   - Unified page-data momentum & steeringContext (`loadRadarPage`, `loadRadarBriefing`)
 *
 * Writes only to throwaway PGlite (`./smoke/_env`). Run: npx tsx scripts/smoke-radar-v2.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { and, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import {
  companies,
  contactCareerMoves,
  contactExperiences,
  contactOpportunities,
  interactions,
  recommendations,
  relationshipDigests,
  targetCompanies,
  userGoals,
  userSettings,
} from "../src/db/schema";
import { orgKeysFor } from "../src/lib/warm-paths";
import { findSemanticMatches } from "../src/lib/radar/semantic-match";
import { produceGraphOpportunities } from "../src/lib/radar/signals/graph-opportunities";
import { NO_SUPPRESSION, pickContactCards, scoreContactKinds, type RadarContact } from "../src/lib/radar/score";
import { composeReactive } from "../src/lib/radar/week";
import {
  advanceDoubleOptInIntroForUser,
  saveRadarSteeringForUser,
  trackRadarOpportunityForUser,
} from "../src/lib/radar/plays";
import { loadRadarBriefing, loadRadarPage } from "../src/lib/radar/page-data";
import { claimRadarLease, runRadarForUser } from "../src/lib/radar/run";
import { ensureUserSettings } from "../src/lib/user-settings";
import { checker } from "./smoke/check";
import { fakeUserId, insertContact, purgeUsers } from "./smoke/factories";

const t = checker();
const DAY = 86_400_000;
const NOW = new Date();
const ago = (d: number) => new Date(NOW.getTime() - d * DAY);
const ahead = (d: number) => new Date(NOW.getTime() + d * DAY);

function pureChecks() {
  console.log("\nmulti-slot scoring & composeReactive");
  const c: RadarContact = {
    id: "c-multi",
    company: "Stripe",
    tier: "inner",
    priorityLevel: 2,
    relationshipScore: 3,
    statedCloseness: null,
    firstInteractionAt: ago(300),
    lastInteractionAt: ago(10),
    nextFollowUpAt: null,
    constellationPin: null,
    cadenceDays: null,
    cadencePhrase: null,
    targetPriority: 1,
    goalFit: 1,
    semanticFit: 0.7,
    steeringFit: 0.6,
    hasEvidence: true,
  };
  const scored = scoreContactKinds(
    c,
    [
      {
        kind: "action_item_open",
        contactId: "c-multi",
        at: ago(4),
        text: "Send API design notes",
        count: 1,
        source: { table: "action_items", id: "a1", text: "Send API design notes", quote: "Send API design notes" },
      },
      {
        kind: "open_opportunity",
        contactId: "c-multi",
        at: ago(3),
        oppKind: "introduction",
        label: "Warm intro to payments infra lead",
        source: { table: "contact_opportunities", id: "o1", text: "Warm intro to payments infra lead", quote: "Warm intro to payments infra lead" },
      },
    ],
    NO_SUPPRESSION,
    NOW
  );
  const cards = pickContactCards("c-multi", scored, NOW);
  t.check(
    "pickContactCards yields up to 2 complementary cards for one contact",
    cards.length === 2 &&
      cards.some((k) => k.kind === "follow_up") &&
      cards.some((k) => k.kind === "warm_path" || k.kind === "opportunity"),
    JSON.stringify(cards.map((k) => k.kind))
  );

  // Reactive composition keeps seen pinned cards and surfaces brand-new high-scoring cards.
  const freshPick = {
    contactId: "c-new",
    kind: "warm_path" as const,
    score: 52,
    baseScore: 52,
    bucket: "today" as const,
    reasons: [{ code: "warm_path", label: "Maya is at Stripe", points: 24 }],
    evidence: [{ code: "warm_path", label: "Joined Stripe", at: ago(1).toISOString() }],
    expiresAt: ahead(7),
    inputsHash: "hash-new",
  };
  const pinnedPick = {
    contactId: "c-pinned",
    kind: "reconnect" as const,
    score: 24,
    baseScore: 24,
    bucket: "soon" as const,
    reasons: [{ code: "dormant", label: "Quiet", points: 24 }],
    evidence: [{ code: "dormant", label: "Quiet", at: ago(30).toISOString() }],
    expiresAt: ahead(7),
    inputsHash: "hash-pinned",
  };
  const composed = composeReactive(
    [freshPick, pinnedPick],
    [
      {
        contactId: "c-pinned",
        kind: "reconnect",
        status: "pending",
        bucket: "soon",
        inputsHash: "hash-pinned",
        pinnedUntil: ahead(3),
      },
      {
        contactId: "c-unseen",
        kind: "reconnect",
        status: "pending",
        bucket: "soon",
        inputsHash: "hash-unseen",
        pinnedUntil: null,
      },
    ],
    { planSize: 10, todayMax: 4 },
    NOW
  );
  t.check(
    "composeReactive preserves pinned seen card, retires vanished unseen card, and surfaces fresh card",
    composed.some((p) => p.contactId === "c-pinned") &&
      !composed.some((p) => p.contactId === "c-unseen") &&
      composed.some((p) => p.contactId === "c-new"),
    JSON.stringify(composed.map((p) => p.contactId))
  );
}

run(async () => {
  pureChecks();

  const db = await getDb();
  const USER = fakeUserId("radar-v2");
  await purgeUsers(db, [USER]);

  try {
    await ensureUserSettings(USER);
    const steering = await saveRadarSteeringForUser(USER, {
      topics: ["Agentic Workflows", "DevTools"],
      targetOrgs: ["Anthropic"],
      cadenceMode: "reactive",
    });
    t.check(
      "steering persists sanitized topics and targetOrgs",
      Boolean(steering.topics?.length === 2 && steering.targetOrgs?.includes("Anthropic") && steering.cadenceMode === "reactive"),
      JSON.stringify(steering)
    );

    await db.insert(userGoals).values({ userId: USER, text: "Break into AI developer tools partnerships", active: 1 });
    const [co] = await db
      .insert(companies)
      .values({ userId: USER, name: "Anthropic", nameNormalized: "anthropic" })
      .returning();
    await db.insert(targetCompanies).values({ userId: USER, companyId: co!.id, priority: 1 });

    const maya = await insertContact(db, USER, 10, {
      fullName: "Maya Lin",
      company: "Anthropic",
      title: "Staff Engineer",
      closenessTier: "inner",
      closenessEvidence: 0.9,
      closeness: 92,
      lastInteractionAt: ago(25),
    });
    const alex = await insertContact(db, USER, 11, {
      fullName: "Alex Rivera",
      company: "Linear",
      title: "Head of Partnerships",
      closenessTier: "mid",
      closenessEvidence: 0.7,
      closeness: 76,
      lastInteractionAt: ago(18),
    });
    await db.insert(interactions).values([
      { userId: USER, contactId: maya.id, interactionType: "meeting", interactionDate: ago(25), aiSummary: "Discussed agentic developer tooling" },
      { userId: USER, contactId: alex.id, interactionType: "meeting", interactionDate: ago(18), aiSummary: "Talked about ecosystem partnerships" },
    ]);
    await db.insert(contactExperiences).values({
      userId: USER,
      contactId: maya.id,
      kind: "role",
      organization: "Anthropic",
      organizationNormalized: orgKeysFor(["Anthropic"])[0]!,
      isCurrent: true,
      source: "web",
    });
    await db.insert(contactCareerMoves).values({
      userId: USER,
      contactId: maya.id,
      kind: "joined",
      toOrg: "Anthropic",
      toTitle: "Staff Engineer",
      source: "web",
      dedupeKey: "maya-anthropic",
      detectedAt: ago(2),
    });
    await db.insert(relationshipDigests).values({
      userId: USER,
      contactId: maya.id,
      whatTheyDo: "Staff Engineer at Anthropic",
      workingOn: "Building agentic workflows and developer tooling at Anthropic",
      topics: [{ label: "DevTools", lastDiscussedAt: ago(2).toISOString() }, { label: "Agentic Workflows", lastDiscussedAt: ago(1).toISOString() }],
    });
    await db.insert(contactOpportunities).values({
      userId: USER,
      contactId: alex.id,
      kind: "collaboration",
      label: "Co-host devtools builder dinner",
      status: "open",
      sourceExcerpt: "Happy to co-host a devtools builder dinner together next month",
      confidenceScore: 88,
      createdBy: "ai",
      createdAt: ago(3),
    });

    console.log("\nsemantic + graph signal producers");
    const semantic = await findSemanticMatches(USER, {
      goals: ["Break into AI developer tools partnerships"],
      projects: [],
      steering,
      now: NOW,
      access: null,
    });
    t.check(
      "semantic matcher returns contact scores via lexical/digest fallback without embeddings",
      (semantic.byContact.get(maya.id)?.similarity ?? 0) > 0 &&
        semantic.signals.some((s) => s.kind === "semantic_match" && s.contactId === maya.id),
      JSON.stringify([...semantic.byContact.entries()])
    );

    const graphSignals = await produceGraphOpportunities(USER, NOW, {
      targetKeys: new Map([["anthropic", 1]]),
      projects: [],
      steering,
      semanticMatches: semantic.byContact,
    });
    t.check(
      "graph producer emits warm_path for target company and open_opportunity without due dates",
      graphSignals.some((s) => s.kind === "warm_path" && s.contactId === maya.id) &&
        graphSignals.some((s) => s.kind === "open_opportunity" && s.contactId === alex.id),
      JSON.stringify(graphSignals.map((s) => `${s.kind}:${s.contactId}`))
    );

    console.log("\nend-to-end Radar v2 run, plays & page-data");
    await db.update(userSettings).set({ radarEnabledAt: ago(5) }).where(eq(userSettings.userId, USER));
    await claimRadarLease(USER, NOW);
    const stats = await runRadarForUser(USER, { trigger: "manual", now: NOW, ai: false });
    t.check("Radar v2 run succeeds in reactive mode", stats.ok && stats.mode === "reactive" && stats.recommendations >= 2, JSON.stringify(stats));

    const page = await loadRadarPage(USER);
    t.check(
      "loadRadarPage includes steeringContext and momentum",
      page.steeringContext.goals.length === 1 &&
        page.steeringContext.targetOrgs.includes("Anthropic") &&
        typeof page.momentum.conversationsSparked === "number",
      JSON.stringify({ ctx: page.steeringContext, momentum: page.momentum })
    );

    const briefing = await loadRadarBriefing(USER);
    t.check("loadRadarBriefing returns top recommendations and topFinds array", briefing.hasRun && Array.isArray(briefing.topFinds));

    const firstRec = page.recommendations[0];
    t.check("loadRadarPage returns generated recommendations", Boolean(firstRec), String(page.recommendations.length));
    if (firstRec) {
      await db
        .update(recommendations)
        .set({ playType: "double_opt_in_intro", secondaryContactId: alex.id })
        .where(eq(recommendations.id, firstRec.id));
      const stepRes = await advanceDoubleOptInIntroForUser(USER, firstRec.id, "awaiting_opt_in", NOW);
      t.check("double-opt-in play advances to awaiting_opt_in and pins card", stepRes.ok && stepRes.playState.step === "awaiting_opt_in", JSON.stringify(stepRes));

      const tracked = await trackRadarOpportunityForUser(USER, { source: "recommendation", id: firstRec.id }, NOW);
      t.check("trackRadarOpportunity promotes card into contact_opportunities", tracked.ok, JSON.stringify(tracked));
      const rows = await db
        .select()
        .from(contactOpportunities)
        .where(and(eq(contactOpportunities.userId, USER), eq(contactOpportunities.contactId, firstRec.contactId)));
      t.check("contact_opportunities row written by play", rows.length >= 1, String(rows.length));
    }
  } finally {
    await purgeUsers(db, [USER]);
  }

  t.done("radar v2 engine");
});
