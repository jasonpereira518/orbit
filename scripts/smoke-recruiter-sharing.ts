/**
 * Exercises the recruiter sharing/reciprocity boundary against a real DB.
 *
 * The rule under test: a private user contributes nothing and sees nothing but their
 * own links; a sharing user sees the pool and puts their own links into it. Every
 * assertion here is a privacy boundary, so a failure means data is leaking.
 *
 * Writes rows under clearly-namespaced synthetic user ids and removes them in a
 * finally block. Do NOT run this while `next dev` holds `.data/pglite` — PGlite is
 * single-writer and the writes will be silently lost.
 *
 * Run: npx tsx scripts/smoke-recruiter-sharing.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { recruiters, userRecruiterLinks, userSettings } from "../src/db/schema";
import {
  isViewerSharing,
  listPoolDiscoveries,
  pooledRecruiterIds,
  recomputeRecruiterRating,
  resweepUserRatings,
  searchCanonicalRecruiters,
  toPublicRecruiter,
  upsertCanonicalRecruiter,
} from "../src/lib/recruiters";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) {
    throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  }
  console.log(`  ok  ${label}`);
}

const USER_A = "smoke-share-a";
const USER_B = "smoke-share-b";
const MARK = "ZZSmokeShare";

async function setSharing(userId: string, on: boolean) {
  const db = await getDb();
  await db
    .update(userSettings)
    .set({ recruiterSharing: on ? 1 : 0, updatedAt: new Date() })
    .where(eq(userSettings.userId, userId));
  await resweepUserRatings(userId);
}

async function visibleIds(userId: string) {
  const rows = await searchCanonicalRecruiters({
    q: MARK,
    limit: 50,
    viewerUserId: userId,
    viewerIsSharing: await isViewerSharing(userId),
  });
  return new Set(rows.map((r) => r.id));
}

async function cleanup(recruiterIds: string[]) {
  const db = await getDb();
  await db
    .delete(userRecruiterLinks)
    .where(inArray(userRecruiterLinks.userId, [USER_A, USER_B]));
  if (recruiterIds.length > 0) {
    await db.delete(recruiters).where(inArray(recruiters.id, recruiterIds));
  }
  await db
    .delete(userSettings)
    .where(inArray(userSettings.userId, [USER_A, USER_B]));
}

async function main() {
  const db = await getDb();
  const created: string[] = [];

  try {
    // Clean slate in case a previous run died mid-way.
    await cleanup([]);
    const stale = await db.query.recruiters.findMany({
      where: eq(recruiters.firm, MARK),
    });
    if (stale.length > 0) {
      await db.delete(recruiters).where(
        inArray(recruiters.id, stale.map((r) => r.id))
      );
    }

    for (const userId of [USER_A, USER_B]) {
      await db.insert(userSettings).values({ userId, recruiterSharing: 0 });
    }

    const recA = await upsertCanonicalRecruiter({
      fullName: `${MARK} Alpha`,
      firm: MARK,
      email: "alpha@zzsmokeshare.test",
    });
    const recB = await upsertCanonicalRecruiter({
      fullName: `${MARK} Beta`,
      firm: MARK,
      email: "beta@zzsmokeshare.test",
    });
    created.push(recA.id, recB.id);

    await db.insert(userRecruiterLinks).values({
      userId: USER_A,
      recruiterId: recA.id,
      personalRating: 5,
      status: "contacted",
    });
    await db.insert(userRecruiterLinks).values({
      userId: USER_B,
      recruiterId: recB.id,
      personalRating: 3,
      status: "contacted",
    });
    await recomputeRecruiterRating(recA.id);
    await recomputeRecruiterRating(recB.id);

    console.log("\nboth private");
    let a = await visibleIds(USER_A);
    let b = await visibleIds(USER_B);
    check("A sees only its own", a.has(recA.id) && !a.has(recB.id));
    check("B sees only its own", b.has(recB.id) && !b.has(recA.id));
    check(
      "private rating excluded from public aggregate",
      (await db.query.recruiters.findFirst({ where: eq(recruiters.id, recA.id) }))
        ?.ratingCount === 0
    );
    check(
      "no discoveries for a private viewer",
      (await listPoolDiscoveries({ viewerUserId: USER_A, viewerIsSharing: false }))
        .length === 0
    );

    console.log("\nA sharing, B private");
    await setSharing(USER_A, true);
    a = await visibleIds(USER_A);
    b = await visibleIds(USER_B);
    check("A still sees only its own (B contributes nothing)", a.has(recA.id) && !a.has(recB.id));
    check("B sees only its own", b.has(recB.id) && !b.has(recA.id));
    check(
      "A's rating now counts publicly",
      (await db.query.recruiters.findFirst({ where: eq(recruiters.id, recA.id) }))
        ?.ratingCount === 1
    );

    console.log("\nboth sharing");
    await setSharing(USER_B, true);
    a = await visibleIds(USER_A);
    b = await visibleIds(USER_B);
    check("A sees both", a.has(recA.id) && a.has(recB.id));
    check("B sees both", b.has(recA.id) && b.has(recB.id));

    const pooled = await pooledRecruiterIds([recA.id, recB.id]);
    check("both are pooled", pooled.has(recA.id) && pooled.has(recB.id));

    const shaped = toPublicRecruiter(
      (await db.query.recruiters.findFirst({ where: eq(recruiters.id, recB.id) }))!,
      null,
      true
    );
    check("pool viewer gets contact details", shaped.email === "beta@zzsmokeshare.test");
    check("pool viewer gets no link", shaped.myLink === null);

    const locked = toPublicRecruiter(
      (await db.query.recruiters.findFirst({ where: eq(recruiters.id, recB.id) }))!,
      null,
      false
    );
    check("non-pool viewer gets no contact details", locked.email === null);

    const discoveries = await listPoolDiscoveries({
      viewerUserId: USER_A,
      viewerIsSharing: true,
    });
    const discoveryIds = new Set(discoveries.map((r) => r.id));
    check(
      "discover shows B's recruiter but not A's own",
      discoveryIds.has(recB.id) && !discoveryIds.has(recA.id)
    );

    console.log("\nper-link exclusion");
    await db
      .update(userRecruiterLinks)
      .set({ sharedToPool: 0 })
      .where(
        and(
          eq(userRecruiterLinks.userId, USER_B),
          eq(userRecruiterLinks.recruiterId, recB.id)
        )
      );
    await recomputeRecruiterRating(recB.id);
    a = await visibleIds(USER_A);
    b = await visibleIds(USER_B);
    check("excluded recruiter hidden from others", !a.has(recB.id));
    check("excluded recruiter still visible to its owner", b.has(recB.id));
    check(
      "excluded rating dropped from public aggregate",
      (await db.query.recruiters.findFirst({ where: eq(recruiters.id, recB.id) }))
        ?.ratingCount === 0
    );

    // Restore for the opt-out test.
    await db
      .update(userRecruiterLinks)
      .set({ sharedToPool: 1 })
      .where(eq(userRecruiterLinks.userId, USER_B));
    await recomputeRecruiterRating(recB.id);

    console.log("\nA opts back out");
    await setSharing(USER_A, false);
    a = await visibleIds(USER_A);
    b = await visibleIds(USER_B);
    check("A loses the pool immediately", a.has(recA.id) && !a.has(recB.id));
    check("B loses A's contribution immediately", b.has(recB.id) && !b.has(recA.id));
    check(
      "A's rating withdrawn from public aggregate",
      (await db.query.recruiters.findFirst({ where: eq(recruiters.id, recA.id) }))
        ?.ratingCount === 0
    );

    console.log("\nall recruiter sharing checks passed");
  } finally {
    await cleanup(created);
    console.log("cleaned up synthetic rows");
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
