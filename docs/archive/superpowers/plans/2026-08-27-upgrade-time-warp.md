# /upgrade Time Warp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Settings → `/upgrade` into a time warp forward — long-exposure star trails that lengthen as time accelerates, new stars igniting as the orbit grows, collapsing into the still sky the page resolves out of.

**Architecture:** Generalize the existing root-mounted `WarpProvider` from one journey (the app → `/pricing` rocket) into a provider hosting two, selected by a journey descriptor. The chrono journey adds its own canvas stage and beat table but reuses the phase machine, timer bookkeeping, paint-gated cruise hold, arrival gate and reduced-motion collapse. Trails are rendered by never clearing the canvas — each frame erases a fraction of the previous one, so accumulated light *is* the trail.

**Tech Stack:** Next.js 16 App Router, React 19, `motion` v12, 2D canvas, Tailwind v4, `tsx` smoke scripts.

**Spec:** [`docs/superpowers/specs/2026-08-27-upgrade-time-warp-design.md`](../specs/2026-08-27-upgrade-time-warp-design.md)

## Global Constraints

- **No new dependencies.** `motion` and canvas are already in play.
- **The rocket must not change.** No change to its beats, timings or feel. Any observable difference in the app → `/pricing` lift-off is a bug, not a design choice.
- **No change to `/pricing`.**
- **No `lib/journey` framework extraction.** Two journeys is not enough evidence for a third-journey abstraction.
- **`/pricing` → `/upgrade` and direct loads keep today's brick assembly**, untouched.
- **No numbers, no real user data** anywhere in the warp. Abstract constellation only.
- **eslint must not exceed its 48-error baseline.** Run `npx eslint` and count.
- **This worktree has no `node_modules`.** Symlink the main checkout's before anything else, or `tsc`/`eslint` silently no-op and exit 0.
- **Smoke scripts must call `process.exit(0)` explicitly** or `tsx` hangs.
- **`src/lib/warp/journeys.ts` and `src/lib/warp/chrono.ts` must stay free of React and `next/*` imports** — the smoke scripts import them directly under `tsx`.
- Free contact ceiling referenced by the fiction is **500** (`FREE_CONTACT_LIMIT`), but it is never displayed.

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `src/lib/warp/journeys.ts` | Journey ids, destinations, beat durations, arrival-gate encode/decode. Pure data + pure functions. |
| `src/lib/warp/chrono.ts` | The chrono beat table and the pure per-frame math (angular velocity, shutter alpha, ignition schedule, panel tangents). |
| `src/components/warp/chrono-stage.tsx` | The trail canvas. One rAF loop, all beats derived from elapsed time. |
| `scripts/smoke-warp-journeys.ts` | Guards the gate's encode/decode, including stale pre-generalization values. |
| `scripts/smoke-warp-chrono.ts` | Guards the beat math: monotonic shutter, collapse to rest, seven uneven bursts, negative rewind. |

**Modified**

| File | Change |
|---|---|
| `src/lib/warp/choreography.ts` | Add shared `lerp`; keep liftoff beats where they are. |
| `src/components/warp/warp-stage.tsx` | Renamed to `liftoff-stage.tsx`; internals untouched. |
| `src/components/warp/warp-provider.tsx` | Journey-parameterized; neutral phase names; `skip()`; per-journey stage lookup. |
| `src/components/warp/warp-link.tsx` | Gains `journey` prop, defaults to `"liftoff"`. |
| `src/components/pricing/back-control.tsx` | Runs the return arc of whichever journey delivered you; second press skips. |
| `src/components/motion/upgrade-transition.tsx` | Gains the `resolve` arrival mode alongside today's `assemble`. |
| `src/components/settings/plan-settings.tsx` | Upgrade link becomes a chrono `WarpLink`. |
| `src/app/(checkout)/upgrade/page.tsx` | Beacon, permanent starfield, rewritten stale comment. |
| `src/app/globals.css` | Qualify liftoff craft rules; add chrono shutter keyframes. |

---

## Task 1: Journey descriptors and the arrival gate

**Files:**
- Create: `src/lib/warp/journeys.ts`
- Create: `scripts/smoke-warp-journeys.ts`
- Modify: `src/lib/warp/choreography.ts` (add `lerp`)

**Interfaces:**
- Consumes: `ASCENT_MS`, `ASCENT_OPAQUE_MS`, `ARRIVAL_MS`, `REENTRY_MS` from `src/lib/warp/choreography.ts`.
- Produces:
  - `type JourneyId = "liftoff" | "chrono"`
  - `type JourneyBeats = { outboundMs: number; opaqueMs: number; arrivingMs: number; inboundMs: number }`
  - `type Journey = { id: JourneyId; destination: string; beats: JourneyBeats }`
  - `const JOURNEYS: Record<JourneyId, Journey>`
  - `encodeArrival(id: JourneyId, destination: string): string`
  - `decodeArrival(stored: string | null, pathname: string): JourneyId | null`
  - `lerp(a: number, b: number, t: number): number` from `choreography.ts`

- [ ] **Step 1: Make the worktree runnable**

This worktree has no `node_modules`. Without it, `tsc` and `eslint` exit 0 having checked nothing.

```bash
ln -s /Users/jasonpereira/Projects/orbit/node_modules node_modules
ls node_modules/.bin/tsx
```

Expected: the path prints. If it does not, run `npm install` in the main checkout first.

- [ ] **Step 2: Write the failing smoke script**

Create `scripts/smoke-warp-journeys.ts`:

```ts
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
```

- [ ] **Step 3: Run it to verify it fails**

```bash
npx tsx scripts/smoke-warp-journeys.ts
```

Expected: FAIL — `Cannot find module '../src/lib/warp/journeys'`.

- [ ] **Step 4: Add `lerp` to the shared choreography**

Append to `src/lib/warp/choreography.ts`, beside `span`/`easeHouse`/`easeIn`:

```ts
/** Linear blend. `t` is expected pre-clamped by `span`. */
export function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}
```

- [ ] **Step 5: Write the journey descriptors**

Create `src/lib/warp/journeys.ts`:

```ts
/**
 * The two journeys the warp provider can fly, and the gate that remembers
 * which one delivered you.
 *
 *   liftoff — the app to /pricing. A rocket. Slow out, fast home.
 *   chrono  — Settings to /upgrade. A time warp forward, told as long-exposure
 *             star trails. Symmetric: you rewind home the way you came.
 *
 * Deliberately free of React and next/* imports: the smoke script loads this
 * module directly under tsx, and a `next/dynamic` in here would take the whole
 * framework with it. The stage COMPONENTS are looked up in the provider; this
 * file only names the journeys.
 */
import {
  ARRIVAL_MS,
  ASCENT_MS,
  ASCENT_OPAQUE_MS,
  REENTRY_MS,
} from "@/lib/warp/choreography";
import {
  CHRONO_ARRIVING_MS,
  CHRONO_INBOUND_MS,
  CHRONO_OPAQUE_MS,
  CHRONO_OUTBOUND_MS,
} from "@/lib/warp/chrono";

export type JourneyId = "liftoff" | "chrono";

export type JourneyBeats = {
  /** Deterministic outbound run, ms from launch, before any cruise hold. */
  outboundMs: number;
  /** When the stage covers the frame and the route swap becomes invisible. */
  opaqueMs: number;
  /** Deceleration, once the destination has actually painted. */
  arrivingMs: number;
  /** The whole return arc, start to settled. */
  inboundMs: number;
};

export type Journey = {
  id: JourneyId;
  destination: string;
  beats: JourneyBeats;
};

export const JOURNEYS: Record<JourneyId, Journey> = {
  liftoff: {
    id: "liftoff",
    destination: "/pricing",
    beats: {
      outboundMs: ASCENT_MS,
      opaqueMs: ASCENT_OPAQUE_MS,
      arrivingMs: ARRIVAL_MS,
      inboundMs: REENTRY_MS,
    },
  },
  chrono: {
    id: "chrono",
    destination: "/upgrade",
    beats: {
      outboundMs: CHRONO_OUTBOUND_MS,
      opaqueMs: CHRONO_OPAQUE_MS,
      arrivingMs: CHRONO_ARRIVING_MS,
      inboundMs: CHRONO_INBOUND_MS,
    },
  },
};

/** What `launch()` writes to sessionStorage. */
export function encodeArrival(id: JourneyId, destination: string) {
  return `${id}:${destination}`;
}

/**
 * Which journey delivered this visitor to `pathname`, or null.
 *
 * Both halves have to agree. A rocket ride stores "liftoff:/pricing"; stepping
 * on to /upgrade from there no longer matches, so Back stays a plain
 * navigation instead of falling to Earth on the wrong page.
 *
 * Anything unrecognised — a bare path written before this shipped, an unknown
 * id, an empty string — degrades to null. A missing nicety is always cheaper
 * than a wrong journey.
 */
export function decodeArrival(
  stored: string | null,
  pathname: string
): JourneyId | null {
  if (!stored) return null;
  const sep = stored.indexOf(":");
  if (sep === -1) return null;
  const id = stored.slice(0, sep);
  if (stored.slice(sep + 1) !== pathname) return null;
  return id === "liftoff" || id === "chrono" ? id : null;
}
```

