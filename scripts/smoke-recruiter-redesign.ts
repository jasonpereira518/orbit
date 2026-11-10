/**
 * Smoke test for Redesigned Recruiter Feature.
 *
 * Verifies:
 * 1. Recruiting cycle start date resolution (August / January cycles).
 * 2. Deterministic human name detection (rejects ATS / bot / company / team names).
 * 3. LinkedIn URL extraction from email content / signatures.
 * 4. Entity resolution & deduplication (nicknames, canonical company names, LinkedIn slug matching).
 * 5. 5-recruiter minimum threshold for enabling community sharing.
 * 6. Anonymized public pooled storage (contributor identities never exposed).
 * 7. Credit-based contact unlocking (locked by default, revealed upon unlock).
 *
 * Run: npx tsx scripts/smoke-recruiter-redesign.ts
 */
import "./smoke/_env";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import {
  recruiters,
  userRecruiterLinks,
  userSettings,
  recruiterContactUnlocks,
} from "../src/db/schema";
import {
  getRecruitingCycleStartDate,
  resolveScanWindow,
} from "../src/lib/recruiter-scan-state";
import {
  isRealHumanName,
  extractLinkedinFromContent,
} from "../src/lib/recruiter-detect";
import {
  canonicalFirm,
  areNicknames,
  areNamesEquivalent,
  findMatchingRecruiter,
  upsertCanonicalRecruiter,
  ensureUserLink,
  getUserRecruiterCount,
  toPublicRecruiter,
  MIN_RECRUITERS_FOR_SHARING,
  unlockedRecruiterIdsForViewer,
} from "../src/lib/recruiters";

let failures = 0;
function check(label: string, condition: boolean, detail?: string) {
  if (!condition) {
    console.error(`  FAIL  ${label}${detail ? `: ${detail}` : ""}`);
    failures++;
  } else {
    console.log(`  ok    ${label}`);
  }
}

const TEST_USERS = [
  "smoke-redesign-user-a",
  "smoke-redesign-user-b",
  "smoke-redesign-user-c",
];

async function cleanup() {
  const db = await getDb();
  await db
    .delete(userRecruiterLinks)
    .where(inArray(userRecruiterLinks.userId, TEST_USERS));
  await db
    .delete(recruiterContactUnlocks)
    .where(inArray(recruiterContactUnlocks.userId, TEST_USERS));
  await db
    .delete(userSettings)
    .where(inArray(userSettings.userId, TEST_USERS));
  await db.delete(recruiters).where(eq(recruiters.firm, "RedesignTestCorp"));
  await db.delete(recruiters).where(eq(recruiters.firm, "Google"));
  await db.delete(recruiters).where(eq(recruiters.firm, "Google LLC"));
}

