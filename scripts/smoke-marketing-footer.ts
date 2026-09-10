/**
 * The marketing footer: one component, thumb-sized links, and the header's two buttons with
 * a 44px hit area.
 *
 * Rendering pins what a visitor can reach. The structural checks pin why the component
 * exists: the footer used to be pasted into three pages, and a fix applied to one copy is a
 * fix the other two never get.
 */
import React from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { MarketingFooter } from "../src/components/marketing/marketing-footer";

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
  "src/app/(marketing)/pricing/page.tsx",
  "src/app/(marketing)/interest/page.tsx",
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
