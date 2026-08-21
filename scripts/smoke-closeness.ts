/**
 * Exercises the closeness formula and its cohort normalization. No DB, no network.
 * Run: npx tsx scripts/smoke-closeness.ts
 */

import {
  applyClosenessCohort,
  buildClosenessCohort,
  closenessTier,
  cohortPercentile,
  computeClosenessForAll,
  computeRawCloseness,
  recencyComponent,
  type ClosenessContact,
  type RawClosenessBreakdown,
} from "../src/lib/closeness";
import {
  computeEvidence,
  computePrior,
  EVIDENCE_FLOOR,
  PRIOR_MAX,
  PRIOR_MIN,
  publicEmailDomain,
} from "../src/lib/closeness-evidence";
import { selectTriageCandidates } from "../src/lib/triage-candidates";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) {
    throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  }
  console.log(`  ok  ${label}`);
}

const DAY = 24 * 60 * 60 * 1000;
const daysAgoDate = (d: number) => new Date(Date.now() - d * DAY);

/** Prints a 10-bin distribution histogram of values in [0,1]. */
function histogram(xs: number[], label: string) {
  const bins = new Array(10).fill(0);
  for (const x of xs) bins[Math.min(9, Math.floor(x * 10))] += 1;
  console.log(`\n  ${label}`);
  bins.forEach((count, i) => {
    const bar = "█".repeat(Math.round((count / xs.length) * 60));
    console.log(
      `    ${String(i * 10).padStart(3)}–${String(i * 10 + 10).padStart(3)}% ${bar} ${count}`
    );
  });
}

function person(
  over: Partial<ClosenessContact> & { id?: string } = {}
): ClosenessContact & { id: string } {
  return {
    id: "c0",
    relationshipScore: 3,
    statedCloseness: 3,
    lastInteractionAt: daysAgoDate(30),
    createdAt: daysAgoDate(400),
    dateMet: null,
    firstInteractionAt: null,
    coveredByConnectedSource: false,
    company: "Acme",
    title: "Engineer",
    industry: null,
    howMet: null,
    notes: null,
    aiSummary: null,
    keyFacts: null,
    sharedInterests: null,
    tags: null,
    ...over,
  };
}

/** The pre-change formula, kept here purely to compare distributions. */
function legacyCloseness(c: ClosenessContact, goals: string[] = []) {
  const s = Math.min(5, Math.max(1, c.relationshipScore || 2)) / 5;
  const ref = c.lastInteractionAt || c.createdAt;
  const days = ref
    ? Math.floor((Date.now() - new Date(ref).getTime()) / DAY)
    : null;
  const recency = days === null ? 0.15 : days <= 0 ? 1 : Math.exp(-days / 45);
  return Math.min(1, Math.max(0, 0.4 * s + 0.4 * recency + 0.2 * (goals.length ? 0 : 0)));
}

console.log("\n1. Component monotonicity");
{
  const base = person();
  const raw = (over: Partial<ClosenessContact>, touches = 0) =>
    computeRawCloseness({ ...base, ...over }, [], touches).raw;

  check(
    "more recent scores higher",
    raw({ lastInteractionAt: daysAgoDate(5) }) >
      raw({ lastInteractionAt: daysAgoDate(200) })
  );
  check(
    "more frequent scores higher",
    raw({}, 10) > raw({}, 1),
    `${raw({}, 10)} vs ${raw({}, 1)}`
  );
  check(
    // strengthComponent now prefers statedCloseness over relationshipScore
    // (Task 5); the fixture's fixed statedCloseness default means overriding
    // relationshipScore alone no longer moves this component.
    "higher strength scores higher",
    raw({ statedCloseness: 5 }) > raw({ statedCloseness: 1 })
  );
  check(
    // The legacy fallback: contacts written before stated_closeness existed
    // have statedCloseness null and must still rank by relationshipScore.
    "legacy contacts still rank by relationshipScore",
    raw({ statedCloseness: null, relationshipScore: 5 }) >
      raw({ statedCloseness: null, relationshipScore: 1 })
  );
  check(
    "cadence has diminishing returns",
    raw({}, 2) - raw({}, 1) > raw({}, 12) - raw({}, 11)
  );
}

