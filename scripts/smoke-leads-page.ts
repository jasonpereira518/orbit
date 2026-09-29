/**
 * The Leads tab while it is coming soon: registered, reachable, and honest about its state.
 *
 * Pins the wiring a placeholder page can silently lose. A nav item without a surface key
 * cannot be hidden; a surface without a nav item is unreachable on mobile; a coming-soon
 * page without a `FEATURES` entry renders the generic fallback and stops promising anything;
 * a route without a feedback area files reports under "Something else". Each of those is a
 * one-line omission that no type checks, so each gets a check here.
 *
 * Structural rule, shared with the events page: the header is rendered by BOTH page.tsx and
 * loading.tsx so the streaming handoff shows identical pixels, which only works if it never
 * fetches.
 */
import React from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { APP_NAV_CORE, APP_NAV_EXTRAS, MOBILE_MORE_NAV } from "../src/components/layout/app-nav";
import { COMING_SOON_KEYS, isHrefComingSoon, surfaceKeyForHref } from "../src/lib/surfaces";
import { ComingSoon } from "../src/components/coming-soon/coming-soon";
import { LeadsHeader } from "../src/components/leads/leads-header";
import { AREA_LABELS, featureAreaForPath } from "../src/lib/feedback-report";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** A module with its comments stripped, so prose describing a rule cannot trip the rule. */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
}

function text(el: React.ReactElement): string {
  return renderToStaticMarkup(el)
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** The sentence `ComingSoon` falls back to when a surface has no `FEATURES` entry. */
const FALLBACK_TEASER = "We're still building this part of Orbit";

function main() {
  console.log("\nnav and surface registration");
  {
    const hrefs = [...APP_NAV_CORE, ...APP_NAV_EXTRAS].map((i) => i.href);
    check("/leads is in the sidebar", hrefs.includes("/leads"), hrefs.join(" "));
    // Without this the page is unreachable on mobile.
    check("/leads is in the mobile More menu", MOBILE_MORE_NAV.some((i) => i.href === "/leads"));
    // An exact-href match, or the nav cannot hide it and smoke-surface-visibility fails.
    check(
      "/leads maps to its surface key",
      surfaceKeyForHref("/leads") === "page.leads",
      String(surfaceKeyForHref("/leads"))
    );
    check("page.leads is coming soon", COMING_SOON_KEYS.has("page.leads"));
    check("so the nav item carries the Soon tag", isHrefComingSoon("/leads"));
  }

  console.log("\nthe coming-soon screen promises the feature, not the fallback");
  {
    const screen = text(React.createElement(ComingSoon, { surfaceKey: "page.leads", label: "Leads" }));
    check("names the page", screen.includes("Leads"), screen);
    check("says coming soon", /coming soon/i.test(screen), screen);
    // A missing FEATURES entry degrades to a sentence that could be about anything.
    check("has its own teaser", !screen.includes(FALLBACK_TEASER), screen);
    check("mentions the team", /team/i.test(screen), screen);
  }

  console.log("\nfeedback filed from /leads lands in its own area");
  {
    check("/leads has a feedback area", featureAreaForPath("/leads") === "leads", featureAreaForPath("/leads"));
    check("and so do its children", featureAreaForPath("/leads/anything") === "leads");
    check("with a label for the picker", AREA_LABELS.leads === "Leads", String(AREA_LABELS.leads));
  }

  console.log("\nstructure");
  {
    const headerSource = code("src/components/leads/leads-header.tsx");
    check(
      "the shared header does not fetch",
      !headerSource.includes("await") && !headerSource.includes("@/actions")
    );
    check("and it renders standalone, with no props", text(React.createElement(LeadsHeader)).includes("Leads"));

    const page = code("src/app/(clerk)/(app)/(main)/leads/page.tsx");
    const gateAt = page.indexOf("pageVisibilityGate(");
    const firstAwait = page.indexOf("await ");
    // The gate must be the first thing the page awaits: a click from a sibling route skips
    // the layout-level check, and any fetch before the gate runs for a closed page.
    check("the page gates before it does anything else", gateAt > 0 && page.indexOf("await ", gateAt - 6) === firstAwait);
    check("loading.tsx renders the same header", code("src/app/(clerk)/(app)/(main)/leads/loading.tsx").includes("LeadsHeader"));
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll leads page checks passed.");
}

main();
