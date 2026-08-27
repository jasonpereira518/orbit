/**
 * The chrono journey's per-frame math.
 *
 * THE FAILURE THIS GUARDS AGAINST is a warp that does not land. Every beat is
 * derived from elapsed time rather than from React state, so nothing forces
 * the shutter back open or the spin back to rest at the end of an arc — if the
 * math does not return to rest on its own, the visitor is left looking at a
 * smeared sky behind a payment form.
 *
 * It also pins the two things most likely to be "tidied" into wrongness: the
 * ignition bursts must stay UNEVENLY spaced (an even cadence reads as a
 * progress bar), and the rewind's angular velocity must stay negative (a
 * positive rewind is just the outbound trip played again).
 *
 * Run: npx tsx scripts/smoke-warp-chrono.ts
 */
import {
  ALPHA_FAST,
  ALPHA_STILL,
  CHRONO_ARRIVING_MS,
  CHRONO_IN,
  CHRONO_INBOUND_MS,
  CHRONO_IN_COVER,
  CHRONO_OPAQUE_MS,
  CHRONO_OUTBOUND_MS,
  CHRONO_RESOLVE,
  CRUISE_BURSTS,
  CRUISE_BURST_MS,
  IGNITION_FRACTIONS,
  burstForRadiusRank,
  chronoFrame,
  partDirection,
  partDistance,
  tangentForSlot,
} from "../src/lib/warp/chrono";
import { CRUISE_CAP_MS, easeFade, span } from "../src/lib/warp/choreography";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