- [ ] **Step 6: Write the chrono duration constants**

`journeys.ts` imports four constants that do not exist yet. Create `src/lib/warp/chrono.ts` with only those for now — Task 2 fills in the rest:

```ts
/**
 * The chrono journey: Settings -> /upgrade, told as a long exposure.
 * Beat tables and the pure per-frame math. See the design spec for why each
 * window is where it is.
 */

/** When the stage covers the frame and the route swap becomes invisible. */
export const CHRONO_OPAQUE_MS = 380;
/** End of the deterministic outbound run, before any cruise hold. */
export const CHRONO_OUTBOUND_MS = 1450;
/** Deceleration: arcs collapse back into stars. The payoff shot. */
export const CHRONO_ARRIVING_MS = 620;
/** The rewind home, start to settled. */
export const CHRONO_INBOUND_MS = 1500;
```

- [ ] **Step 7: Run it to verify it passes**

```bash
npx tsx scripts/smoke-warp-journeys.ts
```

Expected: PASS — every line prefixed `ok`, ending `All warp-journey checks passed.`

- [ ] **Step 8: Typecheck and lint**

```bash
npx tsc --noEmit && npx eslint src/lib/warp scripts/smoke-warp-journeys.ts
```

Expected: no output from `tsc`; eslint clean for these paths.

- [ ] **Step 9: Commit**

```bash
git add src/lib/warp/journeys.ts src/lib/warp/chrono.ts src/lib/warp/choreography.ts scripts/smoke-warp-journeys.ts
git commit -m "Add journey descriptors and a journey-aware arrival gate"
```

---

## Task 2: The chrono beat math

**Files:**
- Modify: `src/lib/warp/chrono.ts`
- Create: `scripts/smoke-warp-chrono.ts`

**Interfaces:**
- Consumes: `span`, `easeHouse`, `easeIn`, `lerp` from `choreography.ts`; the four `CHRONO_*_MS` constants from Task 1.
- Produces:
  - `const POLE: { x: number; y: number }` — celestial pole as viewport fractions
  - `const ALPHA_STILL`, `ALPHA_FAST`, `OMEGA_PEAK`, `IGNITION_FRACTIONS`, `CRUISE_BURST_MS`
  - `type ChronoPhase = "outbound" | "cruise" | "arriving" | "inbound"`
  - `type ChronoFrame = { omega: number; alpha: number; bursts: number; alive: number }`
  - `chronoFrame(phase: ChronoPhase, elapsed: number, sinceArriving: number): ChronoFrame`
  - `tangentForSlot(order: number, maxOrder: number): { x: number; y: number }`

- [ ] **Step 1: Write the failing smoke script**

Create `scripts/smoke-warp-chrono.ts`:

```ts
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
  CHRONO_INBOUND_MS,
  CHRONO_OUTBOUND_MS,
  IGNITION_FRACTIONS,
  chronoFrame,
  tangentForSlot,
} from "../src/lib/warp/chrono";

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

  const mid = chronoFrame("inbound", 900, 0);
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

  console.log("\nAll chrono beat checks passed.");
}

main();
process.exit(0);
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npx tsx scripts/smoke-warp-chrono.ts
```

Expected: FAIL — `chronoFrame` is not exported from `../src/lib/warp/chrono`.

- [ ] **Step 3: Write the beat math**

Append to `src/lib/warp/chrono.ts`:

```ts
import { easeHouse, easeIn, lerp, span } from "@/lib/warp/choreography";

/** Outbound beats, ms from launch. */
export const CHRONO_OUT = {
  /** The room goes dark and the stage covers the frame. */
  shutter: [0, 380],
  /** Time accelerates: the spin ramps up and the shutter opens. */
  spin: [300, 1250],
  /** The orbit grows. */
  growth: [520, 1400],
} as const;

/** Inbound beats, ms from the moment Back is pressed. */
export const CHRONO_IN = {
  /** Panels smear back into the exposure. */
  dissolve: [0, 300],
  /** Late, unlike the rocket's frame-one push: the page dissolving is the shot. */
  push: 260,
  /** Time runs backwards. */
  rewind: [200, 950],
  /** Stars go out in bursts; the growth un-happens. */
  extinguish: [350, 1050],
  /** Arcs collapse back to points. */
  collapse: [1050, 1400],
  /** The room lights come back up. */
  landing: [1250, 1500],
} as const;

/**
 * The celestial pole, as viewport fractions. On-screen and high to one side:
 * the concentric sweep around a visible pole is the image people decode as
 * "hours passed". The innermost radii are thinned by the stage so this never
 * becomes a bullseye competing with the arriving page.
 */
export const POLE = { x: 0.22, y: 0.16 } as const;

/**
 * The shutter. How much of the trail layer each frame erases: 1 leaves no
 * trail at all, low values leave long arcs. Trail length is entirely this
 * number, which is why acceleration and deceleration cost one lerp each.
 */
export const ALPHA_STILL = 0.55;
export const ALPHA_FAST = 0.045;

/** Peak angular velocity, radians per second. */
export const OMEGA_PEAK = 1.9;

/**
 * Where the seven ignition bursts land inside the growth window, as fractions.
 * Deliberately uneven — an even cadence reads as a progress bar rather than as
 * a network gaining people. Pinned by the smoke script.
 */
export const IGNITION_FRACTIONS = [0, 0.13, 0.31, 0.4, 0.62, 0.79, 1] as const;

/** During a cruise hold, one further burst every this many ms, so a slow route
 *  still reads as growth instead of as a loop. */
export const CRUISE_BURST_MS = 420;

export type ChronoPhase = "outbound" | "cruise" | "arriving" | "inbound";

export type ChronoFrame = {
  /** Radians per second. Negative on the way home. */
  omega: number;
  /** The shutter; see ALPHA_STILL. */
  alpha: number;
  /** How many ignition bursts have fired. */
  bursts: number;
  /** Fraction of the grown field still lit. 1 outbound, falling to 0 on the
   *  way home as the growth un-happens. */
  alive: number;
};

function burstsBy(elapsed: number) {
  const [from, to] = CHRONO_OUT.growth;
  let n = 0;
  for (const f of IGNITION_FRACTIONS) {
    if (elapsed >= lerp(from, to, f)) n += 1;
  }
  return n;
}

/**
 * Every beat as a pure function of elapsed time.
 *
 * `elapsed` is ms since the run began; `sinceArriving` is ms since
 * deceleration started, and is only read in the "arriving" phase. Nothing here
 * touches the DOM, which is what makes the whole arc testable.
 */
export function chronoFrame(
  phase: ChronoPhase,
  elapsed: number,
  sinceArriving: number
): ChronoFrame {
  if (phase === "arriving") {
    // Collapse fills the first 380ms of the arriving window; the rest is the
    // cross-fade into the real starfield.
    const p = easeHouse(span(sinceArriving, [0, 380]));
    return {
      omega: OMEGA_PEAK * (1 - p),
      alpha: lerp(ALPHA_FAST, 1, p),
      bursts: IGNITION_FRACTIONS.length,
      alive: 1,
    };
  }

  if (phase === "inbound") {
    const rise = easeIn(span(elapsed, CHRONO_IN.rewind));
    const fall = easeHouse(span(elapsed, CHRONO_IN.collapse));
    const opened = lerp(ALPHA_STILL, ALPHA_FAST, rise);
    return {
      // Negative: time runs the other way. `fall` brings it back to rest.
      omega: -OMEGA_PEAK * rise * (1 - fall),
      alpha: lerp(opened, 1, fall),
      bursts: IGNITION_FRACTIONS.length,
      alive: 1 - span(elapsed, CHRONO_IN.extinguish),
    };
  }

  if (phase === "cruise") {
    const held = Math.max(0, elapsed - CHRONO_OUTBOUND_MS);
    return {
      omega: OMEGA_PEAK,
      alpha: ALPHA_FAST,
      bursts: IGNITION_FRACTIONS.length + Math.floor(held / CRUISE_BURST_MS),
      alive: 1,
    };
  }

  // Outbound. Accelerating, so the spin eases IN — it reads as time running
  // away rather than as a dial being turned.
  const t = easeIn(span(elapsed, CHRONO_OUT.spin));
  return {
    omega: OMEGA_PEAK * t,
    alpha: lerp(ALPHA_STILL, ALPHA_FAST, t),
    bursts: burstsBy(elapsed),
    alive: 1,
  };
}

/**
 * The direction a panel in assembly slot `order` was smeared by the exposure:
 * the unit tangent of the arc it sits on, i.e. perpendicular to its radius
 * from the pole.
 *
 * Derived from the slot rather than measured from the DOM. Panels stack down
 * the page from a pole that is up and to the left, so the radius angle sweeps
 * predictably; a layout read per panel would buy an accuracy nobody can see
 * and would have to happen before first paint to avoid a flash.
 */
export function tangentForSlot(order: number, maxOrder: number) {
  const t = maxOrder > 0 ? order / maxOrder : 0;
  // Radius angle from the pole to the panel, sweeping as slots descend.
  const radius = lerp(-0.35, 0.96, t);
  const tangent = radius + Math.PI / 2;
  return { x: Math.cos(tangent), y: Math.sin(tangent) };
}
```

