/**
 * Hand-dragged star positions survive a view that cannot draw every contact.
 *
 * The bug this pins: the graph used to persist its *render* map — pruned to whatever the
 * current payload contained — whenever that map's size differed from what was stored. The
 * payload is narrower than the network for several innocent reasons (the dashboard preview
 * caps at 150 contacts, the constellation filter narrows it further), and the refetch that
 * triggered this fires on every window focus. So visiting the dashboard with a large network
 * silently deleted the saved layout for everyone outside the cap, unrecoverably.
 *
 * Both helpers are pure and this test is the only thing that can reach them — inside
 * `network-graph.tsx` they were unreachable from a script, which is why the bug lived.
 *
 * Run: npx tsx scripts/smoke-graph-positions.ts
 */
import {
  mergePositionsForStorage,
  prunePositionsForRender,
  type PositionMap,
} from "../src/lib/graph-positions";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const stored: PositionMap = {
  alice: { x: 10, y: 10 },
  bob: { x: 20, y: 20 },
  carol: { x: 30, y: 30 },
};

console.log("Pruning for render…");

const visible = prunePositionsForRender(stored, ["alice", "carol"]);
check(
  "keeps only the contacts this payload can draw",
  Object.keys(visible).sort().join(",") === "alice,carol"
);
check("and carries their coordinates through", visible.alice.x === 10 && visible.carol.y === 30);
check(
  "leaves the stored map untouched — pruning is a read, not an edit",
  Object.keys(stored).length === 3
);
check(
  "an empty payload prunes to nothing without throwing",
  Object.keys(prunePositionsForRender(stored, [])).length === 0
);
check(
  "an id in the payload with no saved position simply isn't in the result",
  !("dave" in prunePositionsForRender(stored, ["dave"]))
);

console.log("\nMerging for storage…");

// The scenario that used to lose data: only Alice and Carol were rendered, the user dragged
// Alice, and the resulting render map has no mention of Bob at all.
const afterDrag: PositionMap = { alice: { x: 99, y: 99 }, carol: { x: 30, y: 30 } };
const merged = mergePositionsForStorage(stored, afterDrag);

check(
  "the drag is recorded",
  merged.alice.x === 99 && merged.alice.y === 99
);
check(
  "and a contact absent from this view keeps its position instead of being dropped",
  merged.bob?.x === 20,
  JSON.stringify(merged)
);
check(
  "nothing is lost overall",
  Object.keys(merged).sort().join(",") === "alice,bob,carol"
);
check(
  "merging an empty active map is a no-op rather than a wipe",
  Object.keys(mergePositionsForStorage(stored, {})).length === 3
);
check(
  "and neither input is mutated",
  stored.alice.x === 10 && afterDrag.alice.x === 99
);

console.log("\nAll graph position checks passed.");
