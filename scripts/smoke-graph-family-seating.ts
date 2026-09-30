/**
 * Do related companies sit together on the star map?
 *
 * Someone at Google DeepMind should be found beside Google, not a quarter-turn away or out on
 * the rim with everyone unclustered. Three ways that used to fail, each checked here:
 *
 *   - a lone DeepMind contact is not a constellation, so it was scattered across the rim;
 *   - a family could end up apart, landing its smaller member on the far side;
 *   - related clusters were placed by list order, not relatedness.
 *
 * The measure is relative, on a busy sky: the related star or cluster must be nearer Google
 * than almost every unrelated cluster is. No DB, no network.
 * Run: npx tsx scripts/smoke-graph-family-seating.ts
 */
import { buildClusterAffinity } from "../src/lib/constellation-affinity";
import { buildConstellationFit } from "../src/lib/constellation-fit";
import { buildHybridGraphLayout, type GraphContactInput } from "../src/lib/graph-layout";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

function contact(id: string, company: string | null): GraphContactInput {
  return {
    id,
    fullName: `Person ${id}`,
    company,
    title: null,
    relationshipScore: 3,
    lastInteractionAt: "2026-08-20T00:00:00.000Z",
    nextFollowUpAt: null,
    tags: [],
    aiSummary: null,
    keyFacts: null,
  };
}

function seat(unrelated: number) {
  const contacts: GraphContactInput[] = [];
  const add = (prefix: string, company: string | null, n: number) => {
    for (let i = 0; i < n; i++) contacts.push(contact(`${prefix}-${i}`, company));
  };
  // Unrelated employers of assorted sizes, so the sky is crowded. (Distinct first words: the
  // company-family fallback groups "Company 1", "Company 2"… into one family.)
  for (let i = 0; i < unrelated; i++) add(`co${i}`, `Employer${i} Labs`, 2 + ((i * 7) % 11));
  add("google", "Google", 12);
  add("gdm", "Google DeepMind", 3);
  // Not "DeepMind": that is an exact alias of Google DeepMind and would join its cluster.
  add("gcloud", "Google Cloud", 1);
  add("bank", "Bank of Nowhere", 1);
  add("loose", null, 40);

  const layout = buildHybridGraphLayout(contacts, "You");
  const pos = new Map(layout.nodes.map((n) => [n.id, n.position]));
  const centroid = (prefix: string) => {
    const ps = contacts.filter((c) => c.id.startsWith(`${prefix}-`)).map((c) => pos.get(c.id)!);
    return {
      x: ps.reduce((s, p) => s + p.x, 0) / ps.length,
      y: ps.reduce((s, p) => s + p.y, 0) / ps.length,
    };
  };
  const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.hypot(a.x - b.x, a.y - b.y);
  const radius = (id: string) => Math.hypot(pos.get(id)!.x, pos.get(id)!.y);

  const google = centroid("google");
  const nearestUnrelated = Math.min(
    ...Array.from({ length: unrelated }, (_, i) => dist(google, centroid(`co${i}`)))
  );

  console.log(`\n${unrelated} unrelated companies`);
  const gdm = dist(google, centroid("gdm"));
  check(
    "the Google DeepMind cluster is Google's nearest neighbour",
    gdm < nearestUnrelated,
    `DeepMind ${gdm.toFixed(0)} vs nearest unrelated ${nearestUnrelated.toFixed(0)}`
  );
  const lone = dist(google, pos.get("gcloud-0")!);
  check(
    "a lone Google Cloud contact sits in Google's field",
    lone < nearestUnrelated,
    `Google Cloud ${lone.toFixed(0)} vs nearest unrelated cluster ${nearestUnrelated.toFixed(0)}`
  );
  const haloFrom = layout.galaxy.diskRadius;
  check(
    "and not out in the halo with the unclustered",
    radius("gcloud-0") < haloFrom,
    `radius ${radius("gcloud-0").toFixed(0)} vs halo from ${haloFrom.toFixed(0)}`
  );
  check(
    "a lone contact at an unrelated company still goes to the halo",
    radius("bank-0") >= haloFrom - 1,
    `radius ${radius("bank-0").toFixed(0)} vs halo from ${haloFrom.toFixed(0)}`
  );
  const googleLabel = layout.nodes.find(
    (n) => n.type === "clusterLabel" && (n.data as { label?: string }).label === "Google"
  );
  check(
    "Google's headcount is still its own members, not its neighbours",
    (googleLabel?.data as { count?: number } | undefined)?.count === 12
  );
}

/**
 * A family stays together even when the bigger cluster's other ties are stronger: Google shares
 * two schools and eight interests with five other companies, so its link to DeepMind (1) is
 * outweighed by more than three of them and is not among its top three by weight.
 */
function seatBusyGoogle() {
  const contacts: GraphContactInput[] = [];
  const tags = Array.from({ length: 8 }, (_, i) => `interest-${i}`);
  const add = (prefix: string, company: string, n: number, tied = true) => {
    for (let i = 0; i < n; i++) {
      const c = contact(`${prefix}-${i}`, company);
      if (tied) {
        c.school = i % 2 === 0 ? "Stanford University" : "MIT";
        c.tags = tags;
      }
      contacts.push(c);
    }
  };
  add("google", "Google", 12);
  for (let i = 0; i < 5; i++) add(`peer${i}`, `Peer${i} Labs`, 12);
  for (let i = 0; i < 20; i++) add(`co${i}`, `Employer${i} Labs`, 2 + ((i * 7) % 11), false);
  // DeepMind's people share nothing with Google but the family.
  for (let i = 0; i < 3; i++) contacts.push(contact(`gdm-${i}`, "Google DeepMind"));

  const fit = buildConstellationFit(contacts);
  const eligible = fit.clusters.filter((c) => fit.fits.has(c.id));
  const links = buildClusterAffinity(contacts, fit.byContactId, eligible)
    .filter((l) => l.a === "company:google" || l.b === "company:google")
    .sort((x, y) => y.weight - x.weight);
  const rank = links.findIndex((l) => l.a === "company:google deepmind" || l.b === "company:google deepmind");
  console.log("\nGoogle with strong non-family ties");
  check("DeepMind's family link is outranked by more than three others", rank >= 3, `rank ${rank}`);

  const layout = buildHybridGraphLayout(contacts, "You");
  const pos = new Map(layout.nodes.map((n) => [n.id, n.position]));
  const centroid = (prefix: string) => {
    const ps = contacts.filter((c) => c.id.startsWith(`${prefix}-`)).map((c) => pos.get(c.id)!);
    return {
      x: ps.reduce((sum, p) => sum + p.x, 0) / ps.length,
      y: ps.reduce((sum, p) => sum + p.y, 0) / ps.length,
    };
  };
  const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
  const google = centroid("google");
  const others = [
    ...Array.from({ length: 5 }, (_, i) => `peer${i}`),
    ...Array.from({ length: 20 }, (_, i) => `co${i}`),
  ];
  const nearest = Math.min(...others.map((o) => dist(google, centroid(o))));
  const gdm = dist(google, centroid("gdm"));
  check(
    "DeepMind is still Google's nearest neighbour",
    gdm < nearest,
    `DeepMind ${gdm.toFixed(0)} vs nearest ${nearest.toFixed(0)}`
  );
}

seat(20);
seat(60);
seatBusyGoogle();

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll family-seating checks passed.");
process.exit(0);
