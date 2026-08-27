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
  CHRONO_OUTBOUND_MS,
  IGNITION_FRACTIONS,
  burstForRadiusRank,
  chronoFrame,
  tangentForSlot,
} from "../src/lib/warp/chrono";
import { easeFade } from "../src/lib/warp/choreography";

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
