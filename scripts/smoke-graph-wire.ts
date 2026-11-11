/**
 * The constellation payload's wire form must be invisible to every caller.
 *
 * `getGraphData`/`getFullGraphData` now return a columnar encoding (lib/graph-wire.ts) that the
 * chart decodes back into exactly the object `loadGraphData` built. The risk in a hand-written
 * codec is never "does it compress" — it is the one field that comes back `undefined`, the date
 * that loses its milliseconds, or the cluster whose member order flipped. So this asserts the
 * strong form: `deepStrictEqual(decode(encode(payload)), payload)` — every own key, every value,
 * every `Date`, and array order — on synthetic data and on hand-poked edge cases (absent
 * industry, empty strings, null keyFacts, epoch-zero and far-future dates, unicode, reversed
 * cluster membership).
 *
 * It also holds the reason the format exists: at 3,000 contacts the wire must be at most half the
 * payload it replaces, and at 10,000 it prints the real bytes and decode cost.
 *
 * Run: npx tsx scripts/smoke-graph-wire.ts
 */
import { deepStrictEqual } from "node:assert/strict";
import { checker } from "./smoke/check";
import { buildSyntheticGraphPayload } from "../src/lib/graph/synthetic-network";
import {
  GRAPH_WIRE_VERSION,
  decodeGraphPayload,
  encodeGraphPayload,
  type GraphPayload,
  type GraphWire,
} from "../src/lib/graph-wire";

const t = checker();

/** Encode, decode and demand the original value back. Returns the wire for size checks. */
function roundTrip(label: string, payload: GraphPayload): GraphWire {
  const wire = encodeGraphPayload(payload);
  const decoded = decodeGraphPayload(wire);
  let detail = "";
  let equal = true;
  try {
    deepStrictEqual(decoded, payload);
  } catch (err) {
    equal = false;
    detail = String((err as Error).message).split("\n").slice(0, 6).join(" ");
  }
  t.check(`${label} round-trips exactly`, equal, detail);
  return wire;
}

// ---- synthetic data, the shape the chart actually receives ---------------------------------
const synthetic = buildSyntheticGraphPayload(200, { seed: 5 });
roundTrip("synthetic payload", synthetic);

// ---- edge cases a real account can produce --------------------------------------------------
const edge = buildSyntheticGraphPayload(40, { seed: 11 });
const c = edge.contacts;
c[0].industry = "Semiconductors"; // the field `loadGraphData` only adds when non-empty
c[1].industry = "  "; // a whitespace value must survive as-is, not be treated as absent
c[1].company = ""; // "" is distinct from null
c[1].school = null;
c[2].fullName = "Zoë 🚀 Okafor"; // unicode, including astral-plane code points
c[3].closeness = 0.1234567890123; // floats must not be rounded
c[3].orbitScore = 4.999;
c[4].keyFacts = null; // the column is nullable even though the default is []
c[5].preferredName = null;
c[6].lastInteractionAt = new Date(0); // epoch zero is a real value, not "unset"
c[7].lastInteractionAt = null;
c[8].nextFollowUpAt = new Date("2099-12-31T23:59:59.999Z"); // milliseconds must survive
c[9].tags = ["zeta", "alpha"];
edge.clusters[0].contactIds.reverse(); // member order is not ours to normalise
edge.clusters[1].kind = "other"; // the type allows it even though the builder filters it out
roundTrip("edge cases", edge);

// ---- an empty network is a valid payload ----------------------------------------------------
roundTrip("empty payload", buildSyntheticGraphPayload(0, { seed: 1 }));

// ---- the format earns its keep --------------------------------------------------------------
const budget = buildSyntheticGraphPayload(3000, { seed: 7 });
const budgetFull = JSON.stringify(budget).length;
const budgetWire = JSON.stringify(encodeGraphPayload(budget)).length;
const ratio = budgetWire / budgetFull;
t.check(
  "3,000 contacts: the wire is at most half the payload",
  ratio <= 0.5,
  `${(budgetFull / 1024).toFixed(0)} KB -> ${(budgetWire / 1024).toFixed(0)} KB (${(ratio * 100).toFixed(0)}%)`
);

const large = buildSyntheticGraphPayload(10_000, { seed: 9 });
const largeFull = JSON.stringify(large).length;
const largeWire = encodeGraphPayload(large);
const largeText = JSON.stringify(largeWire).length;
const decodeStart = performance.now();
const largeDecoded = decodeGraphPayload(largeWire);
const decodeMs = performance.now() - decodeStart;
let largeEqual = true;
try {
  deepStrictEqual(largeDecoded, large);
} catch {
  largeEqual = false;
}
t.check(
  "10,000 contacts round-trip exactly",
  largeEqual,
  "the largest network the graph supports"
);
console.log(
  `  10,000 contacts: ${(largeFull / 1e6).toFixed(2)} MB -> ${(largeText / 1e6).toFixed(2)} MB ` +
    `(${(100 * (1 - largeText / largeFull)).toFixed(0)}% smaller), decode ${decodeMs.toFixed(0)} ms`
);

// ---- a version bump without a decoder change is refused, not guessed at ---------------------
let refused = false;
try {
  decodeGraphPayload({ ...largeWire, v: (GRAPH_WIRE_VERSION + 1) as typeof GRAPH_WIRE_VERSION });
} catch {
  refused = true;
}
t.check("an unknown wire version is refused", refused);

t.done("graph wire format");
