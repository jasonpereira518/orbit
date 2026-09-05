/**
 * The events UI's honest copy, and the structural rules that keep it honest.
 *
 * Two classes of thing are pinned here.
 *
 * The first is `blockedByPlan`. It is threaded from `ingestEvents` through `ConnectSummary`
 * to a card, and a wiring mistake at any layer degrades silently to a number that never
 * renders — so "we dropped four people because your plan is full" would look exactly like
 * "we added everyone". That is the one outcome a user must not miss, and a render check
 * catches it where a click-through easily would not.
 *
 * The second is structural: the client components must not reach the database (a client
 * component transitively importing `@/db` fails the build with a `node:fs` chunking error
 * naming neither file, per `src/lib/surfaces.ts`), the shared header must not fetch, and the
 * background sync must never create contacts.
 */
import React from "react";
import { readFileSync } from "node:fs";

/**
 * Read a module with its comments stripped.
 *
 * The structural checks below look for imports and calls, and every one of these files
 * DESCRIBES the rule it follows in its own header — so matching raw source finds the prose
 * and reports a violation that does not exist. Strip first, then assert on code.
 */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
}
import { renderToStaticMarkup } from "react-dom/server";
import { EventsHeader } from "../src/components/events/events-header";
import { IngestResultCard } from "../src/components/events/ingest-result-card";
import { EventCard } from "../src/components/events/event-card";
import { APP_NAV_CORE, MOBILE_MORE_NAV } from "../src/components/layout/app-nav";
import { surfaceKeyForHref } from "../src/lib/surfaces";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

function html(el: React.ReactElement): string {
  return renderToStaticMarkup(el);
}

function text(el: React.ReactElement): string {
  return html(el)
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

const SUMMARY = {
  created: 0,
  matched: 0,
  interactionsLogged: 0,
  blockedByPlan: 0,
  unmatched: 0,
};

function main() {
  console.log("\nthe plan cap is never swallowed");
  {
    const clean = text(React.createElement(IngestResultCard, { summary: { ...SUMMARY, created: 5, matched: 2 } }));
    check("a clean run says what happened", clean.includes("5") && clean.includes("2"), clean);
    check("and shows no warning", !/plan/i.test(clean), clean);

    const blocked = text(
      React.createElement(IngestResultCard, { summary: { ...SUMMARY, created: 3, blockedByPlan: 4 } })
    );
    check("a capped run names the number", blocked.includes("4"), blocked);
    check("says the plan limit is full", /plan.*contact limit is full/i.test(blocked), blocked);
    check("and links to upgrade", html(React.createElement(IngestResultCard, { summary: { ...SUMMARY, blockedByPlan: 1 } })).includes('href="/upgrade"'));
    check(
      "singular vs plural is right",
      text(React.createElement(IngestResultCard, { summary: { ...SUMMARY, blockedByPlan: 1 } })).includes("person wasn't")
    );
  }
  {
    const skipped = text(React.createElement(IngestResultCard, { summary: { ...SUMMARY, unmatched: 3 } }));
    check("unreadable rows are reported, not hidden", skipped.includes("3") && /skipped/i.test(skipped), skipped);
    const partial = text(React.createElement(IngestResultCard, { summary: { ...SUMMARY, remaining: 12 } }));
    check("a partial run says how many are left", partial.includes("12"), partial);
  }

  console.log("\nthe hosted / attended distinction is visible");
  {
    const base = {
      id: "e1",
      title: "Deep Learning Summit",
      startsAt: new Date("2026-03-04T18:00:00Z"),
      venue: "Moscone",
      city: "San Francisco",
      url: null,
      source: "manual" as const,
      coverImageUrl: null,
      themeColor: "#7c3aed",
      attendeeCount: 40,
      connectedCount: 6,
    };
    const hosted = text(React.createElement(EventCard, { event: { ...base, role: "hosted" as const } }));
    const attended = text(React.createElement(EventCard, { event: { ...base, role: "attended" as const } }));
    check("a hosted event is badged", hosted.includes("Hosted"), hosted);
    check("an attended event is not", !attended.includes("Hosted"), attended);
    // Both numbers, always: "40 people" hides whether any of them became contacts.
    check("both counts are shown", attended.includes("6 of 40"), attended);
    check("a dateless event says so", text(React.createElement(EventCard, { event: { ...base, role: "attended" as const, startsAt: null } })).includes("Date not set"));
    check("a themed card renders without a cover", html(React.createElement(EventCard, { event: { ...base, role: "attended" as const } })).includes("linear-gradient"));
  }

  console.log("\nnav and surface registration");
  {
    const hrefs = APP_NAV_CORE.map((i) => i.href);
    check("/events is in the sidebar", hrefs.includes("/events"), hrefs.join(" "));
    // Without this the page is unreachable on mobile.
    check("/events is in the mobile More menu", MOBILE_MORE_NAV.some((i) => i.href === "/events"));
    // An exact-href match, or the nav cannot hide it and smoke-surface-visibility fails.
    check("/events maps to its surface key", surfaceKeyForHref("/events") === "page.events", String(surfaceKeyForHref("/events")));
  }

  console.log("\nstructure");
  {
    const headerSource = code("src/components/events/events-header.tsx");
    // Rendered by BOTH page.tsx and loading.tsx, so the pixels match across the streaming
    // handoff. A fetch here would run twice and defeat the point.
    check(
      "the shared header does not fetch",
      !headerSource.includes("await") && !headerSource.includes("@/actions")
    );
    check(
      "and it renders standalone, with no props",
      text(React.createElement(EventsHeader)).includes("Events")
    );

    for (const file of [
      "src/components/events/attendee-roster.tsx",
      "src/components/events/cover-palette-probe.tsx",
      "src/components/events/roster-import-panel.tsx",
      "src/components/events/event-connections-card.tsx",
    ]) {
      const source = code(file);
      // A VALUE import of the database is the failure mode: a client component that pulls it
      // in transitively fails the build with a `node:fs` chunking error naming neither file.
      // `import type` is erased before bundling, so it is allowed.
      const valueDbImport = /import\s+(?!type\b)[^;]*from\s+["']@\/db/.test(source);
      const storeImport = /from\s+["']@\/lib\/events\/store["']/.test(source);
      check(`${file.split("/").pop()} never value-imports the store or db`, !valueDbImport && !storeImport);
    }

    // The rule that keeps the plan cap honest: the connector fills the roster, the human
    // decides who becomes a contact.
    const sync = code("src/lib/events/sync.ts");
    check("the background sync never calls ingestEvents", !sync.includes("ingestEvents"));

    // theme.ts is imported by a client component, so it must stay free of server-only deps.
    const theme = code("src/lib/events/theme.ts");
    check("theme.ts stays client-safe", !/@\/db|next\/server|next\/cache/.test(theme));
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll events page checks passed.");
}

main();
