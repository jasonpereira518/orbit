/**
 * The ordering rule and career line, which the page, chat, and search all depend on
 * agreeing about. Pure — no database.
 *
 * Run: npx tsx scripts/smoke-contact-profile-format.ts
 */
import {
  careerLine,
  formatExperienceDates,
  orderExperiences,
  type ExperienceEntry,
} from "../src/lib/contact-profile-format";
import { normalizeCompanyKey } from "../src/lib/company-name";


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

  console.log("\ncontact profile formatting: OK");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