function main() {
  /* ------------------------------------------------------ the shutter opens */

  const start = chronoFrame("outbound", 0, 0);
  check("time starts at rest", near(start.omega, 0));
  check("the shutter starts closed down", near(start.alpha, ALPHA_STILL));

  const end = chronoFrame("outbound", CHRONO_OUTBOUND_MS, 0);
  check("time is at full speed by the end of the run", end.omega > 0);
  check("the shutter is wide open", near(end.alpha, ALPHA_FAST));

  // Monotonic: a shutter that reopens mid-climb reads as a stutter, not accel.
  let prevAlpha = Infinity;
  let prevOmega = -Infinity;
  for (let t = 0; t <= CHRONO_OUTBOUND_MS; t += 10) {
    const f = chronoFrame("outbound", t, 0);
    check(
      `shutter never reopens while accelerating (t=${t})`,
      f.alpha <= prevAlpha + 1e-9
    );
    check(`time never slows while accelerating (t=${t})`, f.omega >= prevOmega - 1e-9);
    prevAlpha = f.alpha;
    prevOmega = f.omega;
  }

  /* ------------------------------------------------------------- the growth */

  check("there are seven ignition bursts", IGNITION_FRACTIONS.length === 7);
  check(
    "the first lands at the start of the growth window",
    near(IGNITION_FRACTIONS[0], 0)
  );
  check(
    "the last lands at the end",
    near(IGNITION_FRACTIONS[IGNITION_FRACTIONS.length - 1], 1)
  );
  check(
    "they run in order",
    IGNITION_FRACTIONS.every((f, i) => i === 0 || f > IGNITION_FRACTIONS[i - 1])
  );
  // An even cadence reads as a loading bar. No two consecutive gaps may match.
  const gaps = IGNITION_FRACTIONS.slice(1).map((f, i) => f - IGNITION_FRACTIONS[i]);
  check(
    "the bursts are unevenly spaced",
    gaps.every((g, i) => i === 0 || Math.abs(g - gaps[i - 1]) > 0.02),
    gaps.map((g) => g.toFixed(2)).join(" ")
  );
  check(
    "nothing has ignited before the growth window opens",
    chronoFrame("outbound", 0, 0).bursts === 0
  );
  check(
    "all seven have fired by the end of the run",
    chronoFrame("outbound", CHRONO_OUTBOUND_MS, 0).bursts === 7
  );

  /* ------------------------------------------------- a hold still grows */

  const heldShort = chronoFrame("cruise", CHRONO_OUTBOUND_MS + 100, 0);
  const heldLong = chronoFrame("cruise", CHRONO_OUTBOUND_MS + 3000, 0);
  check("a cruise hold stays at full speed", heldLong.omega === heldShort.omega);
  check("...with the shutter wide open", near(heldLong.alpha, ALPHA_FAST));
  check(
    "...and keeps igniting, so a long hold is growth and not a loop",
    heldLong.bursts > heldShort.bursts
  );
  // A burst counter that outruns the stage's reserve is arithmetic, not
  // growth: nothing lights, and the beat the count exists to produce silently
  // stops happening. The reserve is what those extra bursts light, so the
  // count must never promise more of them than there are.
  const forever = chronoFrame("cruise", CHRONO_OUTBOUND_MS + 60_000, 0);
  check(
    "the hold's bursts stop at the reserve the stage actually seeds",
    forever.bursts === IGNITION_FRACTIONS.length + CRUISE_BURSTS,
    `${forever.bursts} vs ${IGNITION_FRACTIONS.length + CRUISE_BURSTS}`
  );
  // ...and the reserve is spent exactly at the cap: any shorter and the sky
  // freezes before the provider force-resolves, any longer and the surplus
  // levels hold stars no hold can ever reach.
  const atCap = chronoFrame("cruise", CRUISE_CAP_MS, 0);
  check(
    "the reserve lasts exactly as long as the longest possible hold",
    atCap.bursts === IGNITION_FRACTIONS.length + CRUISE_BURSTS,
    `held ${CRUISE_CAP_MS - CHRONO_OUTBOUND_MS}ms = ${atCap.bursts - IGNITION_FRACTIONS.length} bursts of ${CRUISE_BURSTS}`
  );
  check(
    "nothing extra ignites on a fast route, where there is no hold at all",
    chronoFrame("cruise", CHRONO_OUTBOUND_MS, 0).bursts ===
      IGNITION_FRACTIONS.length
  );
  check(
    "the first held burst arrives one CRUISE_BURST_MS into the hold",
    chronoFrame("cruise", CHRONO_OUTBOUND_MS + CRUISE_BURST_MS, 0).bursts ===
      IGNITION_FRACTIONS.length + 1
  );

  /* ------------------------------------ the hold carries into the landing */

  // The stars a hold lit must still be lit while the arcs collapse. Reporting
  // a bare seven in "arriving" would snuff every one of them out on the frame
  // deceleration begins — a sky visibly emptying at the moment it is handed to
  // the page. `elapsed - sinceArriving` is the elapsed time when the hold
  // ended, so the two must agree for every hold length.
  for (let held = 0; held <= 4000; held += 137) {
    const decelAt = CHRONO_OUTBOUND_MS + held;
    for (const since of [0, CHRONO_OPAQUE_MS / 2, CHRONO_ARRIVING_MS]) {
      check(
        `the collapse keeps the hold's stars lit (held=${held}, since=${since})`,
        chronoFrame("arriving", decelAt + since, since).bursts ===
          chronoFrame("cruise", decelAt, 0).bursts
      );
    }
  }

  /* ---------------------------------------------------------- the collapse */

  const landed = chronoFrame("arriving", 0, CHRONO_ARRIVING_MS);
  check("the arcs collapse back to points", near(landed.omega, 0));
  check("the shutter closes completely", near(landed.alpha, 1));

  // Overshooting the window must not reopen anything: rAF frames do not land
  // on exact millisecond boundaries.
  const past = chronoFrame("arriving", 0, CHRONO_ARRIVING_MS * 3);
  check("staying past the end stays landed", near(past.omega, 0) && near(past.alpha, 1));

  /* ------------------------------------------------------------ the rewind */

  for (let t = 0; t <= CHRONO_INBOUND_MS; t += 10) {
    const f = chronoFrame("inbound", t, 0);
    check(`the rewind never runs forwards (t=${t})`, f.omega <= 1e-9);
    check(`the field never grows on the way home (t=${t})`, f.alive <= 1 + 1e-9);
  }

  // The actual midpoint of the rewind window, not a stale literal — a past
  // retune left this hardcoded at the old window's midpoint and it silently
  // stopped being "mid-arc" when the window moved.
  const rewindMid = (CHRONO_IN.rewind[0] + CHRONO_IN.rewind[1]) / 2;
  const mid = chronoFrame("inbound", rewindMid, 0);
  check("the rewind is at speed mid-arc", mid.omega < 0);
  check("...and the field is thinning", mid.alive < 1);

  const home = chronoFrame("inbound", CHRONO_INBOUND_MS, 0);
  check("the rewind ends at rest", near(home.omega, 0));
  check("...with the shutter closed", near(home.alpha, 1));
  check("...and the growth undone", near(home.alive, 0));

  /* ------------------------------------------- the page leaving the frame */

  // The exit is lift-then-part, and the three beats have to nest in that order
  // or the shot is lost. This is exactly what a future retune breaks, so each
  // link in the chain is pinned separately rather than as one compound.
  check(
    "the flight begins before the rise has finished, so the two read as one move",
    CHRONO_IN.part[0] >= CHRONO_IN.lift[0] &&
      CHRONO_IN.part[0] < CHRONO_IN.lift[1],
    `lift ${CHRONO_IN.lift.join("-")}ms, part starts ${CHRONO_IN.part[0]}ms`
  );
  check(
    "the panels are clear of the frame before the cover finishes",
    CHRONO_IN.part[1] <= CHRONO_IN.cover[1],
    `part ends ${CHRONO_IN.part[1]}ms, cover ends ${CHRONO_IN.cover[1]}ms`
  );
  check(
    "the cover finishes no later than the route swap",
    CHRONO_IN.cover[1] <= CHRONO_IN.push,
    `cover ends ${CHRONO_IN.cover[1]}ms, push at ${CHRONO_IN.push}ms`
  );
  check(
    "the return arc ends exactly when the run does",
    CHRONO_IN.landing[1] === CHRONO_INBOUND_MS,
    `landing ends ${CHRONO_IN.landing[1]}ms, run is ${CHRONO_INBOUND_MS}ms`
  );

  /* --------------------------------------------- the cover on the way home */

  // The cover has to be complete before router.back() swaps the route, or the
  // swap itself shows through a translucent canvas...
  check(
    "the way home is fully covered before the route swaps",
    CHRONO_IN_COVER[1] <= CHRONO_IN.push,
    `cover ends ${CHRONO_IN_COVER[1]}ms, push at ${CHRONO_IN.push}ms`
  );
  // ...and it has to stay down while the panels are crossing it, or the exit
  // the late push exists to buy time for plays behind an opaque canvas and
  // nobody ever sees it. The panels now fly OUTWARD across the full width of
  // the frame, so "down at t=0" is no longer enough on its own: the cover must
  // still be flat past the halfway point of the flight.
  check(
    "the cover starts down, so the exit is visible through it",
    CHRONO_IN_COVER[0] === CHRONO_IN.cover[0] &&
      CHRONO_IN_COVER[1] > CHRONO_IN_COVER[0]
  );
  check(
    "the cover is still completely down when the flight is half over",
    easeFade(
      span((CHRONO_IN.part[0] + CHRONO_IN.part[1]) / 2, CHRONO_IN_COVER)
    ) === 0,
    `flight midpoint ${(CHRONO_IN.part[0] + CHRONO_IN.part[1]) / 2}ms, cover opens ${CHRONO_IN_COVER[0]}ms`
  );
  check(
    "...and completely up by the time the route swaps",
    near(easeFade(span(CHRONO_IN.push, CHRONO_IN_COVER)), 1),
    `coverage at push = ${easeFade(span(CHRONO_IN.push, CHRONO_IN_COVER))}`
  );
  check(
    "the cover is fully up long before the landing lifts it again",
    CHRONO_IN_COVER[1] < CHRONO_IN.landing[0],
    `plateau ${CHRONO_IN.landing[0] - CHRONO_IN_COVER[1]}ms`
  );

  /* ------------------------------------------- the page out of the stream */

  // The reveal — where coverage() lifts the stage off the page — opens
  // CHRONO_OPAQUE_MS after deceleration begins and closes at
  // CHRONO_ARRIVING_MS. The panels must be sharpening INSIDE it. Finishing
  // before it opens is "sky cleared, then page faded in", which is precisely
  // what this arrival exists not to be.
  const firstPanel = { from: CHRONO_RESOLVE.lead, to: CHRONO_RESOLVE.lead + CHRONO_RESOLVE.duration };
  check(
    "the first panel is already sharpening when the veil starts lifting",
    firstPanel.from < CHRONO_OPAQUE_MS && firstPanel.to > CHRONO_OPAQUE_MS,
    `panel 0 runs ${firstPanel.from}-${firstPanel.to}ms, reveal opens ${CHRONO_OPAQUE_MS}ms`
  );
  // The last slot on the page is the trust row, order 5 — the same maxOrder
  // /upgrade passes to UpgradeTransition.
  const lastPanelEnds =
    CHRONO_RESOLVE.lead + 5 * CHRONO_RESOLVE.stagger + CHRONO_RESOLVE.duration;
  check(
    "the last panel is still sharpening after the veil is off",
    lastPanelEnds > CHRONO_ARRIVING_MS,
    `panel 5 ends ${lastPanelEnds}ms, reveal closes ${CHRONO_ARRIVING_MS}ms`
  );
  check(
    "...but not so far after that the page is left visibly unfinished",
    lastPanelEnds - CHRONO_ARRIVING_MS < CHRONO_RESOLVE.duration,
    `${lastPanelEnds - CHRONO_ARRIVING_MS}ms past the reveal`
  );

  /* ----------------------------------------------------------- the tangents */

  for (let order = 0; order <= 5; order += 1) {
    const t = tangentForSlot(order, 5);
    check(
      `slot ${order}'s smear direction is a unit vector`,
      near(Math.hypot(t.x, t.y), 1, 1e-9)
    );
  }
  const first = tangentForSlot(0, 5);
  const last = tangentForSlot(5, 5);
  check(
    "the smear rotates down the page, so panels ride their own arc",
    Math.atan2(last.y, last.x) !== Math.atan2(first.y, first.x)
  );

  /* --------------------------------------------------- the parting directions */

  // The headline of the exit: the two plan cards sit either side of the centre
  // line and must leave by the side they are already nearer, not by a side
  // some table decided for them.
  const frame = 1280;
  const centre = frame / 2;
  const proCard = partDirection(centre - 232, centre, 3);
  const lifetimeCard = partDirection(centre + 232, centre, 4);
  check("the card left of centre leaves to the left", proCard === -1);
  check("the card right of centre leaves to the right", lifetimeCard === 1);
  check("...so the two cards part rather than convoy", proCard !== lifetimeCard);

  // /upgrade's other four slots are full-width bands whose centre IS the frame
  // centre. They have no nearer side, so they split by parity — and the thing
  // that matters is that they do not all go the same way.
  const bands = [0, 1, 2, 5].map((order) => partDirection(centre, centre, order));
  check(
    "a panel dead on the centre line still picks a side",
    bands.every((d) => d === -1 || d === 1)
  );
  check(
    "...and centred panels do not all leave the same way",
    new Set(bands).size === 2,
    bands.join(" ")
  );
  check(
    "a sub-pixel drift off centre is still treated as centred",
    partDirection(centre + 1, centre, 0) === partDirection(centre, centre, 0) &&
      partDirection(centre - 1, centre, 1) === partDirection(centre, centre, 1)
  );
  check(
    "the direction is stable for a given slot, so a re-measure cannot flip it",
    partDirection(centre - 232, centre, 3) === proCard
  );

  /* ------------------------------------------------------ the parting distance */

  // The distance has to clear the frame for EVERY panel width, or the widest
  // section stops with an edge still inside the viewport as the cover comes up.
  for (const width of [320, 768, 1280, 2560]) {
    const distance = partDistance(width);
    const boxes = [
      { label: "full-width band", left: 0, w: width },
      { label: "left card", left: width * 0.05, w: width * 0.42 },
      { label: "right card", left: width * 0.53, w: width * 0.42 },
      { label: "narrow, hard right", left: width - 40, w: 40 },
    ];
    for (const box of boxes) {
      const dir = partDirection(box.left + box.w / 2, width / 2, 0);
      const left = box.left + dir * distance;
      check(
        `a ${box.label} is clean off the frame after parting (w=${width})`,
        left >= width || left + box.w <= 0,
        `ends at ${left}..${left + box.w} in a ${width}px frame`
      );
    }
  }
  check("a degenerate viewport cannot ask for negative travel", partDistance(-10) === 0);

  /* ------------------------------------------------------------- easeFade */

  check("easeFade(0) is 0", near(easeFade(0), 0));
  check("easeFade(1) is 1", near(easeFade(1), 1));
  check("easeFade(0.5) is 0.5", near(easeFade(0.5), 0.5));

  // Monotonic across the whole domain — a fade that dips or reopens reads as
  // a flicker.
  let prevFade = -Infinity;
  for (let t = 0; t <= 1; t += 0.02) {
    const v = easeFade(t);
    check(`easeFade never reverses (t=${t.toFixed(2)})`, v >= prevFade - 1e-9);
    prevFade = v;
  }

  // The defining property: zero slope at both ends. Sampled just inside each
  // edge, easeFade must land far closer to the endpoint than a linear ramp
  // would — that's the whole reason it exists over a raw span().
  check(
    "the slope is ~zero at the start",
    easeFade(0.02) < 0.02 * 0.5,
    `easeFade(0.02)=${easeFade(0.02)}`
  );
  check(
    "the slope is ~zero at the end",
    1 - easeFade(0.98) < 0.02 * 0.5,
    `easeFade(0.98)=${easeFade(0.98)}`
  );

  /* ------------------------------------------------------ burstForRadiusRank */

  check("rank 0 (nearest the pole) lights the first burst", burstForRadiusRank(0) === 0);
  check(
    "rank 1 (farthest out) lights the last burst",
    burstForRadiusRank(1) === IGNITION_FRACTIONS.length - 1
  );
  check(
    "a rank past 1 still clamps to the last burst",
    burstForRadiusRank(1.5) === IGNITION_FRACTIONS.length - 1
  );
  check(
    "a negative rank still clamps to the first burst",
    burstForRadiusRank(-0.5) === 0
  );

  let prevBurst = -1;
  for (let rank = 0; rank <= 1; rank += 0.02) {
    const b = burstForRadiusRank(rank);
    check(
      `burstForRadiusRank never decreases (rank=${rank.toFixed(2)})`,
      b >= prevBurst
    );
    prevBurst = b;
  }

  console.log("\nAll chrono beat checks passed.");
}

main();
process.exit(0);
