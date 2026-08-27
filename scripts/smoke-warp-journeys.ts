/**
 * The arrival gate that decides which journey — if any — delivered a visitor
 * to the page they are standing on.
 *
 * THE FAILURE THIS GUARDS AGAINST is a Back button that plays the wrong
 * journey backwards. `/upgrade` is reachable from `/pricing`, which is itself
 * reachable by rocket; if the gate answered a bare "yes, you warped" the
 * /pricing -> /upgrade step would fire a fall-to-Earth that lands you back in
 * space. The gate must therefore agree on BOTH the journey and the path.
 *
 * It also guards the upgrade path: a visitor mid-session when this ships has a
 * pre-generalization value ("/pricing", no journey prefix) sitting in
 * sessionStorage. That must degrade to plain back-navigation, never to a
 * mis-parsed journey.
 *
 * Run: npx tsx scripts/smoke-warp-journeys.ts
 */
import {
  JOURNEYS,
  decodeArrival,
  encodeArrival,
  type JourneyId,
} from "../src/lib/warp/journeys";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

function main() {
  /* ----------------------------------------------------------- the descriptors */

  check("liftoff still goes to /pricing", JOURNEYS.liftoff.destination === "/pricing");
  check("chrono goes to /upgrade", JOURNEYS.chrono.destination === "/upgrade");

  for (const id of Object.keys(JOURNEYS) as JourneyId[]) {
    const j = JOURNEYS[id];
    check(`${id}'s id matches its key`, j.id === id);
    check(
      `${id} pushes the route only once the stage is opaque`,
      j.beats.opaqueMs > 0 && j.beats.opaqueMs < j.beats.outboundMs,
      `opaqueMs=${j.beats.opaqueMs} outboundMs=${j.beats.outboundMs}`
    );
    check(
      `${id} has a non-zero deceleration and return`,
      j.beats.arrivingMs > 0 && j.beats.inboundMs > 0
    );
  }

  /* ------------------------------------------------------------------ the gate */

  const flown = encodeArrival("chrono", "/upgrade");
  check("a round trip returns the journey", decodeArrival(flown, "/upgrade") === "chrono");

  check(
    "standing somewhere else returns nothing",
    decodeArrival(flown, "/dashboard") === null
  );

  // The exact case that would fire a fall-to-Earth on the wrong page.
  const rocket = encodeArrival("liftoff", "/pricing");
  check(
    "a rocket ride to /pricing does not arm Back on /upgrade",
    decodeArrival(rocket, "/upgrade") === null
  );
  check("...but does arm it on /pricing", decodeArrival(rocket, "/pricing") === "liftoff");

  /* -------------------------------------------------------- degrading safely */

  check("nothing stored means no journey", decodeArrival(null, "/upgrade") === null);
  check(
    "a pre-generalization bare path is ignored",
    decodeArrival("/pricing", "/pricing") === null
  );
  check(
    "an unknown journey id is ignored",
    decodeArrival("teleport:/upgrade", "/upgrade") === null
  );
  check("an empty string is ignored", decodeArrival("", "/upgrade") === null);

  // Query strings are real: /upgrade?period=annual stores the pathname alone.
  check(
    "the stored value is a pathname, so a query string never matches",
    decodeArrival(encodeArrival("chrono", "/upgrade?period=annual"), "/upgrade") === null
  );

  console.log("\nAll warp-journey checks passed.");
}

main();
process.exit(0);