console.log("\n2. The long tail stays separable");
{
  const a = computeRawCloseness(
    person({ lastInteractionAt: daysAgoDate(400) }),
    [],
    0
  ).raw;
  const b = computeRawCloseness(
    person({ lastInteractionAt: daysAgoDate(700) }),
    [],
    0
  ).raw;
  check("400d and 700d idle still rank apart", a > b, `${a} vs ${b}`);
  check(
    "the gap survives float rounding",
    a - b > 1e-6,
    `gap ${(a - b).toExponential(2)}`
  );

  // The specific regression this replaced: exp(-d/45) has flattened out here,
  // so the old scores differ only far below anything the UI could show.
  const legacyHi = legacyCloseness(person({ lastInteractionAt: daysAgoDate(400) }));
  const legacyLo = legacyCloseness(person({ lastInteractionAt: daysAgoDate(700) }));
  const legacyGap = legacyHi - legacyLo;
  check(
    "old formula rendered them as the same percentage",
    Math.round(legacyHi * 100) === Math.round(legacyLo * 100),
    `${Math.round(legacyHi * 100)}% vs ${Math.round(legacyLo * 100)}%`
  );
  check(
    "new formula separates them by orders of magnitude more",
    a - b > legacyGap * 100,
    `new ${(a - b).toExponential(2)} vs old ${legacyGap.toExponential(2)}`
  );
}

console.log("\n3. Cold start falls back to absolute scoring");
{
  const five = Array.from({ length: 5 }, (_, i) =>
    person({ id: `c${i}`, relationshipScore: ((i % 5) + 1) as number })
  );
  const scored = computeClosenessForAll(five, []);
  for (const c of five) {
    const got = scored.get(c.id)!;
    const raw = computeRawCloseness(c, [], 0).raw;
    check(
      `  N=5 contact ${c.id} is pure absolute`,
      Math.abs(got.closeness - raw) < 1e-12
    );
  }

  const cohort = buildClosenessCohort(five.map((c) => computeRawCloseness(c, [], 0)));
  check("  relative weight is 0 below 8 contacts", cohort.relativeWeight === 0);

  const many = Array.from({ length: 60 }, (_, i) =>
    person({ id: `c${i}`, relationshipScore: (i % 5) + 1 })
  );
  const bigCohort = buildClosenessCohort(
    many.map((c) => computeRawCloseness(c, [], 0))
  );
  check(
    "  relative weight reaches 0.5 at 40+",
    Math.abs(bigCohort.relativeWeight - 0.5) < 1e-12
  );

  const midContacts = Array.from({ length: 24 }, (_, i) =>
    computeRawCloseness(
      person({
        id: `m${i}`,
        statedCloseness: (i % 5) + 1,
        lastInteractionAt: daysAgoDate(i * 5),
      }),
      [],
      2
    )
  );
  const mid = buildClosenessCohort(midContacts);
  check(
    "  relative weight ramps in between",
    mid.relativeWeight > 0 && mid.relativeWeight < 0.5,
    String(mid.relativeWeight)
  );
}

console.log("\n4. Rings honour their quotas");
{
  const n = 200;
  const people = Array.from({ length: n }, (_, i) =>
    person({
      id: `c${i}`,
      relationshipScore: (i % 5) + 1,
      lastInteractionAt: daysAgoDate((i * 7) % 600),
    })
  );
  const scored = computeClosenessForAll(people, [], new Map(
    people.map((p, i) => [p.id, i % 9])
  ));

  const counts = [0, 0, 0, 0, 0, 0];
  for (const b of scored.values()) counts[b.orbitScore] += 1;

  const expected = { 5: 0.08, 4: 0.14, 3: 0.22, 2: 0.26, 1: 0.3 };
  for (const ring of [5, 4, 3, 2, 1] as const) {
    const share = counts[ring] / n;
    check(
      `  ring ${ring} ≈ ${Math.round(expected[ring] * 100)}% (got ${Math.round(share * 100)}%)`,
      Math.abs(share - expected[ring]) <= 0.03
    );
  }
  check("  every ring is populated", counts.slice(1).every((c) => c > 0));
}

