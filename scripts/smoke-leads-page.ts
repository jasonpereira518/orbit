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
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import type { WarmPath } from "../src/lib/leads/warm-path";
import { WarmthChip } from "../src/components/leads/warmth-chip";
import { PathSummary } from "../src/components/leads/path-summary";
import { SharingDl } from "../src/components/leads/sharing-dl";
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

/**
 * Client components under src/components/leads. Each task that adds one appends its file here,
 * so a missing file or a lost "use client" is a failed check, not a silent build surprise.
 */
const CLIENT_COMPONENTS: string[] = ["join-team-card.tsx", "team-card.tsx", "find-path.tsx"];

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

  console.log("\nwhat the page shows about a path");
  {
    const path: WarmPath = {
      warmth: "hot",
      direct: [{ teammate: { userId: "u1", name: "Alex Ng", email: "alex@acme.test" }, tier: "inner", matchedOn: "email" }],
      account: [{ teammate: { userId: "u2", name: "Priya Nair", email: "priya@acme.test" }, count: 2, bestTier: "mid" }],
    };
    const full = text(React.createElement(PathSummary, { path, companyName: "Northwind" }));
    check("names the teammate and the orbit", full.includes("Alex Ng") && full.includes("Inner orbit"), full);
    check("says how they matched", full.includes("via email"), full);
    check("says how many others they know at the company", full.includes("knows 2 others at Northwind"), full);
    check("never shows a teammate's email", !full.includes("@acme.test"), full);
    const compact = text(React.createElement(PathSummary, { path, companyName: "Northwind", compact: true }));
    check("the compact line fits a row", compact.includes("Alex (inner)") && compact.includes("Northwind via Priya"), compact);
    check("and hides emails too", !compact.includes("@acme.test"), compact);
    const nobody = text(React.createElement(PathSummary, { path: { warmth: "cold", direct: [], account: [] }, companyName: null }));
    check("an empty path says so", /nobody on your team/i.test(nobody), nobody);
    for (const warmth of ["hot", "warm", "cool", "cold"] as const) {
      check(`a ${warmth} chip has a label`, text(React.createElement(WarmthChip, { warmth })).length > 3);
    }
    const dl = text(React.createElement(SharingDl));
    check("the sharing list names both sides", dl.includes("Shared while you share") && dl.includes("Never shared"), dl);
    check("it names every fact a lookup reveals", dl.includes("by email, LinkedIn, phone or X") && dl.includes("how close the closest of them is"), dl);
  }

  console.log("\nthe leads components stay client-safe");
  {
    const dir = "src/components/leads";
    const serverOnly =
      /import\s+(?!type\b)[^;]*from\s+["'](@\/db(\/[^"']*)?|@\/lib\/teams|@\/lib\/leads\/(store|pipeline|warm-path-query)|@\/lib\/apollo)["']/;
    for (const file of readdirSync(dir).filter((f) => /\.(tsx?)$/.test(f))) {
      check(`${file} never value-imports a server module`, !serverOnly.test(code(`${dir}/${file}`)));
      const bytes = readFileSync(`${dir}/${file}`);
      check(`${file} has no mis-encoded characters`, !/\xc3\xa2\xc2[\x80-\xbf]|\xc2[\x80-\x9f]/.test(bytes.toString("latin1")));
      check(`${file} uses curly apostrophes`, !/[A-Za-z]'[A-Za-z]/.test(code(`${dir}/${file}`)));
    }
    for (const file of CLIENT_COMPONENTS) {
      const path = `${dir}/${file}`;
      check(`${file} exists and is a client component`, existsSync(path) && /^\s*"use client";/.test(readFileSync(path, "utf8")));
    }
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