- [ ] **Step 4: Run it to verify it passes**

```bash
npx tsx scripts/smoke-warp-chrono.ts
```

Expected: PASS, ending `All chrono beat checks passed.`

- [ ] **Step 5: Re-run Task 1's script**

`journeys.ts` now imports real constants rather than the stubs.

```bash
npx tsx scripts/smoke-warp-journeys.ts
```

Expected: still PASS.

- [ ] **Step 6: Typecheck and lint**

```bash
npx tsc --noEmit && npx eslint src/lib/warp scripts/smoke-warp-chrono.ts
```

Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/lib/warp/chrono.ts scripts/smoke-warp-chrono.ts
git commit -m "Add the chrono journey's beat table and per-frame math"
```

---

## Task 3: Generalize the provider

The risky task. It refactors working code, and the phase rename means the CSS
and the provider must change together or the rocket breaks.

**Files:**
- Modify: `src/lib/warp/journeys.ts` (two inbound beat fields)
- Modify: `scripts/smoke-warp-journeys.ts` (cover them)
- Rename: `src/components/warp/warp-stage.tsx` → `src/components/warp/liftoff-stage.tsx`
- Modify: `src/components/warp/warp-provider.tsx`
- Modify: `src/components/warp/warp-link.tsx`
- Modify: `src/components/pricing/back-control.tsx`
- Modify: `src/app/globals.css:1283-1302`

**Interfaces:**
- Consumes: `JOURNEYS`, `decodeArrival`, `encodeArrival`, `JourneyId` (Task 1).
- Produces:
  - `JourneyBeats` gains `inboundPushMs: number` and `inboundLandingMs: number`
  - `WarpPhase = "idle" | "outbound" | "cruise" | "arriving" | "inbound" | "landing"`
  - `WarpRun` gains `journey: JourneyId`
  - `useWarp(): { run, launch(journey, origin?), reenter(): boolean, skip(): void, arrive(): void }`
  - `arrivedBy(): JourneyId | null` (replaces `arrivedByWarp()`)
  - `<WarpLink journey="liftoff" | "chrono" href=... />`
  - `LiftoffStage` exported from `liftoff-stage.tsx` (renamed from `WarpStage`)

- [ ] **Step 1: Extend the beats and their smoke coverage**

The return arc needs two more numbers per journey: when `router.back()` fires,
and when the phase flips to `landing`. The rocket navigates on frame one; the
chrono trip waits until the stage is opaque, because the page dissolving is the
shot.

In `src/lib/warp/journeys.ts`, add to `JourneyBeats`:

```ts
  /** When router.back() fires on the way home. 0 = immediately. */
  inboundPushMs: number;
  /** When the phase flips to "landing" — the touchdown beat. */
  inboundLandingMs: number;
```

Import `REENTRY` from `choreography.ts` and `CHRONO_IN` from `chrono.ts`, then
add to each descriptor's `beats`:

```ts
// liftoff — navigates immediately: unlike the ascent there is nothing on
// screen worth preserving, and the app must be mounted before the judder.
inboundPushMs: 0,
inboundLandingMs: REENTRY.judder[0],
```

```ts
// chrono — the page dissolving into the exposure is the shot, so the swap
// waits until the stage covers it again.
inboundPushMs: CHRONO_IN.push,
inboundLandingMs: CHRONO_IN.landing[0],
```

In `scripts/smoke-warp-journeys.ts`, inside the existing `for` loop over
journeys, add:

```ts
    check(
      `${id} lands before its return arc ends`,
      j.beats.inboundLandingMs < j.beats.inboundMs,
      `landing=${j.beats.inboundLandingMs} inbound=${j.beats.inboundMs}`
    );
    check(
      `${id} navigates home before it lands`,
      j.beats.inboundPushMs < j.beats.inboundLandingMs
    );
```

And after the loop:

```ts
  check(
    "the rocket still falls home immediately",
    JOURNEYS.liftoff.beats.inboundPushMs === 0
  );
  check(
    "the chrono trip waits for the stage before swapping back",
    JOURNEYS.chrono.beats.inboundPushMs > 0
  );
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npx tsx scripts/smoke-warp-journeys.ts
```

Expected: FAIL on the first new assertion (`undefined < 750` is false), or a
`tsc` error if you typecheck first — either is the failing state.

- [ ] **Step 3: Rename the liftoff stage**

```bash
git mv src/components/warp/warp-stage.tsx src/components/warp/liftoff-stage.tsx
```

Then in `liftoff-stage.tsx` rename the exported component only — **no other
internal change**:

```ts
export function LiftoffStage({ run }: { run: WarpRun }) {
```

Also update its doc comment's opening line to `The lift-off, painted.` so the
file says which journey it paints.

- [ ] **Step 4: Rewrite the provider**

Replace `src/components/warp/warp-provider.tsx` entirely:

```tsx
"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
} from "react";
import { createPortal } from "react-dom";
import {
  ARRIVED_BY_WARP_KEY,
  CRUISE_CAP_MS,
  REDUCED_MS,
} from "@/lib/warp/choreography";
import {
  JOURNEYS,
  decodeArrival,
  encodeArrival,
  type JourneyId,
} from "@/lib/warp/journeys";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";

export type WarpPhase =
  | "idle"
  | "outbound"
  | "cruise"
  | "arriving"
  | "inbound"
  | "landing";

export type WarpRun = {
  /** Which journey is flying. Selects the stage and every duration. */
  journey: JourneyId;
  phase: WarpPhase;
  /** `performance.now()` when this run began. Stages derive every beat from
   *  elapsed time rather than from React re-renders. */
  startedAt: number;
  /** When deceleration began, once the destination has actually painted. */
  arrivingAt: number | null;
  /** Viewport point the launch fired from, for the ignition ring. */
  origin: { x: number; y: number } | null;
  /** Collapses every arc to a plain cross-fade. */
  reduced: boolean;
};

type WarpApi = {
  run: WarpRun;
  /** Fly `journey`. `origin` is the clicked element's rect. */
  launch: (journey: JourneyId, origin?: DOMRect | null) => void;
  /** Reverse whichever journey delivered you. False if there was none, or if
   *  a run is already in flight. */
  reenter: () => boolean;
  /** Finish the current run now: navigate if that has not happened yet, then
   *  settle. The escape hatch for an arc somebody has stopped wanting. */
  skip: () => void;
  /** Called by the arrival beacon once the destination has mounted. */
  arrive: () => void;
};

/** Stages are the only heavy part (a canvas loop each). Loaded per journey, so
 *  the chrono canvas never enters the bundle for someone who only ever
 *  launches the rocket. */
const STAGES: Record<JourneyId, ComponentType<{ run: WarpRun }>> = {
  liftoff: dynamic(
    () =>
      import("@/components/warp/liftoff-stage").then((m) => ({
        default: m.LiftoffStage,
      })),
    { ssr: false },
  ),
  chrono: dynamic(
    () =>
      import("@/components/warp/chrono-stage").then((m) => ({
        default: m.ChronoStage,
      })),
    { ssr: false },
  ),
};

const IDLE: WarpRun = {
  journey: "liftoff",
  phase: "idle",
  startedAt: 0,
  arrivingAt: null,
  origin: null,
  reduced: false,
};

const WarpContext = createContext<WarpApi | null>(null);

export function useWarp() {
  const ctx = useContext(WarpContext);
  if (!ctx) throw new Error("useWarp must be used inside <WarpProvider>");
  return ctx;
}

/**
 * Which journey — if any — dropped this visitor exactly where they stand.
 *
 * Scoped to the journey AND the destination path, not a bare boolean:
 * `BackControl` is on /pricing, on /upgrade and on every marketing doc, all of
 * which are reachable from each other. A boolean would fire a fall-to-Earth on
 * /upgrade after a /pricing -> /upgrade step — a descent that lands you back
 * in space, which reads as a glitch rather than as a journey.
 */