console.log("\n5. Spread beats the old formula");
{
  // A realistic orbit: most people are idle, a few are active.
  const n = 300;
  const people = Array.from({ length: n }, (_, i) => {
    const idle = i < n * 0.7 ? 90 + ((i * 13) % 500) : (i * 3) % 60;
    return person({
      id: `c${i}`,
      relationshipScore: (i % 5) + 1,
      lastInteractionAt: daysAgoDate(idle),
    });
  });
  const touches = new Map(people.map((p, i) => [p.id, i < n * 0.7 ? i % 3 : 4 + (i % 8)]));
  const scored = computeClosenessForAll(people, [], touches);

  const iqr = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    const q = (f: number) => s[Math.floor(f * (s.length - 1))];
    return q(0.75) - q(0.25);
  };

  const newVals = [...scored.values()].map((b) => b.closeness);
  const oldVals = people.map((p) => legacyCloseness(p));

  histogram(oldVals, "old formula");
  histogram(newVals, "new formula");

  console.log(
    `\n  IQR: old ${iqr(oldVals).toFixed(3)} → new ${iqr(newVals).toFixed(3)}`
  );
  check("  spread is materially wider", iqr(newVals) > iqr(oldVals) * 1.5);
  check("  the top of the scale is reachable", Math.max(...newVals) > 0.8);
  check(
    "  nothing pins to 0 or 1",
    Math.min(...newVals) > 0 && Math.max(...newVals) < 1
  );
}

console.log("\n6. No active goals renormalizes instead of penalizing");
{
  const best = person({
    statedCloseness: 5,
    relationshipScore: 5,
    lastInteractionAt: new Date(),
  });
  const noGoals = computeRawCloseness(best, [], 50).raw;
  check(
    "  a perfect contact reaches 1.0 with no goals set",
    Math.abs(noGoals - 1) < 1e-9,
    String(noGoals)
  );

  const withGoals = computeRawCloseness(best, ["acme integrations"], 50).raw;
  check("  and still reaches 1.0 when the goal matches", Math.abs(withGoals - 1) < 1e-9);

  // Ordering between contacts must not depend on whether goals exist.
  const pair = [
    person({ id: "a", relationshipScore: 5, lastInteractionAt: daysAgoDate(3) }),
    person({ id: "b", relationshipScore: 2, lastInteractionAt: daysAgoDate(200) }),
  ];
  const orderNoGoals =
    computeRawCloseness(pair[0], [], 5).raw > computeRawCloseness(pair[1], [], 1).raw;
  const orderGoals =
    computeRawCloseness(pair[0], ["zzz unrelated"], 5).raw >
    computeRawCloseness(pair[1], ["zzz unrelated"], 1).raw;
  check("  relative ordering is unchanged by goals", orderNoGoals === orderGoals);
}

console.log("\n7. Ties resolve identically");
{
  const twins = [
    person({ id: "t1", relationshipScore: 4, lastInteractionAt: daysAgoDate(10) }),
    person({ id: "t2", relationshipScore: 4, lastInteractionAt: daysAgoDate(10) }),
  ];
  const others = Array.from({ length: 40 }, (_, i) =>
    person({ id: `o${i}`, relationshipScore: (i % 5) + 1, lastInteractionAt: daysAgoDate(i * 5) })
  );
  const scored = computeClosenessForAll([...twins, ...others], [], new Map());
  const a = scored.get("t1")!;
  const b = scored.get("t2")!;
  check("  identical contacts share a percentile", a.percentile === b.percentile);
  check("  identical contacts share a ring", a.orbitScore === b.orbitScore);
  check("  identical contacts share a tier", a.tier === b.tier);

  // [0.2, 0.4, 0.4, 0.4, 0.9] — the tie block spans indices 1..3, so its
  // midrank sits at index 2 of 5. Fully evidenced so all five clear the floor
  // and land in the distribution unchanged.
  const asFullyEvidenced = (raw: number): RawClosenessBreakdown => ({
    raw,
    strength: raw,
    recency: raw,
    cadence: raw,
    goalRelevance: 0,
    evidence: 1,
    prior: raw,
    evidenced: raw,
  });
  const cohort = buildClosenessCohort(
    [0.2, 0.4, 0.4, 0.4, 0.9].map(asFullyEvidenced)
  );
  check(
    "  midrank puts a 3-way tie at its centre",
    Math.abs(cohortPercentile(0.4, cohort) - 0.5) < 1e-12,
    String(cohortPercentile(0.4, cohort))
  );
  check(
    "  nobody lands on an exact 0 or 1",
    cohortPercentile(0.2, cohort) > 0 && cohortPercentile(0.9, cohort) < 1
  );
}

