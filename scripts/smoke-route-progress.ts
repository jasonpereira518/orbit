/**
 * Guards the rules behind the route-transition progress bar.
 *
 * Clicking a link in this app produced no feedback at all until the new route committed —
 * measured at 296-896ms across the sidebar's own routes (warm dev server, no throttling),
 * median 533. Nothing moved in that window, so the app looked like it had ignored the click.
 *
 * The bar that fixes it is driven by watching document clicks, because Next exposes no
 * global navigation-pending signal. That makes the "is this click a route transition"
 * predicate the whole correctness story: every case it gets wrong is a bar shown for a
 * navigation that never happens (or missing for one that does), and a progress indicator
 * that lies is worse than none.
 *
 * Pure: no DOM, no network, no database. Run: npx tsx scripts/smoke-route-progress.ts
 */
import fs from "node:fs";
import path from "node:path";
import {
  PROGRESS_DELAY_MS,
  PROGRESS_TIMEOUT_MS,
  ROUTE_PROGRESS_CEILING,
  ROUTE_PROGRESS_COMPLETE_MS,
  hasArrived,
  shouldTrackNavigation,
  type NavigationAnchor,
  type NavigationClick,
} from "../src/lib/route-progress";

/** The stylesheet is where the crawl actually lives, so the checks read it. */
let css: string | null = null;
function readCss() {
  css ??= fs.readFileSync(path.join(process.cwd(), "src", "app", "globals.css"), "utf8");
  return css;
}

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}
function section(name: string) {
  console.log(`\n${name}`);
}

const ORIGIN = "https://app.example.com";
const HERE = { pathname: "/dashboard", search: "" };

const PLAIN_CLICK: NavigationClick = {
  button: 0,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  defaultPrevented: false,
};

const click = (over: Partial<NavigationClick> = {}): NavigationClick => ({
  ...PLAIN_CLICK,
  ...over,
});
const anchor = (href: string, over: Partial<NavigationAnchor> = {}): NavigationAnchor => ({
  href,
  ...over,
});

const track = (
  c: NavigationClick,
  a: NavigationAnchor,
  here = HERE
) => shouldTrackNavigation(c, a, ORIGIN, here);

