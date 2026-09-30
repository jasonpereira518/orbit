/**
 * The dashboard preview's baked sky: it skips the washes of clusters that are not drawn as a
 * cloud (role and pair clusters), and keeps a role cluster's dotted lines dotted across the wire.
 *
 * No DB, no network, no DOM.
 * Run: npx tsx scripts/smoke-preview-sky.ts
 */
import { buildHybridGraphLayout, type NebulaData } from "../src/lib/graph-layout";
import { buildPreviewSky } from "../src/lib/graph/preview-sky";
import { expandPreviewSky } from "../src/lib/graph/preview-sky-shape";
import { anatomyFixture } from "./lib/anatomy-fixture";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) {
    throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  }
  console.log(`  ok  ${label}`);
}

function main() {
  const contacts = anatomyFixture();
  const layout = buildHybridGraphLayout(contacts, "You");
  const nebulae = layout.nodes.filter((n) => n.type === "nebula").map((n) => n.data as NebulaData);
  const forms = new Set(nebulae.map((n) => n.form));
  check(
    "the fixture shows open and binary clusters beside ring and petal ones",
    forms.has("open") && forms.has("binary") && forms.has("ring") && forms.has("petal"),
    [...forms].join(",")
  );

  const sky = buildPreviewSky(contacts, "You");
  const out = expandPreviewSky(sky);

  const washed = nebulae.filter((n) => n.form !== "open" && n.form !== "binary").length;
  const washes = out.nodes.filter((n) => n.type === "nebula");
  check("one wash per cluster that is drawn as a cloud", washes.length === washed && washed < nebulae.length, `${washes.length} vs ${washed}`);

  const stars = layout.nodes.filter((n) => n.type === "contact").length;
  check("every star survives", out.nodes.filter((n) => n.type === "contact").length === stars);

  const figureLines = layout.edges.filter((e) => e.data?.kind === "constellation" || e.data?.kind === "knows");
  check("every line survives", out.edges.length === figureLines.length, `${out.edges.length} vs ${figureLines.length}`);

  const dotted = figureLines.filter((e) => e.data?.dash).length;
  const expandedDotted = out.edges.filter((e) => e.style?.strokeDasharray !== undefined);
  check("the role cluster's lines are dotted", dotted > 0 && expandedDotted.length === dotted, `${expandedDotted.length} vs ${dotted}`);
  check(
    "dotted lines carry the same dash pattern as the chart's",
    expandedDotted.every((e) => e.style?.strokeDasharray === "2 5" && e.data?.dash?.join(",") === "2,5")
  );
  check(
    "no other line is dotted",
    out.edges.every((e) => (e.style?.strokeDasharray !== undefined) === Boolean(e.data?.dash)) &&
      out.edges.length - expandedDotted.length === figureLines.length - dotted
  );

  check("there is no rings node in the expansion", out.nodes.every((n) => n.id !== "rings" && n.type !== ("rings" as never)));
  check("no galaxy rides along", !("galaxy" in out));
  check(
    "no petal labels ride along",
    washes.every((n) => (n.data as NebulaData).parts === undefined) &&
      out.nodes.every((n) => n.type === "nebula" || n.type === "contact" || n.type === "user")
  );

  const once = JSON.stringify(sky);
  check("the dash is a compact fifth element of the style", sky.lineStyles.every((s) => s.length === 5));
  check("line styles are deduplicated", new Set(sky.lineStyles.map((s) => s.join("|"))).size === sky.lineStyles.length);
  check("the build is deterministic", once === JSON.stringify(buildPreviewSky(contacts, "You")));
}

main();