console.log("\n8. Absolute tier still tracks network health");
{
  // The dashboard counts inner ties by raw score, so a cold network must show it.
  const healthy = Array.from({ length: 50 }, (_, i) =>
    person({ id: `h${i}`, relationshipScore: 4, lastInteractionAt: daysAgoDate(i % 20) })
  );
  const cold = Array.from({ length: 50 }, (_, i) =>
    person({ id: `c${i}`, relationshipScore: 2, lastInteractionAt: daysAgoDate(300 + i) })
  );

  const rawInner = (people: Array<ClosenessContact & { id: string }>, touches: number) =>
    people.filter(
      (p) => closenessTier(computeRawCloseness(p, [], touches).raw) === "inner"
    ).length;

  check(
    "  healthy network has inner ties",
    rawInner(healthy, 8) > 0,
    String(rawInner(healthy, 8))
  );
  check(
    "  cold network has none",
    rawInner(cold, 0) === 0,
    String(rawInner(cold, 0))
  );

  // Quota tiers, by contrast, are a fixed share — which is why the dashboard
  // must not count those.
  const quotaInner = [...computeClosenessForAll(cold, []).values()].filter(
    (b) => b.tier === "inner"
  ).length;
  check(
    "  quota tiers still fill in a cold network",
    quotaInner > 0,
    String(quotaInner)
  );
}

console.log("\n9. Cohort application is self-consistent");
{
  const people = Array.from({ length: 30 }, (_, i) =>
    person({ id: `c${i}`, relationshipScore: (i % 5) + 1, lastInteractionAt: daysAgoDate(i * 11) })
  );
  const raws = people.map((p) => computeRawCloseness(p, [], 0));
  const cohort = buildClosenessCohort(raws);

  const byBatch = computeClosenessForAll(people, []);
  people.forEach((p, i) => {
    const direct = applyClosenessCohort(raws[i], cohort);
    const batch = byBatch.get(p.id)!;
    check(
      `  batch matches direct for ${p.id}`,
      Math.abs(direct.closeness - batch.closeness) < 1e-12 &&
        direct.orbitScore === batch.orbitScore
    );
  });

  // Rank order must survive the blend.
  const sorted = [...byBatch.entries()].sort(
    (a, b) => b[1].closeness - a[1].closeness
  );
  for (let i = 1; i < sorted.length; i++) {
    const hi = sorted[i - 1][1];
    const lo = sorted[i][1];
    check(
      `  ring is monotonic at position ${i}`,
      hi.orbitScore >= lo.orbitScore
    );
  }
}

console.log("\n10. Creation time is not a conversation");
{
  const justImported = person({
    lastInteractionAt: null,
    createdAt: new Date(),
  });
  const r = recencyComponent(justImported.lastInteractionAt);
  check(
    "  a never-contacted import does not score as fresh",
    r < 0.2,
    String(r)
  );

  // Two contacts imported in the same batch, one of whom you have actually
  // spoken to. The spoken-to one must win decisively.
  const spoken = computeRawCloseness(
    person({ lastInteractionAt: daysAgoDate(10), createdAt: new Date() }),
    [],
    3
  ).raw;
  const silent = computeRawCloseness(
    person({ lastInteractionAt: null, createdAt: new Date() }),
    [],
    0
  ).raw;
  check("  a real touch beats a fresh import", spoken > silent, `${spoken} vs ${silent}`);
  check("  and by a visible margin", spoken - silent > 0.2, String(spoken - silent));
}

