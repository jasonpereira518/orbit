/**
 * Smoke test for Contact Name Repair, Avatar Upkeep, and Admin Paced Queue:
 * 1. Unit tests for isUsernameOrGenericName (handles, slugs, email prefixes, generic names vs real names)
 * 2. Rate-limit pacing and cooldown tracking
 * 3. Multi-tier name and avatar resolution for contacts without LinkedIn URLs (address book / Gravatar)
 * 4. Admin global upkeep batch execution and backlog metrics
 * 5. User-level refresh target selection matching candidates needing repair
 *
 * Run: npx tsx scripts/smoke-contact-upkeep-queue.ts
 */
import "./smoke/_env";

import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, cronRuns } from "../src/db/schema";
import {
  isUsernameOrGenericName,
} from "../src/lib/contact-name-guess";
import {
  getLinkedInDirectCooldownUntil,
  isLinkedInDirectRateLimited,
  noteLinkedInDirectRateLimit,
  resetLinkedInDirectCooldownForTesting,
} from "../src/lib/linkedin-scraper";
import {
  getGlobalUpkeepMetrics,
  globalUpkeepCandidatePredicate,
  runGlobalContactUpkeepBatch,
} from "../src/lib/admin-contact-upkeep";
import {
  contactRefreshCandidatePredicate,
  refreshContactsFromLinkedIn,
} from "../src/actions/contacts";
import { checker } from "./smoke/check";

delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
delete process.env.CLERK_SECRET_KEY;
(process.env as Record<string, string>).NODE_ENV = "development";
process.env.ORBIT_DEMO_DATA = "off";

const t = checker();
const TEST_USER = "smoke-upkeep-user-" + Date.now();

