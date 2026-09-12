/**
 * Asserts the in-page import progress card (`ImportProgress` in
 * `src/components/imports/import-utils.tsx`) renders correctly across the shapes the job
 * runner actually produces: a live "imported" count for contact-creating kinds, a
 * differently-labeled count for calendar (which logs meetings, not contacts —
 * `contactsCreated`/`contactsUpdated` never move for it), and graceful degradation to a plain
 * row counter for any caller with no live count to report at all.
 *
 * This exists because `imported`/`importedLabel` are optional fields threaded through several
 * layers (`import-job-runner.ts` → `ImportJobSnapshot` → this component), and a wiring
 * mistake at any layer degrades silently to `undefined` rather than throwing — exactly the
 * class of bug a render check catches and a manual click-through easily misses.
 *
 * Run: npx tsx scripts/smoke-import-progress-card.ts
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ImportProgress } from "../src/components/imports/import-utils";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

function textOf(el: React.ReactElement) {
  return renderToStaticMarkup(el).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function main() {
  console.log("Import progress card…\n");

  console.log("contact-creating import (LinkedIn/Google/Outlook)");
  const withImported = textOf(
    React.createElement(ImportProgress, {
      done: 400,
      total: 2000,
      label: "people",
      startedAt: Date.now() - 20_000,
      imported: 137,
      importedLabel: "contacts imported",
    })
  );
  for (const needle of ["137", "contacts imported", "400 of 2,000 people", "20%"]) {
    check(`renders ${JSON.stringify(needle)}`, withImported.includes(needle), withImported);
  }

  console.log("\ncalendar import (logs meetings, not contacts)");
  const calendar = textOf(
    React.createElement(ImportProgress, {
      done: 12,
      total: 40,
      label: "attendees",
      startedAt: Date.now() - 5_000,
      imported: 6,
      importedLabel: "meetings logged",
    })
  );
  for (const needle of ["6", "meetings logged", "12 of 40 attendees"]) {
    check(`renders ${JSON.stringify(needle)}`, calendar.includes(needle), calendar);
  }
  check(
    "...does not claim contacts were imported",
    !calendar.includes("contacts imported")
  );

  console.log("\nno live count available");
  const noImported = textOf(
    React.createElement(ImportProgress, {
      done: 3,
      total: 10,
      label: "people",
      startedAt: Date.now() - 2_000,
    })
  );
  check("falls back to the row counter", noImported.includes("3 of 10 people"), noImported);
  check("...with no leaked undefined", !noImported.includes("undefined"));

  console.log("\ncancelling state");
  const cancelling = textOf(
    React.createElement(ImportProgress, {
      done: 3,
      total: 10,
      label: "people",
      startedAt: Date.now() - 2_000,
      imported: 1,
      importedLabel: "contacts imported",
      cancelling: true,
    })
  );
  check("shows Stopping, not Importing", cancelling.includes("Stopping"));
  check("...and not a live countdown", !cancelling.includes("left"));

  console.log("\nAll import progress card checks passed.");
}

main();
process.exit(0);