async function runTests() {
  console.log("\n1. Recruiting Cycle Start Date Resolution");
  {
    // Test fixed dates in Fall (e.g. October 2026)
    const fallNow = new Date("2026-10-15T12:00:00Z");
    const fallCurrent = getRecruitingCycleStartDate("current", fallNow);
    check(
      "current cycle in October returns July 1st of current year",
      fallCurrent.getUTCFullYear() === 2026 &&
        fallCurrent.getUTCMonth() === 6 && // July is 6 (0-indexed)
        fallCurrent.getUTCDate() === 1
    );

    // Test fixed dates in Spring (e.g. March 2026)
    const springNow = new Date("2026-03-15T12:00:00Z");
    const springCurrent = getRecruitingCycleStartDate("current", springNow);
    check(
      "current cycle in March returns January 1st of current year",
      springCurrent.getUTCFullYear() === 2026 &&
        springCurrent.getUTCMonth() === 0 && // January is 0
        springCurrent.getUTCDate() === 1
    );

    // Explicit July cycle in March (returns previous year's July)
    const explicitJulyInMarch = getRecruitingCycleStartDate("july", springNow);
    check(
      "explicit july in March returns July 1st of previous year",
      explicitJulyInMarch.getUTCFullYear() === 2025 &&
        explicitJulyInMarch.getUTCMonth() === 6 &&
        explicitJulyInMarch.getUTCDate() === 1
    );

    // Explicit January cycle in October (returns January 1st of same year)
    const explicitJanInOctober = getRecruitingCycleStartDate("january", fallNow);
    check(
      "explicit january in October returns January 1st of same year",
      explicitJanInOctober.getUTCFullYear() === 2026 &&
        explicitJanInOctober.getUTCMonth() === 0 &&
        explicitJanInOctober.getUTCDate() === 1
    );

    // resolveScanWindow with cycle
    const window = await resolveScanWindow(TEST_USERS[0], { cycle: "july" });
    check(
      "resolveScanWindow with cycle=july anchors to July 1st",
      window.after instanceof Date && window.after.getUTCMonth() === 6 && window.isFull
    );
  }

  console.log("\n2. Deterministic Human Name Detection");
  {
    // Real human names
    check("validates 'Sarah Chen'", isRealHumanName("Sarah Chen").valid);
    check("validates 'Jonathan Smith'", isRealHumanName("Jonathan Smith").valid);
    check("validates 'Alexandria O'Connor'", isRealHumanName("Alexandria O'Connor").valid);
    check("validates 'Mary Jane Watson'", isRealHumanName("Mary Jane Watson").valid);

    // ATS and automated systems
    check("rejects 'Greenhouse'", !isRealHumanName("Greenhouse").valid);
    check("rejects 'Greenhouse Recruiting'", !isRealHumanName("Greenhouse Recruiting").valid);
    check("rejects 'Lever Support'", !isRealHumanName("Lever Support").valid);
    check("rejects 'Workday Notifications'", !isRealHumanName("Workday Notifications").valid);
    check("rejects 'Google Careers'", !isRealHumanName("Google Careers").valid);
    check("rejects 'Amazon Jobs'", !isRealHumanName("Amazon Jobs").valid);
    check("rejects 'No-Reply'", !isRealHumanName("No-Reply").valid);
    check("rejects 'DoNotReply'", !isRealHumanName("DoNotReply").valid);
    check("rejects 'Talent Acquisition Team'", !isRealHumanName("Talent Acquisition Team").valid);
    check("rejects 'Campus Recruiting'", !isRealHumanName("Campus Recruiting").valid);
    check("rejects 'People Operations'", !isRealHumanName("People Operations").valid);
    check("rejects 'HR Department'", !isRealHumanName("HR Department").valid);
    check("rejects single token name 'Recruiter'", !isRealHumanName("Recruiter").valid);
    check("rejects single token name 'Admin'", !isRealHumanName("Admin").valid);
  }

  console.log("\n3. LinkedIn URL Extraction");
  {
    const signatureText = `
      Best regards,
      Sarah Chen | Senior Technical Recruiter
      Connect with me: https://www.linkedin.com/in/sarah-chen-talent/
      Stripe Inc.
    `;
    check(
      "extracts https linkedin url from signature",
      extractLinkedinFromContent(signatureText) ===
        "https://www.linkedin.com/in/sarah-chen-talent"
    );

    const markdownText = `Check my profile [here](https://linkedin.com/in/johndoe?trk=profile_share)`;
    check(
      "extracts linkedin url and strips tracking query parameters",
      extractLinkedinFromContent(markdownText) ===
        "https://www.linkedin.com/in/johndoe"
    );

    const jobUrlText = `Apply here: https://www.linkedin.com/jobs/view/12345678`;
    check(
      "ignores non-profile linkedin urls (jobs)",
      extractLinkedinFromContent(jobUrlText) === null
    );
  }

  console.log("\n4. Entity Resolution & Deduplication");
  {
    // Canonical firm
    check("normalizes 'Google LLC' to 'google'", canonicalFirm("Google LLC") === "google");
    check("normalizes 'Google, Inc.' to 'google'", canonicalFirm("Google, Inc.") === "google");
    check("normalizes 'Amazon Web Services' to 'amazon'", canonicalFirm("Amazon Web Services") === "amazon");
    check("normalizes 'AWS' to 'amazon'", canonicalFirm("AWS") === "amazon");
    check("normalizes 'Meta Platforms Inc.' to 'meta'", canonicalFirm("Meta Platforms Inc.") === "meta");

    // Nicknames
    check("identifies Jon and Jonathan as nicknames", areNicknames("Jon", "Jonathan"));
    check("identifies Dan and Daniel as nicknames", areNicknames("Dan", "Daniel"));
    check("identifies Bill and William as nicknames", areNicknames("Bill", "William"));
    check("identifies Bob and Robert as nicknames", areNicknames("Bob", "Robert"));
    check("identifies Alex and Alexander as nicknames", areNicknames("Alex", "Alexander"));

    // Name equivalence
    check(
      "considers 'Jon Doe' and 'Jonathan Doe' equivalent",
      areNamesEquivalent("Jon Doe", "Jonathan Doe")
    );
    check(
      "rejects unrelated names 'Alice Smith' and 'Bob Smith'",
      !areNamesEquivalent("Alice Smith", "Bob Smith")
    );

    // Database deduplication lookup
    await cleanup();

    // Create canonical recruiter
    const initial = await upsertCanonicalRecruiter({
      fullName: "Jonathan Doe",
      firm: "Google LLC",
      email: "jdoe@google.test",
      linkedinUrl: "https://www.linkedin.com/in/jonathandoe",
    }, { contributePii: true, createdByUserId: TEST_USERS[0] });

    // Match by exact email
    const matchByEmail = await findMatchingRecruiter({
      email: "jdoe@google.test",
    });
    check("matches recruiter by email", matchByEmail?.id === initial.id);

    // Match by LinkedIn URL (with trailing slash difference)
    const matchByLinkedin = await findMatchingRecruiter({
      linkedinUrl: "http://linkedin.com/in/jonathandoe/",
    });
    check("matches recruiter by linkedin slug", matchByLinkedin?.id === initial.id);

    // Match by nickname + canonical company variant
    const matchByFuzzy = await findMatchingRecruiter({
      fullName: "Jon Doe",
      firm: "Google, Inc.",
    });
    check(
      "matches recruiter by nickname 'Jon Doe' and company 'Google, Inc.'",
      matchByFuzzy?.id === initial.id
    );
  }

  console.log("\n5. 5-Recruiter Minimum Threshold for Sharing");
  {
    await cleanup();

    const testNames = [
      "Alice Adams",
      "Bob Brown",
      "Charlie Clark",
      "David Davis",
    ];

    // Seed User A with 4 recruiters
    for (let i = 0; i < testNames.length; i++) {
      const rec = await upsertCanonicalRecruiter({
        fullName: testNames[i],
        firm: "RedesignTestCorp",
        email: `candidate${i + 1}@redesigntest.test`,
      }, { contributePii: false, createdByUserId: TEST_USERS[0] });

      await ensureUserLink({
        userId: TEST_USERS[0],
        recruiterId: rec.id,
        roleInterviewingFor: `Role ${i + 1}`,
      });
    }

    let countA = await getUserRecruiterCount(TEST_USERS[0]);
    check("User A has 4 recruiters logged", countA === 4, `found ${countA}`);
    check("User A is below MIN_RECRUITERS_FOR_SHARING (5)", countA < MIN_RECRUITERS_FOR_SHARING);

    // Add 5th recruiter
    const rec5 = await upsertCanonicalRecruiter({
      fullName: "Emma Evans",
      firm: "RedesignTestCorp",
      email: "candidate5@redesigntest.test",
    }, { contributePii: false, createdByUserId: TEST_USERS[0] });

    await ensureUserLink({
      userId: TEST_USERS[0],
      recruiterId: rec5.id,
      roleInterviewingFor: "Role 5",
    });

    countA = await getUserRecruiterCount(TEST_USERS[0]);
    check("User A now has 5 recruiters logged", countA === 5, `found ${countA}`);
    check("User A meets MIN_RECRUITERS_FOR_SHARING", countA >= MIN_RECRUITERS_FOR_SHARING);
  }

  console.log("\n6. Anonymity & Public Pooled Storage");
  let sharedRecruiterId = "";
  {
    const db = await getDb();
    // User A shares recruiters to the pool
    await db.insert(userSettings).values({
      userId: TEST_USERS[0],
      recruiterSharing: 1,
    });

    const sharedRecruiter = await upsertCanonicalRecruiter({
      fullName: "Samantha Shared",
      firm: "RedesignTestCorp",
      email: "shared@redesigntest.test",
      linkedinUrl: "https://www.linkedin.com/in/sharedrecruiter",
    }, { contributePii: true, createdByUserId: TEST_USERS[0] });

    sharedRecruiterId = sharedRecruiter.id;
    const row = (await db.query.recruiters.findFirst({
      where: eq(recruiters.id, sharedRecruiter.id),
    }))!;

    // Viewer B (has sharing enabled)
    const publicViewForB = toPublicRecruiter(row, null, true, false);

    check(
      "public recruiter representation does NOT include createdByUserId",
      !("createdByUserId" in publicViewForB)
    );
    check(
      "public recruiter does not expose contributor identity",
      publicViewForB.myLink === null
    );
  }

  console.log("\n7. Credit-Based Contact Unlocking");
  {
    const db = await getDb();
    const sharedRecruiter = (await db.query.recruiters.findFirst({
      where: eq(recruiters.id, sharedRecruiterId),
    }))!;

    // 1. Viewer B before unlock: contact details locked
    const viewBeforeUnlock = toPublicRecruiter(sharedRecruiter, null, true, false);
    check("locked view hides email", viewBeforeUnlock.email === null);
    check("locked view hides linkedinUrl", viewBeforeUnlock.linkedinUrl === null);
    check("locked view indicates hasEmail is true", viewBeforeUnlock.hasEmail === true);
    check("locked view indicates piiUnlocked is false", viewBeforeUnlock.piiUnlocked === false);

    // 2. Record unlock in recruiterContactUnlocks (costs 1 credit = 10,000 micros)
    await db.insert(recruiterContactUnlocks).values({
      userId: TEST_USERS[1],
      recruiterId: sharedRecruiter.id,
      costCredits: 1,
    });

    const unlockedIds = await unlockedRecruiterIdsForViewer(TEST_USERS[1], [
      sharedRecruiter.id,
    ]);
    check(
      "unlockedRecruiterIdsForViewer identifies unlocked recruiter",
      unlockedIds.has(sharedRecruiter.id)
    );

    // 3. Viewer B after unlock: contact details revealed
    const viewAfterUnlock = toPublicRecruiter(sharedRecruiter, null, true, true);
    check(
      "unlocked view reveals email",
      viewAfterUnlock.email === sharedRecruiter.email
    );
    check(
      "unlocked view reveals piiUnlocked as true",
      viewAfterUnlock.piiUnlocked === true
    );

    // 4. Owner always has full access to their own logged link without credits
    const { link: ownerLink } = await ensureUserLink({
      userId: TEST_USERS[0],
      recruiterId: sharedRecruiter.id,
      email: "owner-direct@test.com",
    });
    const ownerView = toPublicRecruiter(sharedRecruiter, ownerLink, false, false);
    check("owner view always has piiUnlocked: true", ownerView.piiUnlocked === true);
    check(
      "owner view sees their own email directly",
      ownerView.email === "owner-direct@test.com"
    );
  }

  await cleanup();

  if (failures > 0) {
    console.error(`\n${failures} checks failed!`);
    process.exit(1);
  } else {
    console.log("\nAll redesigned recruiter checks passed successfully!");
  }
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