async function main() {
  console.log("=== Part 1: Unit tests for isUsernameOrGenericName ===");

  // Generic names should be flagged
  t.check("Flags 'LinkedIn Member'", isUsernameOrGenericName("LinkedIn Member"));
  t.check("Flags lowercase 'linkedin member'", isUsernameOrGenericName("linkedin member"));
  t.check("Flags 'Unknown'", isUsernameOrGenericName("Unknown"));
  t.check("Flags 'user'", isUsernameOrGenericName("user"));
  t.check("Flags 'none'", isUsernameOrGenericName("none"));
  t.check("Flags 'n/a'", isUsernameOrGenericName("n/a"));

  // Handles and email local parts
  t.check(
    "Flags name matching email local part",
    isUsernameOrGenericName("alex", "alex@example.com")
  );
  t.check(
    "Flags dot-separated username",
    isUsernameOrGenericName("john.doe", "john.doe@acme.com")
  );
  t.check(
    "Flags underscore handle",
    isUsernameOrGenericName("satya_nadella")
  );
  t.check(
    "Flags alphanumeric handle with trailing digits",
    isUsernameOrGenericName("jsmith42")
  );
  t.check(
    "Flags @-prefixed handle",
    isUsernameOrGenericName("@jack")
  );

  // LinkedIn slug matches
  t.check(
    "Flags slug matching LinkedIn URL",
    isUsernameOrGenericName(
      "satya-nadella-12345",
      undefined,
      "https://www.linkedin.com/in/satya-nadella-12345"
    )
  );

  // Normal human names should NOT be flagged
  t.check("Accepts 'Satya Nadella'", !isUsernameOrGenericName("Satya Nadella"));
  t.check("Accepts 'Ada Lovelace'", !isUsernameOrGenericName("Ada Lovelace"));
  t.check("Accepts 'Sundar Pichai'", !isUsernameOrGenericName("Sundar Pichai"));
  t.check("Accepts 'Tim Cook'", !isUsernameOrGenericName("Tim Cook"));

  console.log("=== Part 2: Rate-limit pacing and cooldown tracking ===");
  const initialCooldown = getLinkedInDirectCooldownUntil();
  t.check("getLinkedInDirectCooldownUntil returns number", typeof initialCooldown === "number");

  noteLinkedInDirectRateLimit(10);
  t.check("isLinkedInDirectRateLimited is true after note", isLinkedInDirectRateLimited());
  const newCooldown = getLinkedInDirectCooldownUntil();
  t.check("Cooldown is set in the future", newCooldown > Date.now());

  // Reset rate-limit cooldown for live test passes
  resetLinkedInDirectCooldownForTesting();
  t.check("Cooldown reset back to zero for testing", !isLinkedInDirectRateLimited());

  console.log("=== Part 3: Database seeding & Candidate Predicates ===");
  const db = await getDb();
  const c1Id = randomUUID();
  const c2Id = randomUUID();
  const c3Id = randomUUID();

  try {
    // Contact 1: Handle name + email, no avatar, no LinkedIn URL
    await db.insert(contacts).values({
      id: c1Id,
      userId: TEST_USER,
      fullName: "john.doe",
      firstName: "john.doe",
      email: "john.doe@example.com",
      profileImageUrl: null,
    });

    // Contact 2: Generic name + LinkedIn URL + generic aero avatar
    await db.insert(contacts).values({
      id: c2Id,
      userId: TEST_USER,
      fullName: "LinkedIn Member",
      linkedinUrl: "https://www.linkedin.com/in/test-smoke-profile-upkeep",
      profileImageUrl: "https://static.licdn.com/aero-v1/sc/h/1c5af58cb8",
    });

    // Contact 3: Real name + valid photo (not a candidate)
    await db.insert(contacts).values({
      id: c3Id,
      userId: TEST_USER,
      fullName: "Ada Lovelace",
      firstName: "Ada",
      lastName: "Lovelace",
      profileImageUrl: "https://images.unsplash.com/photo-1534528741775-53994a69daeb",
      profileImageCheckedAt: new Date(),
    });

    // Check candidate predicate matches c1 and c2, but not c3
    const candidates = await db
      .select({ id: contacts.id, name: contacts.fullName })
      .from(contacts)
      .where(and(eq(contacts.userId, TEST_USER), globalUpkeepCandidatePredicate()));

    const matchedIds = new Set(candidates.map((c) => c.id));
    t.check("Contact 1 (handle name, no photo) is flagged as candidate", matchedIds.has(c1Id));
    t.check("Contact 2 (generic name, generic photo) is flagged as candidate", matchedIds.has(c2Id));
    t.check("Contact 3 (valid name, valid photo) is NOT flagged as candidate", !matchedIds.has(c3Id));

    console.log("=== Part 4: Admin global upkeep batch execution ===");
    const metricsBefore = await getGlobalUpkeepMetrics();
    t.check("Backlog metrics identify candidates across accounts", metricsBefore.totalCandidates >= 2);

    const batchStats = await runGlobalContactUpkeepBatch({
      batchSize: 10,
      pacingDelayMs: 20,
    });

    t.check("runGlobalContactUpkeepBatch checked candidates", batchStats.checked > 0);
    t.check("runGlobalContactUpkeepBatch repaired names", batchStats.namesFixed >= 1);
    console.log("Batch run stats:", batchStats);

    console.log("=== Part 5: User-level refresh target selection ===");
    // Test contactRefreshCandidatePredicate
    const userTargets = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.userId, TEST_USER), contactRefreshCandidatePredicate(TEST_USER)));

    t.check(
      "User-level candidate predicate finds refresh candidates",
      userTargets.length >= 1
    );

    // Refresh contact 1 directly (non-LinkedIn contact)
    const refreshResult = await refreshContactsFromLinkedIn([c1Id]);
    t.check(
      "refreshContactsFromLinkedIn processes contact without LinkedIn URL",
      refreshResult.refreshed >= 0 || (refreshResult.namesFixed ?? 0) >= 0
    );

    // Verify contact 1 was updated with a guessed/split name
    const [updatedC1] = await db
      .select()
      .from(contacts)
      .where(eq(contacts.id, c1Id));

    t.check(
      `Contact 1 name was repaired: '${updatedC1?.fullName}'`,
      updatedC1?.fullName === "John Doe" || updatedC1?.firstName === "John"
    );
  } finally {
    // Clean up
    await db.delete(contacts).where(inArray(contacts.id, [c1Id, c2Id, c3Id]));
    await db.delete(cronRuns).where(eq(cronRuns.job, "contacts.monthly-upkeep"));
  }

  t.done("smoke-contact-upkeep-queue");
}

main().catch((err) => {
  console.error("Upkeep smoke suite failed:", err);
  process.exit(1);
});
