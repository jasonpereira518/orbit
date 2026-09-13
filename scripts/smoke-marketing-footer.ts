/**
 * The marketing footer: one component, thumb-sized links, the header's two buttons with a
 * 44px hit area, and the landing page's closing wordmark.
 *
 * Rendering pins what a visitor can reach. The structural checks pin why the component
 * exists: the footer used to be pasted into three pages, and a fix applied to one copy is a
 * fix the other two never get.
 */
import React from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { MarketingFooter } from "../src/components/marketing/marketing-footer";
import { FooterWordmark } from "../src/components/landing/footer-wordmark";
import {
  INK_WIDTH,
  VIEW_H,
  baseColor,
  buildGrid,
  dotsNearSegment,
  flare,
  pitchFor,
  twinkle,
} from "../src/components/landing/footer-wordmark-field";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** Source with comments stripped, so prose describing a rule never counts as code. */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
}

const PAGES = [
  "src/components/landing/landing-scenes.tsx",
  "src/app/(clerk)/(marketing)/pricing/page.tsx",
  "src/app/(site)/interest/page.tsx",
];

function main() {
  console.log("Footer renders:");
  const html = renderToStaticMarkup(
    React.createElement(MarketingFooter, { className: "max-w-4xl" })
  );
  for (const href of ["/", "/pricing", "/interest", "/privacy", "/contact", "https://jasonpereira.live/"]) {
    check(`links to ${href}`, html.includes(`href="${href}"`));
  }
  const anchorClasses = [...html.matchAll(/<a\b[^>]*class="([^"]*)"/g)].map((m) => m[1]);
  check(
    "every footer link is a 44px-tall box",
    anchorClasses.length === 6 && anchorClasses.every((c) => c.split(/\s+/).includes("min-h-11")),
    `${anchorClasses.length} links`
  );
  check(
    '"Interest list" cannot wrap onto two lines',
    /class="[^"]*\bwhitespace-nowrap\b[^"]*"[^>]*>Interest list</.test(html)
  );
  check("the page's column classes are applied", html.includes("max-w-4xl"));
  check("the link row is a labelled nav landmark", html.includes('<nav aria-label="Footer"'));

  console.log("\nOne footer, not three copies:");
  for (const page of PAGES) {
    const src = code(page);
    check(`${page} renders <MarketingFooter`, src.includes("<MarketingFooter"));
    check(`${page} has no inline <footer>`, !/<footer\b/.test(src));
  }

  console.log("\nLanding wordmark:");
  const mark = renderToStaticMarkup(React.createElement(FooterWordmark));
  check("is decorative: hidden from assistive tech", /^<div\b[^>]*\baria-hidden="true"/.test(mark));
  // The canvas only fills in on hydration, so the server HTML must already hold the
  // wordmark's height, or the page's end jumps when it mounts.
  check(
    "the server HTML reserves its height",
    mark.includes(`aspect-ratio:${INK_WIDTH} / ${VIEW_H}`),
    mark.slice(0, 160)
  );
  check("draws on a canvas", mark.includes("<canvas"));
  check(
    "a vertical swipe over it still scrolls the page",
    /<canvas\b[^>]*class="[^"]*\btouch-pan-y\b/.test(mark)
  );

  console.log("\nWordmark star field:");
  const pitch = 7;
  const all = buildGrid(70, 21, pitch, () => true);
  check(
    "one dot per cell, centred across the width",
    all.length === 30 && all[0].x === 3.5 && all[9].x === 66.5 && all[0].y === 3.5,
    `${all.length} dots, first at ${all[0]?.x},${all[0]?.y}`
  );
  check("nothing outside the letters", buildGrid(70, 21, pitch, () => false).length === 0);
  const left = buildGrid(70, 21, pitch, (x) => x < 35);
  check(
    "whole dots only: a dot is kept by its centre, not clipped by the outline",
    left.length === 15 && left.every((d) => d.x < 35)
  );
  check("a zero-size field has no dots", buildGrid(0, 0, pitch, () => true).length === 0);

  // A row of dots 7px apart along y = 10.5; a swipe from far left to far right with no
  // pointer events in between must still light the dots in the middle.
  const row = buildGrid(700, 21, pitch, (_x, y) => y > 7 && y < 14);
  const swipe = dotsNearSegment(row, -50, 10.5, 750, 10.5, 20);
  check(
    "a fast swipe lights every dot it crossed, not just its ends",
    swipe.length === row.length && swipe.every(([, s]) => s > 0.999),
    `${swipe.length}/${row.length}`
  );
  const grid = buildGrid(140, 140, pitch, () => true);
  const near = dotsNearSegment(grid, 70, 70, 70, 70, 20);
  check(
    "the trail reaches only dots within its radius, strongest on the path",
    near.length > 0 &&
      near.every(([i, s]) => Math.hypot(grid[i].x - 70, grid[i].y - 70) < 20 && s > 0 && s <= 1) &&
      grid.filter((d) => Math.hypot(d.x - 70, d.y - 70) < 20).length === near.length
  );

  check("a flare starts dark and swells in", flare(0, 1000) === 0 && flare(30, 1000) > 0);
  check("a flare peaks at full brightness", Math.abs(flare(60, 1000) - 1) < 1e-9);
  check(
    "a flare fades steadily to nothing at its lifetime",
    flare(400, 1000) > flare(700, 1000) && flare(700, 1000) > 0 && flare(1000, 1000) === 0 && flare(2000, 1000) === 0
  );
  check("a dot never lit stays dark", flare(Number.NaN, 1000) === 0 && flare(-5, 1000) === 0);
  check(
    "the twinkle only ever dims the envelope",
    [100, 300, 500, 800].every((t) => twinkle(t, 1000, 1.3) <= flare(t, 1000) && twinkle(t, 1000, 1.3) > 0)
  );
  check(
    "the field fades in from nothing at the top to gold at the bottom",
    baseColor(0)[3] === 0 && baseColor(1).join() === "242,193,78,1" && baseColor(0.2)[3] > 0
  );
  check(
    "dots stay one size across screens, with a floor for phones",
    pitchFor(1152) === 7 && pitchFor(2000) === 7 && pitchFor(311) === 4.5
  );

  // Its bottom edge is the page's: anything after it (a Reveal wrapper closing, a sibling)
  // brings back the empty band below the footer. And <Reveal> would hide it forever on a
  // phone, where the whole wordmark fits inside the band its observer ignores.
  const scenes = code("src/components/landing/landing-scenes.tsx");
  check(
    "the landing page renders it after the footer",
    scenes.indexOf("<FooterWordmark") > scenes.indexOf("<MarketingFooter")
  );
  check(
    "it is the last thing in the finale, not wrapped in <Reveal>",
    /<FooterWordmark\b[^>]*\/>\s*<\/section>/.test(scenes)
  );
  for (const page of PAGES.slice(1)) {
    check(`${page} ends on the plain footer`, !code(page).includes("FooterWordmark"));
  }

  console.log("\nHeader buttons:");
  const auth = code("src/components/landing/landing-auth-controls.tsx");
  for (const name of ["ghostClass", "solidClass"]) {
    const value = new RegExp(`const ${name}\\s*=\\s*"([^"]*)"`).exec(auth)?.[1] ?? "";
    const classes = value.split(/\s+/);
    check(
      `${name} extends its hit area to 44px`,
      ["relative", "after:absolute", "after:inset-x-0", "after:-inset-y-1"].every((c) => classes.includes(c)),
      value || "not found"
    );
  }

  if (failures > 0) {
    console.error(`\nFAILED: ${failures} check(s).`);
    process.exit(1);
  }
  console.log("\nMarketing footer and header targets are thumb-sized.");
  process.exit(0);
}

main();
