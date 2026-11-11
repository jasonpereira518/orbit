/**
 * Smoke test for Smart Opportunities Engine
 *
 * Validates:
 * 1. Goal creation and progress tracking.
 * 2. Cross-contact note & idea extraction.
 * 3. Synthesis logic connecting notes from different people to user goals & progress.
 * 4. Item hash idempotency and deduplication.
 * 5. Lifecycle state transitions (open -> accepted/dismissed).
 */

import assert from "node:assert";
import { getDb } from "@/db";
import { contacts, interactions, smartOpportunities, userGoals } from "@/db/schema";
import {
  addGoalForUser,
  listActiveGoalsForUser,
  updateGoalProgressForUser,
} from "@/lib/user-goals";
import {
  buildSmartOpportunityItemHash,
  synthesizeOpportunitiesHeuristic,
  updateSmartOpportunityStatusForUser,
  type CandidateContactNote,
} from "@/lib/smart-opportunities-engine";

function check(desc: string, ok: boolean) {
  if (!ok) {
    console.error(`  FAIL ${desc}`);
    process.exit(1);
  }
  console.log(`  ok   ${desc}`);
}

async function run() {
  console.log("Starting Smart Opportunities smoke tests...\n");

  const db = await getDb();
  const testUserId = `smoke_user_${Date.now()}`;

  // 1. Goal Creation & Progress Tracking
  console.log("1. Goals & Progress Tracking:");
  const goal1 = await addGoalForUser(
    testUserId,
    "Launch Orbit developer beta and acquire 10 enterprise design partners",
    {
      progress: "Phase 1 eval harness built; currently seeking 3 enterprise partner teams",
      category: "partnership",
    }
  );

  check("Goal created successfully", Boolean(goal1 && goal1.id));
  check("Goal has correct text", goal1.text.includes("acquire 10 enterprise design partners"));
  check("Goal progress stored", goal1.progress === "Phase 1 eval harness built; currently seeking 3 enterprise partner teams");
  check("Goal category stored", goal1.category === "partnership");

  // Update progress
  const updatedGoal = await updateGoalProgressForUser(
    testUserId,
    goal1.id,
    "Phase 1 complete; actively meeting design partner candidates"
  );
  check("Progress updated successfully", Boolean(updatedGoal));
  check("Updated progress value matches", updatedGoal?.progress === "Phase 1 complete; actively meeting design partner candidates");

  const activeGoals = await listActiveGoalsForUser(testUserId);
  check("listActiveGoalsForUser returns goal with progress", activeGoals.length === 1 && Boolean(activeGoals[0].progress));

  // 2. Synthesizing Cross-Contact Ideas & Notes
  console.log("\n2. Cross-Contact Synthesis & Synergy Matching:");
  const contactA: CandidateContactNote = {
    contactId: "c1111111-1111-1111-1111-111111111111",
    fullName: "Sarah Chen",
    preferredName: "Sarah",
    company: "Notion",
    title: "Head of Agent Infrastructure",
    topics: ["ai", "evals", "agent workflows"],
    notes: ["Sarah is looking for an evaluation harness and benchmark suites for enterprise agent workflows."],
    actionItems: ["Follow up with Sarah on agent evaluation benchmarks."],
  };

  const contactB: CandidateContactNote = {
    contactId: "c2222222-2222-2222-2222-222222222222",
    fullName: "David Kim",
    preferredName: "David",
    company: "DevEval Labs",
    title: "Founder & CEO",
    topics: ["ai", "evals", "benchmarks"],
    notes: ["David built a new agent evaluation suite and is seeking design partners in enterprise software."],
    actionItems: ["Review David's evaluation harness."],
  };

  const candidates = synthesizeOpportunitiesHeuristic(
    activeGoals,
    [contactA, contactB]
  );

  check("Synthesized at least 1 smart opportunity", candidates.length >= 1);
  const topOpp = candidates[0];

  check("Opportunity type is introduction or knowledge share", topOpp.opportunityType === "introduction" || topOpp.opportunityType === "knowledge_share");
  check("Related contacts include both Sarah and David", topOpp.relatedContactIds.includes(contactA.contactId) && topOpp.relatedContactIds.includes(contactB.contactId));
  check("Synthesis rationale draws together both perspectives", topOpp.synthesisRationale.includes("Sarah") && topOpp.synthesisRationale.includes("David"));
  check("Synthesis rationale links to user's goal progress", topOpp.synthesisRationale.toLowerCase().includes("design partners") || topOpp.synthesisRationale.includes("acquire 10 enterprise"));
  check("Suggested action provides clear actionable next step", topOpp.suggestedAction.length > 15);
  check("Contact excerpts carry quotes from both people", topOpp.contactExcerpts.length === 2);

  // 3. Item Hash & Idempotency
  console.log("\n3. Item Hash & Deduplication:");
  const hash1 = buildSmartOpportunityItemHash(
    testUserId,
    topOpp.goalId,
    topOpp.relatedContactIds,
    topOpp.title
  );
  const hash2 = buildSmartOpportunityItemHash(
    testUserId,
    topOpp.goalId,
    [topOpp.relatedContactIds[1], topOpp.relatedContactIds[0]], // reverse order
    topOpp.title
  );
  check("Hash is order-independent for contact IDs", hash1 === hash2);

  // Insert row into database
  const [row1] = await db
    .insert(smartOpportunities)
    .values({
      userId: testUserId,
      goalId: topOpp.goalId,
      title: topOpp.title,
      opportunityType: topOpp.opportunityType,
      status: "open",
      synthesisRationale: topOpp.synthesisRationale,
      suggestedAction: topOpp.suggestedAction,
      confidenceScore: topOpp.confidenceScore,
      impactScore: topOpp.impactScore,
      relatedContactIds: topOpp.relatedContactIds,
      contactExcerpts: topOpp.contactExcerpts,
      itemHash: hash1,
    })
    .onConflictDoNothing()
    .returning();

  check("First insert succeeded", Boolean(row1 && row1.id));

  // Second insert with same hash must not duplicate
  const [row2] = await db
    .insert(smartOpportunities)
    .values({
      userId: testUserId,
      goalId: topOpp.goalId,
      title: topOpp.title,
      opportunityType: topOpp.opportunityType,
      status: "open",
      synthesisRationale: topOpp.synthesisRationale,
      suggestedAction: topOpp.suggestedAction,
      confidenceScore: topOpp.confidenceScore,
      impactScore: topOpp.impactScore,
      relatedContactIds: topOpp.relatedContactIds,
      contactExcerpts: topOpp.contactExcerpts,
      itemHash: hash1,
    })
    .onConflictDoNothing()
    .returning();

  check("Duplicate insert safely blocked by unique index", row2 === undefined);

  // 4. Lifecycle State Transitions
  console.log("\n4. State Transitions:");
  const accepted = await updateSmartOpportunityStatusForUser(testUserId, row1.id, "accepted");
  check("Status updated to accepted", accepted?.status === "accepted");
  check("closedAt is populated on accept", accepted?.closedAt !== null);

  console.log("\nAll Smart Opportunities smoke checks passed! 🚀");
}

run().catch((err) => {
  console.error("Test failed with error:", err);
  process.exit(1);
});