export function arrivedBy(): JourneyId | null {
  if (typeof window === "undefined") return null;
  try {
    return decodeArrival(
      window.sessionStorage.getItem(ARRIVED_BY_WARP_KEY),
      window.location.pathname,
    );
  } catch {
    // Safari private mode throws on sessionStorage. Falling back to "no
    // journey" costs a nicety, never a navigation.
    return null;
  }
}

function setArrival(value: string | null) {
  try {
    if (value) window.sessionStorage.setItem(ARRIVED_BY_WARP_KEY, value);
    else window.sessionStorage.removeItem(ARRIVED_BY_WARP_KEY);
  } catch {
    /* see arrivedBy */
  }
}

/**
 * Owns both journeys between the app and the marketing world.
 *
 * Mounted in the ROOT layout, above every route group: `/dashboard` is in
 * `(app)`, `/pricing` in `(marketing)` and `/upgrade` in `(checkout)`, so
 * navigating between them unmounts an entire layout subtree. Anything that has
 * to survive mid-flight cannot live inside one.
 *
 * One phase machine serves both journeys, which is what makes them mutually
 * exclusive by construction — Settings offers a rocket and a time warp as
 * adjacent buttons, and two full-screen stages must never race.
 */
export function WarpProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const reduced = usePrefersReducedMotion();
  const [run, setRun] = useState<WarpRun>(IDLE);

  // Every pending timer for the current run, cleared together on reset so a
  // second launch can never be stepped on by the first one's tail.
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  // The destination may paint before the outbound run finishes; remember that
  // we can go straight to deceleration instead of holding in cruise.
  const pageReady = useRef(false);
  const phaseRef = useRef<WarpPhase>("idle");
  const journeyRef = useRef<JourneyId>("liftoff");
  // The route swap happens on a timer, and `skip()` may need to bring it
  // forward. Either way it must happen exactly once.
  const navigated = useRef(false);

  const clearTimers = useCallback(() => {
    for (const t of timers.current) clearTimeout(t);
    timers.current = [];
  }, []);

  const after = useCallback((ms: number, fn: () => void) => {
    timers.current.push(setTimeout(fn, ms));
  }, []);

  const settle = useCallback(() => {
    clearTimers();
    pageReady.current = false;
    phaseRef.current = "idle";
    setRun(IDLE);
  }, [clearTimers]);

  const beginArrival = useCallback(() => {
    if (phaseRef.current !== "outbound" && phaseRef.current !== "cruise") return;
    phaseRef.current = "arriving";
    setRun((r) => ({ ...r, phase: "arriving", arrivingAt: performance.now() }));
    after(
      reduced ? REDUCED_MS : JOURNEYS[journeyRef.current].beats.arrivingMs,
      settle,
    );
  }, [after, reduced, settle]);

  const launch = useCallback(
    (id: JourneyId, origin?: DOMRect | null) => {
      if (phaseRef.current !== "idle") return;
      const journey = JOURNEYS[id];
      clearTimers();
      pageReady.current = false;
      navigated.current = false;
      phaseRef.current = "outbound";
      journeyRef.current = id;
      setArrival(encodeArrival(id, journey.destination));

      setRun({
        journey: id,
        phase: "outbound",
        startedAt: performance.now(),
        arrivingAt: null,
        origin: origin
          ? { x: origin.left + origin.width / 2, y: origin.top + origin.height / 2 }
          : null,
        reduced,
      });

      // Swap the route only once the stage covers the frame. Earlier than this
      // and the layout owning `[data-warp-craft]` — the element visibly leaving
      // — unmounts mid-flight.
      after(reduced ? REDUCED_MS : journey.beats.opaqueMs, () => {
        if (navigated.current) return;
        navigated.current = true;
        router.push(journey.destination);
      });

      // End of the deterministic run: decelerate if the destination is already
      // up, otherwise hold in cruise until the beacon fires.
      after(reduced ? REDUCED_MS : journey.beats.outboundMs, () => {
        if (phaseRef.current !== "outbound") return;
        if (pageReady.current) {
          beginArrival();
          return;
        }
        phaseRef.current = "cruise";
        setRun((r) => ({ ...r, phase: "cruise" }));
      });

      // A route that never resolves must not strand anyone on a black screen.
      after(CRUISE_CAP_MS, beginArrival);
    },
    [after, beginArrival, clearTimers, reduced, router],
  );

  const arrive = useCallback(() => {
    pageReady.current = true;
    if (phaseRef.current === "cruise") beginArrival();
  }, [beginArrival]);

  const reenter = useCallback(() => {
    if (phaseRef.current !== "idle") return false;
    const id = arrivedBy();
    if (!id) return false;
    const journey = JOURNEYS[id];

    clearTimers();
    navigated.current = false;
    phaseRef.current = "inbound";
    journeyRef.current = id;
    setArrival(null);
    setRun({
      journey: id,
      phase: "inbound",
      startedAt: performance.now(),
      arrivingAt: null,
      origin: null,
      reduced,
    });

    const goBack = () => {
      if (navigated.current) return;
      navigated.current = true;
      router.back();
    };
    if (reduced || journey.beats.inboundPushMs === 0) goBack();
    else after(journey.beats.inboundPushMs, goBack);

    if (!reduced) {
      // The touchdown has to fire on a timer, not on mount: the destination
      // layout remounts at whatever pace the router resolves, and a beat
      // nobody sees — because the stage is still opaque over it — is a beat
      // that did not happen.
      after(journey.beats.inboundLandingMs, () => {
        if (phaseRef.current !== "inbound") return;
        phaseRef.current = "landing";
        setRun((r) => ({ ...r, phase: "landing" }));
      });
    }
    after(reduced ? REDUCED_MS : journey.beats.inboundMs, settle);
    return true;
  }, [after, clearTimers, reduced, router, settle]);

  const skip = useCallback(() => {
    const phase = phaseRef.current;
    if (phase === "idle") return;
    const journey = JOURNEYS[journeyRef.current];
    clearTimers();
    if (!navigated.current) {
      navigated.current = true;
      if (phase === "inbound" || phase === "landing") router.back();
      else router.push(journey.destination);
    }
    settle();
  }, [clearTimers, router, settle]);

  // Escape completes a journey rather than abandoning it — the navigation is
  // already in flight, so the only thing left to skip is the waiting.
  //
  // Scoped to chrono on the way home: the rocket's 750ms fall is short enough
  // that nobody is waiting on it, and leaving it alone keeps this refactor
  // observably invisible to the lift-off.
  useEffect(() => {
    if (run.phase === "idle") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const phase = phaseRef.current;
      if (phase === "cruise") beginArrival();
      else if (
        journeyRef.current === "chrono" &&
        (phase === "inbound" || phase === "landing")
      ) {
        skip();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [run.phase, beginArrival, skip]);

  // Drives the departure animation and the scroll lock from CSS. Set on <html>
  // so the selectors can reach `[data-warp-craft]` in whichever layout is
  // mounted. The journey rides alongside the phase: both journeys share the
  // craft element, so the liftoff rules must not fire on a chrono departure.
  useEffect(() => {
    const el = document.documentElement;
    if (run.phase === "idle") {
      el.removeAttribute("data-warp");
      el.removeAttribute("data-warp-journey");
    } else {
      el.setAttribute("data-warp", run.reduced ? "reduced" : run.phase);
      el.setAttribute("data-warp-journey", run.journey);
    }
    return () => {
      el.removeAttribute("data-warp");
      el.removeAttribute("data-warp-journey");
    };
  }, [run.phase, run.reduced, run.journey]);

  useEffect(() => clearTimers, [clearTimers]);

  const api = useMemo<WarpApi>(
    () => ({ run, launch, reenter, skip, arrive }),
    [run, launch, reenter, skip, arrive],
  );

  const Stage = STAGES[run.journey];

  return (
    <WarpContext.Provider value={api}>
      {children}
      {/* Phase only leaves "idle" via a click, so this is unreachable during
          SSR and on the hydrating render — `document` is always there by the
          time the expression is evaluated. */}
      {run.phase !== "idle" && createPortal(<Stage run={run} />, document.body)}
    </WarpContext.Provider>
  );
}
```

- [ ] **Step 5: Teach `WarpLink` which journey it flies**

In `src/components/warp/warp-link.tsx`, add the prop and pass it through. The
default keeps every existing call site flying the rocket:

```tsx
export function WarpLink({
  href = "/pricing",
  journey = "liftoff",
  className,
  children,
  onClick,
  ...rest
}: React.ComponentPropsWithoutRef<"a"> & {
  href?: string;
  journey?: JourneyId;
}) {
```

Import the type:

```tsx
import type { JourneyId } from "@/lib/warp/journeys";
```

And in `handleClick`:

```tsx
      launch(journey, ref.current?.getBoundingClientRect() ?? null);
```

Add `journey` to the `useCallback` dependency array alongside `launch` and
`onClick`.

Update the component's doc comment: it currently says "A link out of the app
and into space" and claims the only destination is `/pricing`. Replace the
first line with `A link that flies one of the warp journeys.` and keep the
paragraph about degrading to an ordinary navigation.

- [ ] **Step 6: Point `BackControl` at whichever journey delivered you**

In `src/components/pricing/back-control.tsx`, swap the import:

```tsx
import { useWarp } from "@/components/warp/warp-provider";
```

(`arrivedByWarp` is gone — `reenter()` now performs the gate check itself.)

Replace the hook line and the click handler:

```tsx
  const router = useRouter();
  const { reenter, skip, run } = useWarp();
```

```tsx
      onClick={() => {
        // A second press during a chrono rewind means "stop waiting", not
        // "go back twice" — the arc is long enough that it would otherwise
        // read as a dead button.
        if (run.phase !== "idle") {
          if (run.journey === "chrono") skip();
          else router.back();
          return;
        }
        // A direct load or a shared link has no entry to go back to.
        if (window.history.length <= 1) {
          router.push("/");
          return;
        }
        // reenter() owns the router.back() call so the arc and the navigation
        // start together; it returns false when no journey delivered this
        // visitor, in which case the plain navigation still has to happen.
        if (reenter()) return;
        router.back();
      }}
```

- [ ] **Step 7: Qualify the liftoff CSS**

The phase rename breaks the existing selectors — `data-warp="ascending"` no
longer exists. In `src/app/globals.css`, change the two animation rules
(currently at lines 1283 and 1292):

```css
html[data-warp-journey="liftoff"][data-warp="outbound"] [data-warp-craft] {
```

```css
html[data-warp-journey="liftoff"][data-warp="landing"] [data-warp-craft] {
```

Leave the `html[data-warp] [data-warp-craft] { pointer-events: none; }` rule
and the `prefers-reduced-motion` block **unqualified** — both are correct for
every journey.

Update the block's header comment: it says "Lift-off: app <-> /pricing" and
that percentages mirror `lib/warp/choreography.ts`. Add a line noting the
selectors are journey-qualified because `/upgrade`'s time warp shares both the
attribute and the craft element.

- [ ] **Step 8: Verify the smoke scripts and the build**

```bash
npx tsx scripts/smoke-warp-journeys.ts && npx tsx scripts/smoke-warp-chrono.ts
```

Expected: both PASS.

```bash
npx tsc --noEmit
```

Expected: **one** error — `chrono-stage` does not exist yet. That is the only
acceptable failure; anything else is a real break. Comment out the `chrono`
entry in `STAGES` temporarily if you want a clean typecheck, and restore it in
Task 4.

- [ ] **Step 9: Verify the rocket is unchanged — the top regression risk**

Start the preview on **3001** (port 3000 belongs to the user):

```bash
PORT=3001 npx next dev
```

Then, in the browser, confirming the tab is genuinely visible first — an
occluded tab starves `rAF` and will fake animation bugs:

1. Sign in, go to Settings, click **Compare plans**. The dashboard should drop
   away with the same judder-then-climb it always had, the sky should brighten
   and go black, and `/pricing` should appear with no skeleton flash.
2. Press **Back** on `/pricing`. The fall home should be short and bumpy, ending
   with the touchdown rattle.
3. Reload `/pricing` directly and press Back. No fall — plain navigation.

Any difference in feel is a bug in this task, not a design change.

- [ ] **Step 10: Commit**

```bash
git add -A src/components/warp src/components/pricing/back-control.tsx src/lib/warp src/app/globals.css scripts/smoke-warp-journeys.ts
git commit -m "Generalize the warp provider to host two journeys"
```

---

## Task 4: The chrono door and the shutter

First end-to-end flight. The stage here is only its base and opacity ramp —
Task 5 adds the trails on top of it, so nothing built here is thrown away.

**Files:**
- Create: `src/components/warp/chrono-stage.tsx`
- Modify: `src/components/settings/plan-settings.tsx:226`
- Modify: `src/app/globals.css` (chrono shutter keyframes)

**Interfaces:**
- Consumes: `WarpRun` (Task 3), `CHRONO_OUT`, `CHRONO_IN` (Task 2), `paintSpace`, `DEEP_SPACE` from `@/lib/sky-palette`.
- Produces: `ChronoStage({ run }: { run: WarpRun })` exported from `chrono-stage.tsx`.

- [ ] **Step 1: Write the stage's base layer**

Create `src/components/warp/chrono-stage.tsx`:

```tsx
"use client";

import { useEffect, useRef } from "react";
import { CHRONO_IN, CHRONO_OUT } from "@/lib/warp/chrono";
import { span } from "@/lib/warp/choreography";
import { DEEP_SPACE, paintSpace } from "@/lib/sky-palette";
import type { WarpRun } from "@/components/warp/warp-provider";

/**
 * The time warp, painted.
 *
 * One canvas, one rAF loop, every beat derived from elapsed time rather than
 * from React state — the provider re-renders at most five times per run, which
 * is nowhere near enough to drive an animation. `run` is read through a ref so
 * a phase change never restarts the loop mid-flight.
 *
 * This file owns two layers: the deep-space base, painted once per resize and
 * blitted (it is the exact image the real starfield paints, which is what makes
 * the handoff at the end invisible), and the trail layer above it.
 */
export function ChronoStage({ run }: { run: WarpRun }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const runRef = useRef(run);
  // Synced after commit rather than during render; the loop picks the new
  // value up on its next frame, which is 16ms it will never notice.
  useEffect(() => {
    runRef.current = run;
  }, [run]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let width = 0;
    let height = 0;
    let dpr = 1;
    let space: HTMLCanvasElement | null = null;

    function paintSpaceLayer() {
      const off = document.createElement("canvas");
      off.width = Math.floor(width * dpr);
      off.height = Math.floor(height * dpr);
      const bctx = off.getContext("2d");
      if (!bctx) return;
      bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      paintSpace(bctx, width, height);
      space = off;
    }

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas!.width = Math.floor(width * dpr);
      canvas!.height = Math.floor(height * dpr);
      canvas!.style.width = `${width}px`;
      canvas!.style.height = `${height}px`;
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      paintSpaceLayer();
    }

    /**
     * How much of the frame the stage covers, 0 to 1.
     *
     * Opening: the shutter window, which is also when the route swap hides
     * behind it. Closing: the arriving window, cross-fading into the real
     * starfield underneath, and the landing window on the way home, where the
     * room lights come back up.
     */
    function coverage(now: number) {
      const r = runRef.current;
      if (r.reduced) return 1;
      const elapsed = now - r.startedAt;
      if (r.phase === "arriving") {
        const since = r.arrivingAt === null ? 0 : now - r.arrivingAt;
        // Hold through the collapse, then hand off.
        return 1 - span(since, [380, 620]);
      }
      if (r.phase === "inbound" || r.phase === "landing") {
        const [from, to] = CHRONO_IN.landing;
        return 1 - span(elapsed, [from, to]);
      }
      return span(elapsed, CHRONO_OUT.shutter);
    }

    function frame() {
      const now = performance.now();
      ctx!.clearRect(0, 0, width, height);
      ctx!.fillStyle = DEEP_SPACE;
      ctx!.fillRect(0, 0, width, height);
      if (space) ctx!.drawImage(space, 0, 0, width, height);

      canvas!.style.opacity = String(coverage(now));
      raf = requestAnimationFrame(frame);
    }

    resize();
    window.addEventListener("resize", resize);
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-[100] h-full w-full"
      style={{ opacity: 0 }}
    />
  );
}
```

- [ ] **Step 2: Add the shutter CSS**

Append to `src/app/globals.css`, after the liftoff block:

```css
/* ── Time warp: Settings <-> /upgrade ──
 *
 * The chrono journey does not fly anywhere, so nothing translates. The room
 * simply goes dark as the exposure opens: the shell loses contrast and
 * recedes a fraction while the canvas stage fades up over it. Coming home it
 * runs backwards, which is also how the dark-to-light theme boundary is
 * crossed.
 *
 * Windows mirror CHRONO_OUT.shutter and CHRONO_IN.landing in
 * `lib/warp/chrono.ts`. Change one, change both. */

@keyframes chrono-craft-dim {
  0% {
    transform: scale(1);
    filter: saturate(1) brightness(1);
  }
  100% {
    transform: scale(0.985);
    filter: saturate(0.35) brightness(0.42);
  }
}

html[data-warp-journey="chrono"][data-warp="outbound"] [data-warp-craft],
html[data-warp-journey="chrono"][data-warp="cruise"] [data-warp-craft],
html[data-warp-journey="chrono"][data-warp="arriving"] [data-warp-craft] {
  animation: chrono-craft-dim 380ms cubic-bezier(0.4, 0, 0.6, 1) both;
  will-change: transform, filter;
}

/* Coming home: the last 250ms of the return arc, played forwards out of the
   dimmed state. `reverse` rather than a second keyframe block so the two can
   never drift apart. */
html[data-warp-journey="chrono"][data-warp="landing"] [data-warp-craft] {
  animation: chrono-craft-dim 250ms cubic-bezier(0.4, 0, 0.6, 1) reverse both;
  will-change: transform, filter;
}

/* Held dimmed for the whole rewind, so the room does not brighten early. */
html[data-warp-journey="chrono"][data-warp="inbound"] [data-warp-craft] {
  transform: scale(0.985);
  filter: saturate(0.35) brightness(0.42);
}
```

- [ ] **Step 3: Open the door in Settings**

In `src/components/settings/plan-settings.tsx`, replace the `Link` at line 226:

```tsx
          {isFree && (
            /* Points at the transaction page, not back at /pricing — that round
               trip was a loop with no way to actually pay at either end.
               Flies the chrono journey: a time warp forward to the orbit you
               would have without the ceiling. Only rendered for free users, so
               a paying customer is never shown a growth story they already
               bought. */
            <WarpLink
              href="/upgrade"
              journey="chrono"
              className={cn(buttonVariants({ size: "sm" }))}
            >
              Upgrade
            </WarpLink>
          )}
```

`WarpLink` is already imported in this file. Remove the `Link` import only if
nothing else in the file uses it — check first with:

```bash
grep -n "<Link" src/components/settings/plan-settings.tsx
```

- [ ] **Step 4: Verify the flight covers the swap**

```bash
npx tsc --noEmit && npx tsx scripts/smoke-warp-journeys.ts
```

Expected: clean, and the smoke script passes.

With the preview running on 3001 and the tab genuinely visible:

1. Settings → **Upgrade**. The settings pane should dim and recede slightly,
   the frame should go to deep space, and `/upgrade` should appear underneath
   with **no white flash and no skeleton**. There are no trails yet — a black
   hold is the correct result for this task.
2. `/pricing` → **Upgrade to Orbit Pro**. Plain navigation, today's brick
   assembly, no stage.
3. Settings → **Compare plans**. The rocket, still unchanged.

If a white flash appears at the swap, `opaqueMs` is too early relative to the
shutter window — they are both 380ms and must stay equal.

- [ ] **Step 5: Commit**

```bash
git add src/components/warp/chrono-stage.tsx src/components/settings/plan-settings.tsx src/app/globals.css
git commit -m "Add the chrono stage's base layer and open the Settings door"
```

---

## Task 5: The trails

**Files:**
- Modify: `src/components/warp/chrono-stage.tsx`

**Interfaces:**
- Consumes: `chronoFrame`, `POLE`, `IGNITION_FRACTIONS`, `type ChronoPhase` (Task 2); `STAR_GOLD`, `STAR_WHITE` from `@/lib/sky-palette`.
- Produces: no new exports. `ChronoStage`'s signature is unchanged.

- [ ] **Step 1: Add the field and the trail layer**

In `src/components/warp/chrono-stage.tsx`, extend the imports:

```tsx
import {
  CHRONO_IN,
  CHRONO_OUT,
  IGNITION_FRACTIONS,
  POLE,
  chronoFrame,
  type ChronoPhase,
} from "@/lib/warp/chrono";
import { DEEP_SPACE, STAR_GOLD, STAR_WHITE, paintSpace } from "@/lib/sky-palette";
```

Add above the component:

```tsx
type Star = {
  /** Distance from the pole, in px. Fixed — stars only ever rotate. */
  radius: number;
  /** Current angle, radians. Advanced by omega each frame. */
  angle: number;
  r: number;
  gold: boolean;
  /**
   * Which ignition burst lights this star, or -1 for one that was always
   * there. A star that ignites mid-run starts accumulating trail from where it
   * appeared, so its arc is visibly shorter than its neighbours' — new
   * contacts read as younger stars with no extra machinery.
   */
  burst: number;
  /** 0..1 when the star has just ignited, decaying to nothing. */
  flash: number;
  /** Position in the growth order, 0..1. On the way home the field thins from
   *  the newest backwards. */
  born: number;
};

/** One star per this many px² of viewport, capped for ultrawide displays. */
const STAR_AREA = 2400;
const STAR_CAP = 1100;
/** How much of the field is already there when the exposure opens. The rest
 *  ignite as the orbit grows — the whole point of the journey. */
const SEED_FRACTION = 0.42;
/** Keeps the innermost radii empty so the pole never becomes a bullseye
 *  competing with the arriving page. */
const CORE = 0.07;
/** A backgrounded tab returns with an enormous delta; without this the field
 *  would snap through a whole revolution in one frame. */
const MAX_DT = 0.05;
/** How fast an ignition flash decays, per second. */
const FLASH_DECAY = 3.2;

/** The provider's phases, narrowed to the ones the beat math knows. */
function chronoPhaseOf(phase: WarpRun["phase"]): ChronoPhase {
  if (phase === "cruise") return "cruise";
  if (phase === "arriving") return "arriving";
  // "landing" is the tail of the return arc; the math treats it as one arc.
  if (phase === "inbound" || phase === "landing") return "inbound";
  return "outbound";
}
```

- [ ] **Step 2: Build the field on resize**

Inside the effect, alongside `space`, add:

```tsx
    let trail: HTMLCanvasElement | null = null;
    let trailCtx: CanvasRenderingContext2D | null = null;
    let stars: Star[] = [];
    let poleX = 0;
    let poleY = 0;
    let last = 0;
```

Then extend `resize()`, after `paintSpaceLayer()`:

```tsx
      poleX = width * POLE.x;
      poleY = height * POLE.y;

      // The trail layer is never cleared — that accumulation IS the exposure —
      // so it is its own canvas, composited over the space base each frame.
      const t = document.createElement("canvas");
      t.width = Math.floor(width * dpr);
      t.height = Math.floor(height * dpr);
      const tctx = t.getContext("2d");
      if (!tctx) return;
      tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      trail = t;
      trailCtx = tctx;

      // Far enough out to cover the corner furthest from the pole, or arcs
      // would stop short of the frame edge.
      const maxR = Math.max(
        Math.hypot(poleX, poleY),
        Math.hypot(width - poleX, poleY),
        Math.hypot(poleX, height - poleY),
        Math.hypot(width - poleX, height - poleY),
      );

      const count = Math.min(Math.floor((width * height) / STAR_AREA), STAR_CAP);
      const seeds = Math.floor(count * SEED_FRACTION);
      stars = Array.from({ length: count }, (_, i) => {
        const grown = i >= seeds;
        const rank = grown ? (i - seeds) / Math.max(1, count - seeds) : 0;
        return {
          // sqrt keeps the areal density even; CORE holds the knot open.
          radius: maxR * (CORE + (1 - CORE) * Math.sqrt(Math.random())),
          angle: Math.random() * Math.PI * 2,
          r: Math.random() * 1.15 + 0.35,
          gold: Math.random() < 0.05,
          burst: grown
            ? Math.min(
                IGNITION_FRACTIONS.length - 1,
                Math.floor(rank * IGNITION_FRACTIONS.length),
              )
            : -1,
          flash: 0,
          born: rank,
        };
      });
    }
```

- [ ] **Step 3: Draw the exposure**

Replace `frame()` entirely:

```tsx
    function frame() {
      const now = performance.now();
      const r = runRef.current;
      const dt = last === 0 ? 0 : Math.min((now - last) / 1000, MAX_DT);
      last = now;

      ctx!.clearRect(0, 0, width, height);
      ctx!.fillStyle = DEEP_SPACE;
      ctx!.fillRect(0, 0, width, height);
      if (space) ctx!.drawImage(space, 0, 0, width, height);

      // Reduced motion gets the sky and nothing else: no spin, no trails.
      if (!r.reduced && trail && trailCtx) {
        const elapsed = now - r.startedAt;
        const since = r.arrivingAt === null ? 0 : now - r.arrivingAt;
        const f = chronoFrame(chronoPhaseOf(r.phase), elapsed, since);

        // The shutter. Erasing a fraction of the layer leaves the rest as
        // trail; a low alpha leaves long arcs, 1 leaves bare points.
        trailCtx.globalCompositeOperation = "destination-out";
        trailCtx.fillStyle = `rgba(0,0,0,${f.alpha})`;
        trailCtx.fillRect(0, 0, width, height);
        trailCtx.globalCompositeOperation = "source-over";

        const step = f.omega * dt;
        for (const s of stars) {
          s.angle += step;

          if (s.burst >= 0) {
            const lit = f.bursts > s.burst && s.born < f.alive;
            if (!lit) {
              s.flash = 0;
              continue;
            }
            // First frame alight: flare, then decay to an ordinary star.
            if (s.flash === 0 && f.bursts === s.burst + 1) s.flash = 1;
          }

          const x = poleX + Math.cos(s.angle) * s.radius;
          const y = poleY + Math.sin(s.angle) * s.radius;
          if (x < -8 || x > width + 8 || y < -8 || y > height + 8) continue;

          const flare = s.flash;
          if (flare > 0) s.flash = Math.max(0, flare - dt * FLASH_DECAY);

          const rgb = s.gold || flare > 0.15 ? STAR_GOLD : STAR_WHITE;
          trailCtx.fillStyle = `rgba(${rgb},${0.55 + flare * 0.45})`;
          trailCtx.beginPath();
          trailCtx.arc(x, y, s.r * (1 + flare * 2.2), 0, Math.PI * 2);
          trailCtx.fill();
        }

        // `lighter` so the trails add light over the nebulae instead of
        // punching a hole through them.
        ctx!.globalCompositeOperation = "lighter";
        ctx!.drawImage(trail, 0, 0, width, height);
        ctx!.globalCompositeOperation = "source-over";
      }

      canvas!.style.opacity = String(coverage(now));
      raf = requestAnimationFrame(frame);
    }
```

- [ ] **Step 4: Verify the exposure by eye**

```bash
npx tsc --noEmit && npx eslint src/components/warp
```

Expected: clean.

With the preview on 3001 and the tab genuinely visible, click Settings →
**Upgrade** and confirm each of these. They are the things most likely to be
subtly wrong:

1. Stars start as **points**, not as arcs. If they are already streaking at
   t=0, `ALPHA_STILL` is too low.
2. Arcs **lengthen** as the run proceeds, and curve around a single pole up and
   to the left. If they look straight, `OMEGA_PEAK` is too low or the pole is
   off-screen.
3. New stars **appear in bursts** with a gold flare, unevenly spaced, and their
   arcs are visibly shorter than their neighbours'.
4. There is **no dense knot** at the pole.
5. The arcs **collapse back into still points** at the end, and the field left
   behind is denser than the one you started with.

- [ ] **Step 5: Commit**

```bash
git add src/components/warp/chrono-stage.tsx
git commit -m "Render the time warp as an accumulating long exposure"
```

---

## Task 6: The arrival

**Files:**
- Modify: `src/app/(checkout)/upgrade/page.tsx`
- Modify: `src/components/motion/upgrade-transition.tsx`

**Interfaces:**
- Consumes: `arrivedBy` (Task 3), `tangentForSlot` (Task 2), `useWarp` (Task 3).
- Produces: `UpgradeTransition` gains internal `mode` state; `Panel` and `HeaderPanel` signatures unchanged.

- [ ] **Step 1: Give `/upgrade` a sky and a beacon**

In `src/app/(checkout)/upgrade/page.tsx`, add the imports:

```tsx
import { LandingStarfield } from "@/components/landing/landing-visuals";
import { WarpArrivalBeacon } from "@/components/warp/warp-arrival-beacon";
```

Replace the stale comment on the root `div` — it currently argues this page has
no starfield, which is no longer true — and mount both:

```tsx
    // `landing-root` keeps the body deep-space on overscroll, exactly as
    // /pricing does. The starfield is the sky the time warp decelerates into:
    // the stage cross-fades to this exact image, so the handoff is invisible,
    // and /upgrade stops being the one black page in the marketing world.
    // Twinkle and shooting stars are Starfield's own; nothing here moves near
    // the payment form itself.
    <div className="landing-root relative min-h-screen overflow-x-clip bg-[#03050c] text-[#e8f3f1]">
      <LandingStarfield />
      {/* Ends the time warp's cruise hold. Until this mounts the stage keeps
          the exposure running, which is what covers this page's session
          resolve and three awaited reads. No-op on a direct load. */}
      <WarpArrivalBeacon />
      <UpgradeTransition maxOrder={5}>
```

The starfield renders `position: fixed`, so the root must stay free of
`transform`/`filter` — it already is. Leave the closing tags as they are.

- [ ] **Step 2: Add the resolve mode**

In `src/components/motion/upgrade-transition.tsx`, extend the imports:

```tsx
import { useEffect } from "react";
import { tangentForSlot } from "@/lib/warp/chrono";
import { arrivedBy } from "@/components/warp/warp-provider";
```

Add the constants beside the existing ones:

```tsx
/* ── Resolving out of the exposure ──
 *
 * The other arrival. Someone who time-warped in did not watch this page being
 * built, so it must not assemble — it condenses out of the star trails they
 * travelled through. Each panel starts smeared along the tangent of its own
 * arc and sharpens to rest.
 *
 * Faster than the assembly and eased rather than sprung: a spring's overshoot
 * is the click of a brick seating, which is the wrong verb for something that
 * was already there when you arrived. */
const RESOLVE_STAGGER = 0.045;
const RESOLVE_DURATION = 0.26;
const RESOLVE_BLUR = 8;
const RESOLVE_OFFSET = 14;
const RESOLVE_SCALE = 1.015;
const RESOLVE_EASE = [0.22, 0.61, 0.36, 1] as const;
```

Extend the context type and provider:

```tsx
type TransitionState = {
  exiting: boolean;
  reduced: boolean;
  maxOrder: number;
  /** "assemble" is the brick placement, for /pricing arrivals and direct
   *  loads. "resolve" is the time warp's condensation. */
  mode: "assemble" | "resolve";
  startExit: (navigate: () => void) => void;
};
```

Inside `UpgradeTransition`:

```tsx
  const [mode, setMode] = useState<"assemble" | "resolve">("assemble");

  // sessionStorage cannot be read during render without breaking hydration —
  // same reason `usePrefersReducedMotion` starts false and corrects itself. The
  // switch is invisible because it happens while the stage is still fully
  // opaque over this page: the assembly's first frames are behind the sky, the
  // same trick that hides /pricing's skeleton during a cruise hold.
  useEffect(() => {
    if (arrivedBy() === "chrono") setMode("resolve");
  }, []);
```

Pass `mode` into the context value.

- [ ] **Step 3: Give panels the resolve choreography**

Replace `usePanelMotionProps` with:

```tsx
function usePanelMotionProps(order: number) {
  const { exiting, reduced, maxOrder, mode } = usePanelTransition();

  if (mode === "resolve") {
    const t = tangentForSlot(order, maxOrder);
    return {
      initial: reduced
        ? false
        : {
            opacity: 0,
            filter: `blur(${RESOLVE_BLUR}px)`,
            scale: RESOLVE_SCALE,
            x: t.x * RESOLVE_OFFSET,
            y: t.y * RESOLVE_OFFSET,
          },
      animate: { opacity: 1, filter: "blur(0px)", scale: 1, x: 0, y: 0 },
      transition: {
        duration: RESOLVE_DURATION,
        ease: RESOLVE_EASE,
        delay: order * RESOLVE_STAGGER,
      },
    } as const;
  }

  if (exiting) {
    // Reverse order: the last piece placed is the first one taken off.
    const delay = (maxOrder - order) * EXIT_STAGGER;
    return {
      initial: false,
      animate: { opacity: 0, y: EXIT_LIFT, scale: UNSEATED_SCALE },
      transition: { duration: EXIT_DURATION, ease: "easeIn", delay },
    } as const;
  }

  const delay = order * ENTRY_STAGGER;
  return {
    initial: reduced
      ? false
      : { opacity: 0, y: ENTRY_RISE, scale: UNSEATED_SCALE },
    animate: { opacity: 1, y: 0, scale: SEATED_SCALE },
    transition: {
      ...ENTRY_SPRING,
      delay,
      opacity: { duration: ENTRY_FADE_DURATION, ease: "easeOut", delay },
    },
  } as const;
}
```

- [ ] **Step 4: Hand Back to the right exit**

In resolve mode the page must NOT run the assembly's reverse exit — the rewind
belongs to the provider. `TransitionBackControl` becomes:

```tsx
/** Drop-in for a bare `<BackControl />` inside a page wrapped in
 *  `UpgradeTransition`. In resolve mode it steps out of the way: the visitor
 *  time-warped in, so Back is the provider's rewind, not the assembly played
 *  backwards. */
export function TransitionBackControl() {
  const { startExit, mode } = usePanelTransition();
  if (mode === "resolve") return <BackControl />;
  return <BackControl onBeforeNavigate={startExit} />;
}
```

Update the file's top doc comment: it currently describes only the assembly.
Add a paragraph naming the two arrival modes and which entry point produces
each.

- [ ] **Step 5: Verify both arrivals**

```bash
npx tsc --noEmit && npx eslint src/components/motion src/app
```

Expected: clean.

In the browser, tab visible:

1. Settings → **Upgrade**: the arcs collapse and the panels **sharpen out of
   the sky while the collapse is still finishing**. If the sky clears first and
   then the page fades in, the resolve is starting too late — it must begin at
   the start of `arriving`, not after it.
2. The starfield is still there afterwards, twinkling, and a shooting star
   appears within a minute or so.
3. `/pricing` → **Upgrade to Orbit Pro**: today's brick assembly, unchanged.
4. Reload `/upgrade` directly: brick assembly, no stage, starfield present.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(checkout)/upgrade/page.tsx" src/components/motion/upgrade-transition.tsx
git commit -m "Resolve /upgrade out of the exposure and keep the sky it landed in"
```

---

## Task 7: The rewind home

**Files:**
- Modify: `src/components/motion/upgrade-transition.tsx`

**Interfaces:**
- Consumes: `useWarp().run.phase` (Task 3).
- Produces: no new exports.

- [ ] **Step 1: Dissolve the panels back into the exposure**

The provider already flies the return arc and the stage already renders it —
what is missing is the page coming apart. In resolve mode the panels watch the
journey's phase rather than a click handler, because Back is owned by
`BackControl`, not by this component.

Extend the provider import to bring in the hook:

```tsx
import { arrivedBy, useWarp } from "@/components/warp/warp-provider";
```

Then in `UpgradeTransition`, read the phase:

```tsx
  const { run } = useWarp();
  const rewinding = run.journey === "chrono" && run.phase !== "idle" && run.phase !== "outbound";
```

Add `rewinding` to the context type and value:

```tsx
  /** True once a chrono rewind is under way and the panels should smear back
   *  into the exposure. */
  rewinding: boolean;
```

- [ ] **Step 2: Branch the resolve mode on it**

In `usePanelMotionProps`, replace the `mode === "resolve"` block:

```tsx
  if (mode === "resolve") {
    const t = tangentForSlot(order, maxOrder);
    const smeared = {
      opacity: 0,
      filter: `blur(${RESOLVE_BLUR}px)`,
      scale: RESOLVE_SCALE,
      x: t.x * RESOLVE_OFFSET,
      y: t.y * RESOLVE_OFFSET,
    };

    if (rewinding) {
      // Reverse stagger, as the assembly's exit already does: the last thing
      // to resolve is the first to go.
      return {
        initial: false,
        animate: smeared,
        transition: {
          duration: 0.3,
          ease: "easeIn",
          delay: (maxOrder - order) * EXIT_STAGGER,
        },
      } as const;
    }

    return {
      initial: reduced ? false : smeared,
      animate: { opacity: 1, filter: "blur(0px)", scale: 1, x: 0, y: 0 },
      transition: {
        duration: RESOLVE_DURATION,
        ease: RESOLVE_EASE,
        delay: order * RESOLVE_STAGGER,
      },
    } as const;
  }
```

Destructure `rewinding` from `usePanelTransition()` at the top of the function
alongside `mode`.

- [ ] **Step 3: Verify the trip home**

```bash
npx tsc --noEmit && npx eslint src/components/motion
```

Expected: clean.

In the browser:

1. Settings → **Upgrade**, then **Back**. The panels should smear back into the
   sky, the arcs should re-form sweeping **the other way**, stars should go out
   in bursts, and the room should light back up as Settings returns. If the
   arcs sweep the same direction as the outbound trip, `omega` is not negative
   — re-run `npx tsx scripts/smoke-warp-chrono.ts`.
2. Press **Escape** mid-rewind: it should land immediately in Settings, not
   freeze mid-arc.
3. Press **Back a second time** mid-rewind: same immediate landing, not a
   double navigation to some earlier page.
4. Settings → **Compare plans** → **Back**: the rocket's fall, still unchanged,
   and Escape still does nothing to it.

- [ ] **Step 4: Commit**

```bash
git add src/components/motion/upgrade-transition.tsx
git commit -m "Dissolve /upgrade back into the exposure on the way home"
```

---

## Task 8: Reduced motion, the edge matrix, and the blur decision

No new features. This task decides the one thing the spec deliberately left
open, and proves the paths that are easy to leave broken.

**Files:**
- Possibly modify: `src/components/motion/upgrade-transition.tsx` (blur removal)
- Modify: `src/lib/warp/chrono.ts` (record the measured frame cost)

- [ ] **Step 1: Measure the trail loop and decide about the blur**

With the preview running and the tab visible, open DevTools → Performance,
record a Settings → Upgrade → Back round trip, and read the frame timings.

```bash
echo "record a Settings -> Upgrade -> Back round trip in the Performance panel"
```

Two decisions come out of it:

- **The trail loop.** It should sit comfortably inside the frame budget — one
  `fillRect` plus roughly a thousand small arcs. If it does not, lower
  `STAR_CAP` in `chrono-stage.tsx` until it does, and say by how much.
- **The panel blur.** `filter: blur()` on full-width panels is the known risk.
  If any frame during the resolve or dissolve exceeds the budget, **delete the
  `filter` properties** from both the `smeared` object and the resolve
  `animate` in `upgrade-transition.tsx`, keeping opacity, scale and the tangent
  offset. Do not ship a stutter, and do not leave a dead toggle behind — pick
  one and record which in the commit message.

Record the measured number in the `chrono.ts` header comment, so the next
person changing `STAR_CAP` knows what it cost before:

```ts
/**
 * ...
 * Measured cost of the trail loop at STAR_CAP stars: <fill in> ms/frame on
 * <machine>. The accumulation approach is cheap by construction — one
 * fillRect plus one arc per star — but confirm it again if the field grows.
 */
```

- [ ] **Step 2: Verify reduced motion**

In DevTools → Rendering → **Emulate CSS `prefers-reduced-motion: reduce`**,
then:

1. Settings → **Upgrade**: a plain ~200ms cross-fade. No trails, no spin, no
   blur, no dimming of the shell, and the panels simply present.
2. **Back**: the same, in reverse. No rewind.
3. The `/upgrade` starfield is still present but still — `Starfield` handles
   that itself.
4. Settings → **Compare plans**: the rocket's reduced path, unchanged.

The belt-and-braces CSS block matters here: `data-warp="reduced"` matches none
of the journey rules, so neither craft animation can be left in a half-applied
state.

- [ ] **Step 3: Walk the edge matrix**

Each of these has a specific way of going wrong. Confirm all nine:

| Path | Expected |
|---|---|
| Settings → Upgrade | Time warp, resolve arrival |
| Settings → Upgrade → Back | Rewind to Settings |
| `/pricing` → Upgrade to Orbit Pro | Plain navigation, brick assembly |
| `/pricing` → `/upgrade` → Back | Plain back, assembly reverse. **No rewind** |
| Direct load `/upgrade` | Assembly, no stage |
| Direct load `/upgrade?period=annual` | Assembly, annual preselected, no stage |
| Cmd-click Settings' Upgrade | New tab, no warp in either tab |
| Settings → Upgrade, then Back **twice quickly** | One landing in Settings, no double navigation |
| A paid user's Settings | **No Upgrade button at all** — verify by granting a plan with `npx tsx scripts/grant-plan.ts`, or by reading `isFree` in the component |

Row four is the one that would have shipped broken without the journey-aware
gate. Row eight is what `skip()` exists for.

- [ ] **Step 4: Check the billing toggle's navigation**

The spec flags this as unresolved. Read
`src/components/pricing/billing-toggle.tsx` and determine whether changing the
period **pushes** or **replaces** the URL:

```bash
grep -n "router\.\(push\|replace\)" src/components/pricing/billing-toggle.tsx
```

If it pushes, Back after toggling lands one history entry short of Settings
while still playing the full rewind. If so, change it to `router.replace` — the
period is a view preference, not a place you navigated to — and note the change
in the commit message. If it already replaces, note that and move on.

- [ ] **Step 5: Full build and lint baseline**

```bash
npx next build
```

Expected: succeeds. The build passes on `main`, so a failure here is real.

```bash
npx eslint 2>&1 | tail -5
```

Expected: **no more than 48 errors**. If the count rose, fix what this branch
added.

- [ ] **Step 6: Re-run every smoke script this branch touches**

```bash
npx tsx scripts/smoke-warp-journeys.ts && npx tsx scripts/smoke-warp-chrono.ts
```

Expected: both PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "Verify the time warp's reduced-motion, edge and performance paths"
```

---

## Done when

- Settings → `/upgrade` plays the time warp and rewinds home on Back.
- `/pricing` → `/upgrade`, direct loads and every non-plain click keep today's behaviour.
- The rocket is indistinguishable from `main`.
- `npx next build` succeeds and eslint has not exceeded 48 errors.
- Both smoke scripts pass.
- The measured frame cost is written down, and the blur either survived a measurement or was removed.