console.log("\n11. Evidence reflects what we actually know");
{
  const none = computeEvidence({});
  check("  a bare import has no evidence", none === 0, String(none));

  const rated = computeEvidence({ statedCloseness: 4 });
  check(
    "  a user rating clears the floor on its own",
    rated >= EVIDENCE_FLOOR,
    String(rated)
  );

  const oneTouch = computeEvidence({ touchCount: 1, hasLoggedInteraction: true });
  const manyTouches = computeEvidence({ touchCount: 20, hasLoggedInteraction: true });
  check("  interactions accumulate evidence", manyTouches > oneTouch);
  check(
    "  interaction evidence saturates below 1",
    manyTouches < 1,
    String(manyTouches)
  );

  const coverageOnly = computeEvidence({ coveredByConnectedSource: true });
  check(
    "  mere source coverage does not clear the floor",
    coverageOnly < EVIDENCE_FLOOR,
    String(coverageOnly)
  );

  const everything = computeEvidence({
    statedCloseness: 5,
    touchCount: 30,
    hasLoggedInteraction: true,
    coveredByConnectedSource: true,
  });
  check("  full evidence reaches 1", Math.abs(everything - 1) < 1e-9, String(everything));

  check(
    "  evidence is monotonic in touches",
    [0, 1, 3, 8, 20].every((n, i, arr) =>
      i === 0
        ? true
        : computeEvidence({ touchCount: n, hasLoggedInteraction: true }) >=
          computeEvidence({ touchCount: arr[i - 1], hasLoggedInteraction: true })
    )
  );

  const nanTouches = computeEvidence({ touchCount: NaN, hasLoggedInteraction: true });
  check(
    "  a NaN touch count does not escape [0,1]",
    nanTouches >= 0 && nanTouches <= 1,
    String(nanTouches)
  );

  const infiniteTouches = computeEvidence({
    touchCount: Infinity,
    hasLoggedInteraction: true,
  });
  check(
    "  an infinite touch count does not escape [0,1]",
    infiniteTouches >= 0 && infiniteTouches <= 1,
    String(infiniteTouches)
  );
}

console.log("\n12. The prior orders without over-claiming");
{
  const bare = computePrior({});
  check(
    "  a bare contact sits inside the compressed band",
    bare >= PRIOR_MIN && bare <= PRIOR_MAX,
    String(bare)
  );

  const best = computePrior({
    firstInteractionAt: daysAgoDate(3000),
    emailDomainMatchesUser: true,
    companyConcentration: 1,
    schoolConcentration: 1,
    goalRelevance: 1,
  });
  check(
    "  even a maximal prior cannot exceed the band",
    best <= PRIOR_MAX,
    String(best)
  );
  check("  a maximal prior still beats a bare one", best > bare);

  const colleague = computePrior({ emailDomainMatchesUser: true });
  check("  a shared work domain is affinity", colleague > bare);

  const older = computePrior({ firstInteractionAt: daysAgoDate(2000) });
  const newer = computePrior({ firstInteractionAt: daysAgoDate(30) });
  check("  a longstanding connection outranks a brand-new one", older > newer);

  check("  gmail.com is not a shared workplace", publicEmailDomain("gmail.com"));
  check("  a company domain is", !publicEmailDomain("acme.io"));

  const nanCompany = computePrior({ companyConcentration: NaN });
  check(
    "  a NaN company concentration does not escape the band",
    nanCompany >= PRIOR_MIN && nanCompany <= PRIOR_MAX,
    String(nanCompany)
  );

  const nanSchool = computePrior({ schoolConcentration: NaN });
  check(
    "  a NaN school concentration does not escape the band",
    nanSchool >= PRIOR_MIN && nanSchool <= PRIOR_MAX,
    String(nanSchool)
  );

  const nanGoal = computePrior({ goalRelevance: NaN });
  check(
    "  a NaN goal relevance does not escape the band",
    nanGoal >= PRIOR_MIN && nanGoal <= PRIOR_MAX,
    String(nanGoal)
  );

  const infiniteCompany = computePrior({ companyConcentration: Infinity });
  check(
    "  an infinite company concentration does not escape the band",
    infiniteCompany >= PRIOR_MIN && infiniteCompany <= PRIOR_MAX,
    String(infiniteCompany)
  );
}

