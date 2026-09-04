/**
 * The ordering rule and career line, which the page, chat, and search all depend on
 * agreeing about. Pure — no database.
 *
 * Run: npx tsx scripts/smoke-contact-profile-format.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import {
  careerLine,
  formatExperienceDates,
  orderExperiences,
  type ExperienceEntry,
} from "../src/lib/contact-profile-format";
import { normalizeCompanyKey } from "../src/lib/company-name";
import {
  parseDateRange,
  readProfileSections,
} from "../extension/src/inject/adapters/linkedin-profile";
import {
  expandProfileSections,
  isExpandControl,
  MAX_CLICKS,
} from "../extension/src/inject/dom/expand";
import { linkedinAdapter } from "../extension/src/inject/adapters/linkedin";

const FIXTURE_EXPANDED = "scripts/fixtures/linkedin-profile-expanded.html";
const FIXTURE_DETAILS = "scripts/fixtures/linkedin-profile-details-experience.html";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

function role(over: Partial<ExperienceEntry> & { organization: string }): ExperienceEntry {
  return {
    kind: "role",
    title: null,
    fieldOfStudy: null,
    startYear: null,
    startMonth: null,
    endYear: null,
    endMonth: null,
    isCurrent: false,
    sortIndex: 0,
    ...over,
  };
}

async function main() {
  // --- ordering -----------------------------------------------------------------
  const ordered = orderExperiences([
    role({ organization: "Old Co", startYear: 2010, endYear: 2014, sortIndex: 3 }),
    role({ organization: "Ramp", isCurrent: true, startYear: 2023, sortIndex: 0 }),
    role({ organization: "Stripe", startYear: 2019, endYear: 2023, sortIndex: 1 }),
    role({ organization: "Undated Co", sortIndex: 2 }),
  ]);
  check(
    "current role sorts first",
    ordered[0].organization === "Ramp",
    ordered.map((e) => e.organization).join(" > ")
  );
  check("most recent end date next", ordered[1].organization === "Stripe");
  check(
    "undated entry keeps its captured position, not the bottom",
    ordered[2].organization === "Undated Co",
    ordered.map((e) => e.organization).join(" > ")
  );
  check("oldest role last", ordered[3].organization === "Old Co");

  // Two current roles keep captured order relative to each other.
  const twoCurrent = orderExperiences([
    role({ organization: "Second", isCurrent: true, sortIndex: 1 }),
    role({ organization: "First", isCurrent: true, sortIndex: 0 }),
  ]);
  check("ties break on captured order", twoCurrent[0].organization === "First");

  // --- career line --------------------------------------------------------------
  const line = careerLine([
    role({ organization: "Ramp", isCurrent: true, sortIndex: 0 }),
    role({ organization: "Stripe", startYear: 2019, endYear: 2023, sortIndex: 1 }),
    role({ organization: "Google", startYear: 2015, endYear: 2019, sortIndex: 2 }),
    { ...role({ organization: "MIT", sortIndex: 3 }), kind: "education" },
  ]);
  check("current company has no ex- prefix", line === "Ramp, ex-Stripe, ex-Google · MIT", line ?? "null");

  const capped = careerLine([
    role({ organization: "A", isCurrent: true, sortIndex: 0 }),
    role({ organization: "B", startYear: 2020, endYear: 2023, sortIndex: 1 }),
    role({ organization: "C", startYear: 2018, endYear: 2020, sortIndex: 2 }),
    role({ organization: "D", startYear: 2016, endYear: 2018, sortIndex: 3 }),
    role({ organization: "E", startYear: 2014, endYear: 2016, sortIndex: 4 }),
    { ...role({ organization: "Waterloo", sortIndex: 5 }), kind: "education" },
  ]);
  check(
    "cap is four organizations, and a full slate drops the school",
    capped === "A, ex-B, ex-C, ex-D",
    capped ?? "null"
  );

  check("no entries means no line", careerLine([]) === null);

  // --- date formatting ----------------------------------------------------------
  check(
    "year-only range",
    formatExperienceDates(role({ organization: "X", startYear: 2019, endYear: 2023 })) ===
      "2019 – 2023"
  );
  check(
    "month precision is used when present",
    formatExperienceDates(
      role({ organization: "X", startYear: 2019, startMonth: 3, endYear: 2023, endMonth: 11 })
    ) === "Mar 2019 – Nov 2023"
  );
  check(
    "current role reads as Present",
    formatExperienceDates(role({ organization: "X", startYear: 2023, isCurrent: true })) ===
      "2023 – Present"
  );
  check("no dates means no label", formatExperienceDates(role({ organization: "X" })) === "");

  // --- normalization ------------------------------------------------------------
  check("company key collapses punctuation", normalizeCompanyKey("Google, LLC.") === "google llc");
  check("company key collapses case and spacing", normalizeCompanyKey("  STRIPE  ") === "stripe");

  // --- date range parsing (fully specified, no fixture needed) ------------------
  check(
    "month-precision range",
    JSON.stringify(parseDateRange("Mar 2019 - Nov 2023 · 4 yrs 9 mos")) ===
      JSON.stringify({ startYear: 2019, startMonth: 3, endYear: 2023, endMonth: 11, isCurrent: false })
  );
  check(
    "present means current with no end",
    JSON.stringify(parseDateRange("Apr 2023 - Present · 1 yr")) ===
      JSON.stringify({ startYear: 2023, startMonth: 4, endYear: null, endMonth: null, isCurrent: true })
  );
  check(
    "year-only range",
    JSON.stringify(parseDateRange("2015 - 2019")) ===
      JSON.stringify({ startYear: 2015, startMonth: null, endYear: 2019, endMonth: null, isCurrent: false })
  );
  check(
    "unparseable text yields nulls, never guesses",
    JSON.stringify(parseDateRange("Full-time")) ===
      JSON.stringify({ startYear: null, startMonth: null, endYear: null, endMonth: null, isCurrent: false })
  );

  // --- empty-page case (no fixture needed) ---------------------------------------
  const empty = parseHTML("<main></main>").document;
  check("an empty page asks for the fallback", readProfileSections(empty).parseIncomplete === true);

  // --- expand-control matching (pure, no fixture and no browser needed) ----------
  //
  // `isExpandControl` and `expandProfileSections`'s section-scoping are the only two
  // places in the extension that decide what gets clicked — see
  // extension/src/inject/dom/expand.ts's header for why that exception exists and how
  // tightly it is bounded. This is the one part of that module that needs no live page.
  for (const label of ["See more", "…see more", "Show all 12 experiences", "Show 3 more"]) {
    const { document: doc } = parseHTML(`<button>${label}</button>`);
    check(
      `isExpandControl recognizes "${label}"`,
      isExpandControl(doc.querySelector("button")!)
    );
  }
  {
    const { document: doc } = parseHTML("<button>Connect</button>");
    check(
      "isExpandControl rejects an unrecognized label",
      isExpandControl(doc.querySelector("button")!) === false
    );
  }
  {
    // A "Show all N" rendered as a navigating link is not an in-place expansion —
    // following it is the fallback's job, not this module's.
    const { document: doc } = parseHTML(
      '<a href="/in/someone/details/experience/">Show all 12 experiences</a>'
    );
    check(
      "isExpandControl rejects an <a href> even with a matching label",
      isExpandControl(doc.querySelector("a")!) === false
    );
  }

  // A control outside any `main section` must never be clicked — that scoping (not
  // isExpandControl, which is deliberately location-agnostic) is what keeps this module
  // from ever touching global chrome or navigation.
  const { document: outside } = parseHTML(
    "<main><button>Show all 5 experiences</button></main>"
  );
  const outsideResult = await expandProfileSections(outside);
  check(
    "a control outside any section is left alone",
    outsideResult.clicked === 0 && outsideResult.timedOut === false
  );

  const { document: inside } = parseHTML(
    "<main><section><button>Show 3 more</button></section></main>"
  );
  const insideResult = await expandProfileSections(inside);
  check(
    "a recognized control inside a section gets clicked exactly once",
    insideResult.clicked === 1 && insideResult.timedOut === false && insideResult.capped === false
  );

  // LinkedIn's real accessible-button markup duplicates the label — one copy marked
  // `aria-hidden="true"` for sighted users, one `.visually-hidden` for screen readers.
  // Raw `textContent` on that button is `"…see more…see more"`, which none of the
  // anchored `^…$` regexes match. `isExpandControl` must recognize the real shape, not
  // just a synthetic single-label button.
  {
    const { document: doc } = parseHTML(
      '<button><span aria-hidden="true">…see more</span>' +
        '<span class="visually-hidden">…see more</span></button>'
    );
    check(
      "isExpandControl recognizes LinkedIn's real duplicated-label markup",
      isExpandControl(doc.querySelector("button")!)
    );
  }
  const { document: duplicatedLabel } = parseHTML(
    "<main><section><button>" +
      '<span aria-hidden="true">Show 3 more</span>' +
      '<span class="visually-hidden">Show 3 more</span>' +
      "</button></section></main>"
  );
  const duplicatedLabelResult = await expandProfileSections(duplicatedLabel);
  check(
    "expandProfileSections clicks a real duplicated-label button end to end",
    duplicatedLabelResult.clicked === 1
  );

  // Verified failure mode from the review: `<main><nav><section><button>` — a control
  // nested under `nav` (inside `main`) must never be clicked, even though `main section
  // button` alone would match it. This is the containment property the whole exception
  // was granted on: never global navigation.
  const { document: navNested } = parseHTML(
    "<main><nav><section><button>See more</button></section></nav></main>"
  );
  const navNestedResult = await expandProfileSections(navNested);
  check(
    "a control inside <nav>, even nested under a <section>, is never clicked",
    navNestedResult.clicked === 0,
    JSON.stringify(navNestedResult)
  );

  // A "not the subject" section — "People also viewed" and friends — reuses the same
  // denylist the READ path (`cleanText`) uses, so it must be excluded from the click path
  // too, even without a <nav>/<aside> wrapper.
  const { document: promoted } = parseHTML(
    "<main><section><h2>People also viewed</h2><ul><li>" +
      "<button>Show 3 more</button></li></ul></section></main>"
  );
  const promotedResult = await expandProfileSections(promoted);
  check(
    "a control inside a denylisted section (e.g. People also viewed) is never clicked",
    promotedResult.clicked === 0,
    JSON.stringify(promotedResult)
  );

  // The click cap must actually bite before the page runs out of controls — otherwise a
  // long enough profile could click indefinitely. ~3s runtime (MAX_CLICKS * 250ms settle).
  const manyControls = Array.from(
    { length: MAX_CLICKS + 5 },
    (_, i) => `<button>Show ${i + 1} more</button>`
  ).join("");
  const { document: manyControlsDoc } = parseHTML(`<main><section>${manyControls}</section></main>`);
  const cappedResult = await expandProfileSections(manyControlsDoc);
  check(
    "the click cap bites before the page runs out of recognized controls",
    cappedResult.clicked === MAX_CLICKS &&
      cappedResult.capped === true &&
      cappedResult.timedOut === false,
    JSON.stringify(cappedResult)
  );

  // --- the ordinary read path must never click anything ---------------------------
  //
  // The single most important property in this task: opening the panel on a LinkedIn
  // profile — `linkedinAdapter.extract(url)` with no `options` — must click nothing and
  // must synchronously emit `schemaVersion: 1` with no `profile`. Only an explicit
  // `options.withProfile` (the "Capture experience" press) may ever reach
  // `expandProfileSections`. This is the one property that was previously asserted only
  // by code inspection, never exercised.
  {
    const url = new URL("https://www.linkedin.com/in/ada");
    const { document: doc, window: win } = parseHTML(
      "<html><body><main><h1>Ada Lovelace</h1><section>" +
        "<button>See more</button></section></main></body></html>"
    );
    (win as unknown as { location: URL }).location = url;
    let clicked = false;
    doc.querySelector("button")!.addEventListener("click", () => {
      clicked = true;
    });
    (globalThis as unknown as { document: Document }).document = doc as unknown as Document;
    (globalThis as unknown as { window: Window }).window = win as unknown as Window;
    try {
      const result = linkedinAdapter.extract(url);
      check(
        "extract() with no options is synchronous, not a Promise",
        !(result instanceof Promise)
      );
      if (result instanceof Promise) throw new Error("unreachable — just asserted above");
      check("an ordinary read reports schemaVersion 1", result.schemaVersion === 1);
      check("an ordinary read carries no profile", !("profile" in result));
      check("an ordinary read clicks nothing on the page", clicked === false);
    } finally {
      delete (globalThis as { document?: unknown }).document;
      delete (globalThis as { window?: unknown }).window;
    }
  }

  // --- adapter section readers over saved markup ---------------------------------
  //
  // These fixtures are real rendered LinkedIn pages, saved from a signed-in browser by a
  // human (see scripts/fixtures/README.md). They cannot be fabricated here: synthetic
  // markup would only prove the selectors match an invention, not the real page — the
  // exact failure this test exists to catch. When LinkedIn ships a redesign this is the
  // test that fails, which is the whole point: the selectors rot silently otherwise, and
  // the AI fallback would quietly absorb the cost forever.
  const fixturesPresent = existsSync(FIXTURE_EXPANDED) && existsSync(FIXTURE_DETAILS);

  if (!fixturesPresent) {
    const requireFixtures = process.env.ORBIT_REQUIRE_FIXTURES === "1";
    const banner = [
      "",
      "#".repeat(78),
      "#  PENDING: LinkedIn profile fixtures are missing.",
      "#  The following behaviors are UNVERIFIED against real LinkedIn markup:",
      "#    - role extraction from an expanded profile page",
      "#    - current-role detection (exactly one role marked isCurrent)",
      "#    - education entries classified as kind: \"education\"",
      "#    - About section extraction",
      "#    - the /details/experience subpage path",
      "#  Missing:",
      `#    ${FIXTURE_EXPANDED}`,
      `#    ${FIXTURE_DETAILS}`,
      "#  See scripts/fixtures/README.md for how to capture them from a signed-in",
      "#  LinkedIn session. Until they exist, readProfileSections' selectors are",
      "#  UNVERIFIED against real markup — only parseDateRange and the empty-page",
      "#  case above have real coverage.",
      "#".repeat(78),
      "",
    ].join("\n");
    console.log(banner);
    // Machine-readable marker for scripts/run-smoke.ts: it greps captured stdout for a
    // leading "PENDING:" line and surfaces it in the summary row (and the run-level
    // count), so a green run of the whole suite can't read as "fully verified" when a
    // script degraded instead of actually asserting something. Keep this on one line.
    console.log(
      "PENDING: LinkedIn profile fixtures missing — role extraction, current-role " +
        "detection, education classification, About extraction, and the " +
        "details-subpage path are unverified"
    );
    if (requireFixtures) {
      throw new Error(
        "ORBIT_REQUIRE_FIXTURES=1 and the LinkedIn profile fixtures are missing — see banner above"
      );
    }
  } else {
    const expanded = parseHTML(readFileSync(FIXTURE_EXPANDED, "utf8")).document;
    const read = readProfileSections(expanded);

    check(
      "reads at least four roles from an expanded page",
      read.experiences.filter((e) => e.kind === "role").length >= 4
    );
    check(
      "every entry has an organization",
      read.experiences.every((e) => e.organization.trim().length > 0)
    );
    check("at least one role is dated", read.experiences.some((e) => e.startYear !== null));
    check(
      "exactly one role is marked current",
      read.experiences.filter((e) => e.isCurrent).length === 1
    );
    check("education is read as education", read.experiences.some((e) => e.kind === "education"));
    check("about is read", (read.about ?? "").length > 20);
    check("a complete read does not ask for the fallback", read.parseIncomplete === false);

    const detailsOnly = parseHTML(readFileSync(FIXTURE_DETAILS, "utf8")).document;
    const detailsRead = readProfileSections(detailsOnly);
    check(
      "the details subpage yields roles too",
      detailsRead.experiences.filter((e) => e.kind === "role").length >= 4
    );
  }

  console.log("\ncontact profile formatting: OK");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
