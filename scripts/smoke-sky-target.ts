/**
 * The background gate: over what may the sky answer?
 *
 * The interactive starfield only starts its constellation search when the
 * cursor rests over background (`lib/sky-target.ts`). Two failures, opposite
 * directions, both invisible in code review:
 *
 *   - too broad a content list and the feature dies silently — the cursor
 *     rests, and nothing ever happens, anywhere on the page;
 *   - too narrow and a constellation is drawn across the signup form, with its
 *     name in gold caps over somebody's paragraph.
 *
 * linkedom rather than a browser: the function takes `{ closest }` and nothing
 * else, exactly so this can be an ordinary pure smoke.
 *
 * Run: npx tsx scripts/smoke-sky-target.ts
 */
import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { SKY_CONTENT_SELECTOR, isSkyTarget } from "../src/lib/sky-target";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const { document } = parseHTML(`<html><body>
  <div class="landing-root">
    <header><nav><a id="nav-link" href="/">Orbit</a></nav></header>
    <main>
      <section><ul><li id="row"><p id="copy">Written by a person</p></li></ul></section>
      <div id="gap" class="mt-24"></div>
      <div id="card" class="landing-glass"><form id="form"><input id="email"></form></div>
      <div id="opt" data-sky-content><div id="opt-inner"></div></div>
    </main>
    <footer><canvas id="wordmark"></canvas></footer>
  </div>
</body></html>`);

const at = (id: string) => document.getElementById(id);
const tag = (name: string) => document.querySelector(name);

function main() {
  console.log("Ink is page:");
  check("a paragraph", !isSkyTarget(at("copy")));
  check("a list item, blank flex gaps included", !isSkyTarget(at("row")));
  check("a nav link", !isSkyTarget(at("nav-link")));
  check("the email input", !isSkyTarget(at("email")));
  check("the form inside the glass card (ancestor walk)", !isSkyTarget(at("form")));
  check("the glass card itself, margins included", !isSkyTarget(at("card")));
  check("anything inside a data-sky-content opt-in", !isSkyTarget(at("opt-inner")));
  check("the footer wordmark canvas", !isSkyTarget(at("wordmark")));

  console.log("\nLayout is sky:");
  check("the list around the items", isSkyTarget(tag("ul")));
  check("a section", isSkyTarget(tag("section")));
  check("main", isSkyTarget(tag("main")));
  check("the nav's blank band", isSkyTarget(tag("nav")));
  check("the header", isSkyTarget(tag("header")));
  check("the footer around the wordmark", isSkyTarget(tag("footer")));
  check("a bare spacer div", isSkyTarget(at("gap")));
  check("the body", isSkyTarget(document.body));
  check("the document element", isSkyTarget(document.documentElement));

  console.log("\nNothing to go on means no:");
  check("null", !isSkyTarget(null));
  check("undefined", !isSkyTarget(undefined));
  check("something without closest()", !isSkyTarget({} as never));

  console.log("\nThe selector and its callers:");
  const tokens = SKY_CONTENT_SELECTOR.split(",").map((t) => t.trim());
  const layout = ["html", "body", "div", "section", "main", "header", "footer", "nav", "ul", "ol", "form", "span"];
  check(
    "no layout wrapper is listed as content",
    !layout.some((t) => tokens.includes(t)),
    tokens.filter((t) => layout.includes(t)).join(" ")
  );
  check("glass surfaces are content", tokens.includes(".landing-glass"));
  check("the opt-in attribute is content", tokens.includes("[data-sky-content]"));
  check(
    "the join card is a glass surface, so the gate covers it",
    readFileSync("src/components/interest/interest-hero.tsx", "utf8").includes('"landing-glass ')
  );
  check(
    "the starfield gates its search on the target",
    readFileSync("src/components/landing/starfield.tsx", "utf8").includes("isSkyTarget(")
  );

  if (failures > 0) {
    console.error(`\nFAILED: ${failures} check(s).`);
    process.exit(1);
  }
  console.log("\nThe sky gate keeps the figure off the page.");
  process.exit(0);
}

main();