console.log("\n13. The blend decays toward real evidence");
{
  // Warm-orbit regression: at full evidence the blend must be a no-op.
  const warm = person({
    statedCloseness: 5,
    relationshipScore: 5,
    lastInteractionAt: daysAgoDate(2),
  });
  const blended = computeRawCloseness(warm, [], 30);
  check(
    "  full evidence reproduces the evidenced score exactly",
    Math.abs(blended.raw - blended.evidenced) < 1e-9,
    `${blended.raw} vs ${blended.evidenced}`
  );
  check("  and evidence really is 1", Math.abs(blended.evidence - 1) < 1e-9);

  // Cold contact: the prior should dominate.
  const cold = computeRawCloseness(
    person({ statedCloseness: null, lastInteractionAt: null }),
    [],
    0
  );
  check("  a bare contact has no evidence", cold.evidence === 0, String(cold.evidence));
  check(
    "  so its score is exactly its prior",
    Math.abs(cold.raw - cold.prior) < 1e-9,
    `${cold.raw} vs ${cold.prior}`
  );

  // Monotone decay: as touches accumulate, the prior's influence shrinks.
  const priorShare = (touches: number) => {
    const b = computeRawCloseness(
      person({ statedCloseness: null, lastInteractionAt: daysAgoDate(20) }),
      [],
      touches
    );
    return 1 - b.evidence;
  };
  const shares = [0, 1, 3, 8, 20].map(priorShare);
  check(
    "  the prior's weight falls monotonically as evidence arrives",
    shares.every((s, i) => i === 0 || s <= shares[i - 1]),
    shares.map((s) => s.toFixed(3)).join(" → ")
  );
}

console.log("\n14. Guesses cannot reach the inner rings");
{
  // 2000 contacts, nothing known about any of them.
  const coldOrbit = Array.from({ length: 2000 }, (_, i) =>
    person({
      id: `x${i}`,
      statedCloseness: null,
      relationshipScore: 2,
      lastInteractionAt: null,
      createdAt: daysAgoDate(1),
      dateMet: daysAgoDate((i * 37) % 2500),
    })
  );
  const scored = computeClosenessForAll(coldOrbit, []);
  const rings = [0, 0, 0, 0, 0, 0];
  for (const b of scored.values()) rings[b.orbitScore] += 1;

  check(
    "  a pure cold import places nobody in Core or Inner",
    rings[5] === 0 && rings[4] === 0,
    `ring5=${rings[5]} ring4=${rings[4]}`
  );
  check(
    "  but the orbit is not one undifferentiated blob",
    rings.slice(1, 4).filter((c) => c > 0).length >= 2,
    rings.join(",")
  );

  // Not merely asserted: print the shape so a day-one orbit can be inspected
  // directly, not just checked against a threshold.
  histogram(
    [...scored.values()].map((b) => b.closeness),
    "cold orbit (2,000 contacts, no evidence)"
  );
  console.log(
    `\n  rings: 1=${rings[1]} 2=${rings[2]} 3=${rings[3]} 4=${rings[4]} 5=${rings[5]}`
  );
}

console.log("\n15. Coverage does not masquerade as closeness");
{
  // 200 contacts with real Gmail-style history, 1800 with nothing.
  const covered = Array.from({ length: 200 }, (_, i) =>
    person({
      id: `k${i}`,
      statedCloseness: null,
      lastInteractionAt: daysAgoDate((i * 3) % 200),
      dateMet: daysAgoDate(800),
      coveredByConnectedSource: true,
    })
  );
  const uncovered = Array.from({ length: 1800 }, (_, i) =>
    person({
      id: `u${i}`,
      statedCloseness: null,
      lastInteractionAt: null,
      dateMet: daysAgoDate((i * 29) % 2500),
    })
  );
  const touches = new Map<string, number>([
    ...covered.map((c, i) => [c.id, 1 + (i % 6)] as [string, number]),
    ...uncovered.map((c) => [c.id, 0] as [string, number]),
  ]);
  const scored = computeClosenessForAll([...covered, ...uncovered], [], touches);

  const uncoveredScores = uncovered.map((c) => scored.get(c.id)!.closeness);
  const spread = Math.max(...uncoveredScores) - Math.min(...uncoveredScores);
  check(
    "  the uncovered 1800 are not all identical",
    spread > 0.01,
    `spread ${spread.toFixed(4)}`
  );

  const coveredRings = covered.map((c) => scored.get(c.id)!.orbitScore);
  check(
    "  covered contacts can earn inner rings",
    coveredRings.some((r) => r >= 4),
    `max ring ${Math.max(...coveredRings)}`
  );
}