function main() {
  section("An ordinary in-app link is tracked");

  const contacts = track(click(), anchor("/contacts"));
  check("a relative href is tracked", contacts.track);
  check(
    "and resolves to the destination the bar waits for",
    contacts.track && contacts.target.pathname === "/contacts" && contacts.target.search === "",
    JSON.stringify(contacts)
  );

  const withQuery = track(click(), anchor("/contacts?q=ada"));
  check(
    "a query string is part of the destination",
    withQuery.track && withQuery.target.search === "?q=ada",
    JSON.stringify(withQuery)
  );

  check(
    "an absolute same-origin href is tracked too",
    track(click(), anchor(`${ORIGIN}/graph`)).track,
    "the sidebar uses relative hrefs, but marketing links are written out in full"
  );

  check(
    "target=_self is still this page",
    track(click(), anchor("/graph", { target: "_self" })).track
  );

  section("Clicks that will not navigate this page are ignored");

  const refused = (
    label: string,
    c: NavigationClick,
    a: NavigationAnchor,
    here = HERE
  ) => {
    const d = track(c, a, here);
    check(label, !d.track, d.track ? "was tracked" : `reason: ${d.reason}`);
  };

  refused("a middle click (new tab)", click({ button: 1 }), anchor("/contacts"));
  refused("a right click (context menu)", click({ button: 2 }), anchor("/contacts"));
  refused("cmd-click", click({ metaKey: true }), anchor("/contacts"));
  refused("ctrl-click", click({ ctrlKey: true }), anchor("/contacts"));
  refused("shift-click (new window)", click({ shiftKey: true }), anchor("/contacts"));
  refused("alt-click (download in some browsers)", click({ altKey: true }), anchor("/contacts"));

  refused(
    "a click something else already handled",
    click({ defaultPrevented: true }),
    anchor("/contacts"),
  );
  refused("a download link", click(), anchor("/export.csv", { hasDownload: true }));
  refused("target=_blank", click(), anchor("/contacts", { target: "_blank" }));
  refused("rel=external", click(), anchor("/contacts", { rel: "noopener external" }));
  refused("another origin", click(), anchor("https://linkedin.com/in/ada"));
  refused("a mailto", click(), anchor("mailto:dana@example.com"));
  refused("an sms link", click(), anchor("sms:+14155550123"));
  refused("an empty href", click(), anchor(""));

  section("The same page is not a navigation");

  refused("re-clicking the link you are already on", click(), anchor("/dashboard"));
  refused(
    "a bare hash on the current page",
    click(),
    anchor("#settings-outreach"),
    { pathname: "/settings", search: "" }
  );
  refused(
    "an anchor into the page you are already on",
    click(),
    anchor("/settings#settings-ai"),
    { pathname: "/settings", search: "" }
  );

  check(
    "but the same path with a DIFFERENT query is a real navigation",
    track(click(), anchor("/contacts?q=ada"), { pathname: "/contacts", search: "" }).track,
    "the A-Z rail and the search box both navigate by query string alone"
  );
  check(
    "and leaving a query for the bare path is too",
    track(click(), anchor("/contacts"), { pathname: "/contacts", search: "?q=ada" }).track
  );
  check(
    "a hash on a DIFFERENT page navigates",
    track(click(), anchor("/settings#settings-ai"), HERE).track
  );

  section("Arrival");

  check(
    "the bar clears when the committed route matches",
    hasArrived({ pathname: "/contacts", search: "" }, { pathname: "/contacts", search: "" })
  );
  check(
    "a different path has not arrived",
    !hasArrived({ pathname: "/contacts", search: "" }, { pathname: "/graph", search: "" })
  );
  check(
    "the same path with the wrong query has not arrived",
    !hasArrived(
      { pathname: "/contacts", search: "?q=ada" },
      { pathname: "/contacts", search: "" }
    ),
    "otherwise a search navigation would clear the bar before its results existed"
  );

  section("The crawl never claims to be finished");

  // The crawl itself is a CSS animation — it has to be, because the moment the bar most
  // needs to move is the moment React is busy rendering the route it reports on, and a
  // measured setTimeout at 150ms did not paint until the transition committed 331-784ms
  // later. What is assertable here is the contract that animation has to honour.
  check(
    "the crawl stops short of full",
    ROUTE_PROGRESS_CEILING < 1,
    `${ROUTE_PROGRESS_CEILING} — a bar that fills while the work continues claims to be done`
  );
  check(
    "but goes far enough to read as real progress",
    ROUTE_PROGRESS_CEILING > 0.75,
    `${ROUTE_PROGRESS_CEILING}`
  );
  check(
    "the final keyframe in globals.css matches that ceiling",
    readCss().includes(`scaleX(${ROUTE_PROGRESS_CEILING})`),
    "the constant and the stylesheet have to agree, or one of them is decoration"
  );
  check(
    "the crawl is a transform, not a width",
    /@keyframes route-progress-crawl[\s\S]*?\n\}/.exec(readCss())?.[0].includes("scaleX") === true &&
      !/@keyframes route-progress-crawl[\s\S]*?\n\}/.exec(readCss())?.[0].includes("width:"),
    "width is laid out on the main thread; the bar exists precisely because that thread is busy"
  );
  check(
    "the running state carries the debounce as an animation-delay",
    /\[data-route-progress="running"\][\s\S]*?\n\}/.exec(readCss())?.[0].includes(`${PROGRESS_DELAY_MS}ms`) === true,
    `expected a ${PROGRESS_DELAY_MS}ms delay so a fast navigation shows nothing`
  );
  check(
    "reduced motion is handled",
    readCss().includes("prefers-reduced-motion") &&
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?route-progress/.test(readCss())
  );

  section("Timings");

  check(
    "the debounce is long enough to hide an instant navigation",
    PROGRESS_DELAY_MS >= 100,
    `${PROGRESS_DELAY_MS}ms`
  );
  check(
    "and short enough to still catch the median measured transition",
    PROGRESS_DELAY_MS < 533,
    "measured median on this app's own routes was 533ms"
  );
  check(
    "the bar always ends, even if nothing ever arrives",
    PROGRESS_TIMEOUT_MS > 0 && PROGRESS_TIMEOUT_MS <= 60_000,
    `${PROGRESS_TIMEOUT_MS}ms`
  );
  check(
    "the completion gesture is long enough to be seen and short enough not to delay",
    ROUTE_PROGRESS_COMPLETE_MS >= 150 && ROUTE_PROGRESS_COMPLETE_MS <= 600,
    `${ROUTE_PROGRESS_COMPLETE_MS}ms`
  );

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll route-progress checks passed.");
  process.exit(0);
}

main();
