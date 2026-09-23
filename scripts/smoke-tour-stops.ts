/**
 * The guided tour's stop table against the app it walks: every route is a real page with a
 * loading shell, every anchor id is rendered by some component, every event predicate has
 * an emitter in a real success path, the resolved list always ends on the finish card and
 * fits the three-minute budget, and a stored stop resumes sensibly.
 *
 * Run: npx tsx scripts/smoke-tour-stops.ts
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { SURFACES } from "../src/lib/surfaces";
import { placeRail } from "../src/lib/tour/rail-placement";
import { TOUR_ANCHORS, type TourAnchorId } from "../src/lib/tour/tour-anchors";
import { TOUR_EVENTS } from "../src/lib/tour/tour-events";
import {
  TOUR_STOPS,
  TOUR_STOP_IDS_LIST,
  isContactDetailPath,
  isTourStopId,
  resolveTourStops,
  resumeTourStop,
  stopMatchesPath,
} from "../src/lib/tour/tour-stops";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

const BUDGET_SECONDS = 200;
const MAX_STOPS = 12;

function main() {
  console.log("Guided tour stops…");
  const ids = TOUR_STOPS.map((s) => s.id);
  check("stop ids are unique", new Set(ids).size === ids.length);
  check("the table and the id list agree", ids.length === TOUR_STOP_IDS_LIST.length && ids.every(isTourStopId));
  check("the last stop is the finish card", TOUR_STOPS[TOUR_STOPS.length - 1].id === "finish");

  console.log("\nanchors and surfaces");
  const surfaceKeys = new Set(SURFACES.map((s) => s.key));
  const anchorIds = new Set(Object.keys(TOUR_ANCHORS));
  for (const stop of TOUR_STOPS) {
    if (stop.anchor) check(`${stop.id} anchors a registered id`, anchorIds.has(stop.anchor), stop.anchor);
    if (stop.chipAnchor) check(`${stop.id}'s chip anchor is registered`, anchorIds.has(stop.chipAnchor), stop.chipAnchor);
    if (stop.surfaceKey) check(`${stop.id}'s surface exists`, surfaceKeys.has(stop.surfaceKey), stop.surfaceKey);
    if (!stop.route.includes(":")) {
      const loading = join("src/app/(clerk)/(app)/(main)", stop.route, "loading.tsx");
      check(`${stop.id}'s page has a loading shell`, existsSync(loading), loading);
    }
  }

  console.log("\nevery anchor is rendered and every event is emitted");
  const sources = walk("src").map((f) => readFileSync(f, "utf8")).join("\n");
  for (const id of Object.keys(TOUR_ANCHORS) as TourAnchorId[]) {
    check(`tourAnchor("${id}") appears in a component`, sources.includes(`tourAnchor("${id}")`));
  }
  for (const name of Object.keys(TOUR_EVENTS)) {
    check(`emitTourEvent("${name}") appears in a success path`, sources.includes(`emitTourEvent("${name}")`));
  }
  for (const stop of TOUR_STOPS) {
    if (!stop.doneWhen || stop.doneWhen.startsWith("route:") || stop.doneWhen.startsWith("capture.")) continue;
    check(`${stop.id}'s predicate is an emitted event`, Object.hasOwn(TOUR_EVENTS, stop.doneWhen), stop.doneWhen);
  }

  console.log("\nthe resolved walk");
  const none = new Set<string>();
  const withKey = resolveTourStops({ hasApiKey: true, hidden: none });
  const noKey = resolveTourStops({ hasApiKey: false, hidden: none });
  for (const [label, list] of [["with a key", withKey], ["without a key", noKey]] as const) {
    check(`${label}: ends on finish`, list[list.length - 1].id === "finish");
    check(`${label}: at most ${MAX_STOPS} stops`, list.length <= MAX_STOPS, String(list.length));
    const seconds = list.reduce((n, s) => n + s.seconds, 0);
    check(`${label}: fits the budget (${seconds}s ≤ ${BUDGET_SECONDS}s)`, seconds <= BUDGET_SECONDS);
  }
  check("with a key: the capture stops extract, not the URL fallback", withKey.some((s) => s.id === "capture.extract") && !withKey.some((s) => s.id === "capture.linkedin"));
  check("without a key: the URL fallback, no extraction, no chat ask", noKey.some((s) => s.id === "capture.linkedin") && !noKey.some((s) => s.id === "capture.extract") && !noKey.some((s) => s.id === "chat.ask") && noKey.some((s) => s.id === "chat.preview"));
  const hiddenChat = resolveTourStops({ hasApiKey: true, hidden: new Set(["page.chat"]) });
  check("a hidden surface drops its stops", !hiddenChat.some((s) => s.route === "/chat"));
  for (const stop of TOUR_STOPS) {
    if (!stop.requiresDone) continue;
    const at = TOUR_STOPS.findIndex((s) => s.id === stop.requiresDone);
    check(`${stop.id} depends on an earlier stop`, at >= 0 && at < TOUR_STOPS.indexOf(stop), stop.requiresDone);
  }
  const imports = (requested: boolean) =>
    resolveTourStops({ hasApiKey: true, hidden: new Set(), linkedinRequested: requested }).find((s) => s.id === "imports.linkedin")!;
  check("the Imports stop talks about the export only when it was requested", imports(true).title !== imports(false).title && imports(false).anchor === imports(true).anchor);

  console.log("\nresuming");
  check("an unknown stop resumes at the first", resumeTourStop("dashboard", withKey).id === withKey[0].id);
  check("null resumes at the first", resumeTourStop(null, withKey).id === withKey[0].id);
  check("a filtered-out stop resumes at the first", resumeTourStop("chat.preview", withKey).id === withKey[0].id);
  check("a live stop resumes as itself", resumeTourStop("reminders.done", withKey).id === "reminders.done");

  console.log("\nroute matching");
  const log = TOUR_STOPS.find((s) => s.id === "contact.log")!;
  check("a contact page matches the log stop", stopMatchesPath(log, "/contacts/0b1c2d3e"));
  check("/contacts/new does not", !stopMatchesPath(log, "/contacts/new"));
  check("/contacts/duplicates does not", !stopMatchesPath(log, "/contacts/duplicates"));
  check("an exact route matches its stop", stopMatchesPath(TOUR_STOPS[0], "/dashboard") && !stopMatchesPath(TOUR_STOPS[0], "/dashboard/x"));
  check("the list page is NOT a profile (the open-a-person stop must not self-complete)", !isContactDetailPath("/contacts") && isContactDetailPath("/contacts/0b1c2d3e"));

  console.log("\nrail placement");
  const vp = { width: 1280, height: 720 };
  check("no anchor: bottom-left, expanded", JSON.stringify(placeRail(null, vp, 276)) === JSON.stringify({ flipped: false, coversCenter: false }));
  const topLeft = { left: 300, top: 120, width: 200, height: 40 };
  check("an anchor near the top leaves the card alone", !placeRail(topLeft, vp, 276).flipped && !placeRail(topLeft, vp, 276).coversCenter);
  const lowLeft = { left: 300, top: 600, width: 200, height: 40 };
  check("an anchor under the left card flips it right", placeRail(lowLeft, vp, 276).flipped && !placeRail(lowLeft, vp, 276).coversCenter);
  const wideRow = { left: 296, top: 560, width: 704, height: 60 };
  const wide = placeRail(wideRow, vp, 276);
  check("a full-width row low on the page: the side that covers less, and the centre stays clear", !wide.coversCenter);
  // On a narrow window the two spots overlap; an anchor whose centre sits in that overlap
  // cannot be dodged, and the card must shrink to its pill instead.
  const narrow = { width: 700, height: 720 };
  const unavoidable = { left: 300, top: 600, width: 180, height: 40 };
  check("an anchor no side can avoid collapses the card", placeRail(unavoidable, narrow, 92).coversCenter);
  check("…while a dodgeable one on the same window does not", !placeRail({ left: 100, top: 600, width: 120, height: 40 }, narrow, 92).coversCenter);
  // The measured card can be taller than the estimate: a row the estimate clears is still
  // under the real card, so the real size must drive the decision.
  const row = { left: 296, top: 300, width: 600, height: 40 };
  check("the pre-measure estimate clears a row ending at y=340", !placeRail(row, vp, 292).coversCenter && !placeRail(row, vp, 292).flipped);
  check("a measured 400px card catches it and flips away", placeRail(row, vp, 292, { width: 320, height: 400 }).flipped);

  console.log("\nAll guided tour stop checks passed.");
}

try {
  main();
  process.exit(0);
} catch (e) {
  console.error("\nFAILED:", e);
  process.exit(1);
}