console.log("\n16. Ranking uses the people we actually know");
{
  const known = Array.from({ length: 12 }, (_, i) =>
    computeRawCloseness(
      person({ id: `k${i}`, statedCloseness: (i % 5) + 1, lastInteractionAt: daysAgoDate(i * 4) }),
      [],
      3
    )
  );
  const unknown = Array.from({ length: 1988 }, () =>
    computeRawCloseness(
      person({ statedCloseness: null, lastInteractionAt: null }),
      [],
      0
    )
  );

  const cohort = buildClosenessCohort([...known, ...unknown]);
  check(
    "  the distribution holds only evidenced contacts",
    cohort.sortedRaw.length === 12,
    String(cohort.sortedRaw.length)
  );
  check(
    "  low coverage suppresses relative weighting",
    cohort.relativeWeight < 0.1,
    String(cohort.relativeWeight)
  );

  const allKnown = Array.from({ length: 60 }, (_, i) =>
    computeRawCloseness(
      person({ id: `a${i}`, statedCloseness: (i % 5) + 1, lastInteractionAt: daysAgoDate(i * 3) }),
      [],
      4
    )
  );
  const warmCohort = buildClosenessCohort(allKnown);
  check(
    "  full coverage restores relative weighting",
    Math.abs(warmCohort.relativeWeight - 0.5) < 1e-9,
    String(warmCohort.relativeWeight)
  );
  check("  and coverage reports as 1", Math.abs(warmCohort.coverage - 1) < 1e-9);
}

console.log("\n17. Triage asks about the people we cannot guess");
{
  const candidate = (
    id: string,
    evidence: number,
    prior: number,
    stated: number | null = null,
    company: string | null = "Acme"
  ) => ({ id, fullName: id, company, evidence, prior, statedCloseness: stated });

  // MegaCorp dominates raw headcount (300 people, prior 0.5) — exactly the
  // "whichever company dominates the orbit" case the diversity pass exists to
  // stop the shortlist collapsing onto. Each SoloCo holds exactly one person,
  // at a *lower* prior (0.45) than MegaCorp — so a plain prior-sort would
  // never reach any of them while 300 higher-ranked MegaCorp people remain.
  // If the fixture gave every candidate the same company (as an earlier
  // version of this test did), the diversity round-robin would run against a
  // single company and this test could pass even with that pass deleted.
  const SOLO_COMPANY_COUNT = 6;

  const pool = [
    ...Array.from({ length: 20 }, (_, i) => candidate(`known${i}`, 0.9, 0.4)),
    ...Array.from({ length: 300 }, (_, i) =>
      candidate(`mega${i}`, 0, 0.5, null, "MegaCorp")
    ),
    ...Array.from({ length: SOLO_COMPANY_COUNT }, (_, i) =>
      candidate(`solo${i}`, 0, 0.45, null, `SoloCo${i}`)
    ),
    ...Array.from({ length: 20 }, (_, i) => candidate(`rated${i}`, 0.9, 0.4, 4)),
  ];

  const picked = selectTriageCandidates(pool, 40);
  check("  the shortlist is capped", picked.length === 40, String(picked.length));
  check(
    "  already-rated contacts are never asked about again",
    picked.every((c) => c.statedCloseness == null)
  );
  check(
    "  high-prior unknowns are represented",
    picked.some((c) => c.id.startsWith("mega"))
  );
  check(
    "  high-evidence unrated contacts are represented",
    picked.some((c) => c.id.startsWith("known"))
  );
  check(
    "  the shortlist is not purely whoever we already know",
    picked.filter((c) => c.evidence >= EVIDENCE_FLOOR).length < picked.length,
    `${picked.filter((c) => c.evidence >= EVIDENCE_FLOOR).length}/${picked.length}`
  );
  check("  no duplicates", new Set(picked.map((c) => c.id)).size === picked.length);

  // The diversity pass's entire reason to exist: every single-person company
  // must show up, not just the 300-person employer that would otherwise fill
  // every remaining slot on prior alone. Without the round-robin this is 0/6
  // — confirmed by temporarily removing the diversity block and watching this
  // go red (see task-12-report.md).
  const soloCompaniesPicked = new Set(
    picked.filter((c) => c.id.startsWith("solo")).map((c) => c.id)
  );
  check(
    "  diversity reaches every single-person company, not just the dominant employer",
    soloCompaniesPicked.size === SOLO_COMPANY_COUNT,
    `${soloCompaniesPicked.size}/${SOLO_COMPANY_COUNT}`
  );
}

console.log("\nAll closeness smoke checks passed.\n");
