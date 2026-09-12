/**
 * Guards the one thing materializing closeness could silently break: agreement with the
 * live formula.
 *
 * Closeness is stored now rather than computed per request, and the distribution it is
 * applied against is stored as a fixed-size quantile sketch instead of every raw score. If
 * that sketch loses fidelity, contacts drift between orbit rings — and the failure is
 * invisible, because a wrong ring still looks like a ring.
 *
 * Run: npx tsx scripts/smoke-closeness-materialized.ts
 */
import {
  applyClosenessCohort,
  buildClosenessCohort,
  computeRawCloseness,
  type ClosenessContact,
} from "../src/lib/closeness";
import {
  buildSnapshot,
  cohortFromSnapshot,
  isUsableSnapshot,
  SKETCH_POINTS,
} from "../src/lib/closeness-materialize";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const DAY = 24 * 60 * 60 * 1000;

/** A network with enough spread to produce a real distribution rather than a spike. */
function syntheticNetwork(n: number): ClosenessContact[] {
  const out: ClosenessContact[] = [];
  for (let i = 0; i < n; i++) {
    // Deterministic but uneven, so the distribution has a shape worth sketching.
    const r = ((i * 2654435761) % 100000) / 100000;
    const interacted = r > 0.45;
    out.push({
      relationshipScore: 1 + Math.floor(r * 5),
      statedCloseness: r > 0.8 ? 1 + Math.floor(r * 5) : null,
      hasLoggedInteraction: interacted,
      lastInteractionAt: interacted ? new Date(Date.now() - r * 400 * DAY) : null,
      firstInteractionAt: interacted ? new Date(Date.now() - (400 + r * 800) * DAY) : null,
      dateMet: new Date(Date.now() - (100 + r * 1500) * DAY),
      createdAt: new Date(Date.now() - (10 + r * 900) * DAY),
      company: r > 0.2 ? `Company ${i % 40}` : null,
      title: r > 0.35 ? `Title ${i % 25}` : null,
      industry: r > 0.5 ? `Industry ${i % 9}` : null,
      howMet: r > 0.7 ? "conference" : null,
      aiSummary: r > 0.55 ? "a short summary of this person" : null,
      keyFacts: r > 0.65 ? ["one fact", "another fact"] : [],
      sharedInterests: r > 0.75 ? ["sailing"] : [],
      notes: null,
      tags: r > 0.85 ? ["mentor"] : [],
      emailDomainMatchesUser: r > 0.95,
      companyConcentration: r,
      schoolConcentration: 1 - r,
      coveredByConnectedSource: r > 0.4,
    });
  }
  return out;
}

for (const n of [12, 200, 1000, 5000, 20000]) {
  console.log(`\nnetwork of ${n}`);
  const network = syntheticNetwork(n);
  const raws = network.map((c, i) => computeRawCloseness(c, ["find a cofounder"], i % 7));

  const liveCohort = buildClosenessCohort(raws);
  const snapshot = buildSnapshot(liveCohort, raws.reduce((s, r) => s + r.raw, 0) / raws.length, {
    maxCompany: 40,
    maxSchool: 12,
    userDomain: null,
    mailConnected: true,
  });
  const storedCohort = cohortFromSnapshot(snapshot);

  check("snapshot reads as usable", isUsableSnapshot(snapshot));
  check(
    `snapshot stays bounded (${snapshot.quantiles.length} points)`,
    snapshot.quantiles.length <= SKETCH_POINTS,
    `got ${snapshot.quantiles.length}`
  );
  check(
    "snapshot is exact below the sketch threshold",
    liveCohort.sortedRaw.length > SKETCH_POINTS ||
      snapshot.quantiles.length === liveCohort.sortedRaw.length
  );

  let tierMismatch = 0;
  let ringMismatch = 0;
  let worstCloseness = 0;
  for (const raw of raws) {
    const live = applyClosenessCohort(raw, liveCohort);
    const stored = applyClosenessCohort(raw, storedCohort);
    if (live.tier !== stored.tier) tierMismatch++;
    if (live.orbitScore !== stored.orbitScore) ringMismatch++;
    worstCloseness = Math.max(worstCloseness, Math.abs(live.closeness - stored.closeness));
  }

  const tierRate = tierMismatch / raws.length;
  const ringRate = ringMismatch / raws.length;
  // A sketch of 401 points resolves percentile to ~0.25%, so only contacts sitting within
  // that of a cutoff can move. Anything beyond a small fraction of a percent means the
  // sketch is losing the shape of the distribution, not just rounding at the boundary.
  check(
    `tier agrees with the live cohort (${tierMismatch}/${raws.length})`,
    tierRate <= 0.005,
    `${(tierRate * 100).toFixed(2)}% disagreed`
  );
  check(
    `orbit ring agrees with the live cohort (${ringMismatch}/${raws.length})`,
    ringRate <= 0.005,
    `${(ringRate * 100).toFixed(2)}% disagreed`
  );
  check(
    `closeness within 0.01 (worst ${worstCloseness.toFixed(4)})`,
    worstCloseness <= 0.01
  );
}

// A cohort nobody has evidence for must not start handing out inner rings.
console.log("\ndegenerate cohorts");
const coldRaws = syntheticNetwork(30).map((c) =>
  computeRawCloseness({ ...c, hasLoggedInteraction: false, statedCloseness: null }, [], 0)
);
const coldCohort = buildClosenessCohort(coldRaws);
const coldSnapshot = buildSnapshot(coldCohort, 0, {
  maxCompany: 1,
  maxSchool: 1,
  userDomain: null,
  mailConnected: false,
});
check(
  "a cold network still round-trips",
  applyClosenessCohort(coldRaws[0], cohortFromSnapshot(coldSnapshot)).tier ===
    applyClosenessCohort(coldRaws[0], coldCohort).tier
);
check("an empty snapshot is rejected", !isUsableSnapshot({
  n: 0, evidencedN: 0, coverage: 0, relativeWeight: 0, quantiles: [],
  averageRaw: 0, maxCompany: 1, maxSchool: 1, userDomain: null, mailConnected: false,
}));

console.log(failures === 0 ? "\nall checks passed\n" : `\n${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
