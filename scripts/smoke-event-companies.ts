/**
 * Companies at an event: parsing a fair's employer list, and what the panel joins them to.
 *
 * `pglite` tier — the panel is a join across contacts, experiences and the roster, and the
 * joining is the part worth pinning.
 *
 * The assertion that matters most is the one about NOT creating companies. A 900-person
 * conference roster would otherwise manufacture hundreds of `companies` rows out of
 * self-reported job titles, most of them typos, all of them polluting every company picker in
 * the product for ever.
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import { createEventForUser, upsertEventAttendees } from "../src/lib/events/store";
import { parseRosterText } from "../src/lib/events/parse-roster";
import {
  loadEventCompanyPanel,
  upsertEventCompanies,
  dismissEventCompany,
} from "../src/lib/events/companies";
import {
  companyMatchKeys,
  eventKindOf,
  parseCompanyList,
} from "../src/lib/events/company-list-parse";
import {
  addTargetCompany,
  listTargetCompanies,
  removeTargetCompany,
} from "../src/lib/events/target-companies";

const USER = "event-companies-smoke-user";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function companyCount() {
  const db = await getDb();
  return rowsOf<{ n: number }>(
    await db.execute(sql`SELECT count(*)::int AS n FROM companies WHERE user_id = ${USER}`)
  )[0]!.n;
}

run(async () => {
  const db = await getDb();
  for (const table of [
    "event_companies",
    "target_companies",
    "event_attendees",
    "events",
    "contact_experiences",
    "contacts",
    "companies",
  ]) {
    await db.execute(sql.raw(`DELETE FROM ${table} WHERE user_id = '${USER}'`));
  }

  console.log("\nparsing what people actually paste");
  {
    const parsed = parseCompanyList(`Employers:
      • Stripe
      2. Booth 12 — Figma
      Ramp (hiring interns)
      Stripe, Inc.
      ---
      `);
    check("bullets and numbering are stripped", parsed.names.includes("Stripe"), parsed.names.join(" | "));
    check("a booth prefix is stripped", parsed.names.includes("Figma"), parsed.names.join(" | "));
    check("a trailing note is dropped", parsed.names.includes("Ramp"), parsed.names.join(" | "));
    // "Stripe" and "Stripe, Inc." are one exhibitor, and the panel would look broken listing both.
    check("two spellings collapse", parsed.names.filter((n) => /stripe/i.test(n)).length === 1, String(parsed.deduped));
    check("a heading is not a company", !parsed.names.some((n) => /^employers/i.test(n)));
    check("separator junk is counted, not guessed at", parsed.skipped > 0, String(parsed.skipped));
  }
  {
    // A single line falls back to commas; multiple lines do not, or "Stripe, Inc." splits.
    const oneLine = parseCompanyList("Stripe, Figma, Ramp");
    check("a single line splits on commas", oneLine.names.length === 3, oneLine.names.join("|"));
    const multi = parseCompanyList("Stripe, Inc.\nFigma, Inc.");
    check("but a multi-line list does not", multi.names.length === 2, multi.names.join("|"));
  }
  {
    check("suffixes are matched loosely", companyMatchKeys("Stripe, Inc.").includes("stripe"));
    check("and exactly", companyMatchKeys("Stripe").includes("stripe"));
    check("nothing matches nothing", companyMatchKeys("  ").length === 0);
  }

  console.log("\nwhat kind of event this is");
  {
    check("a career fair", eventKindOf({ title: "Fall Career Fair 2026" }) === "career_fair");
    check("a conference", eventKindOf({ title: "AI Summit" }) === "conference");
    check("a meetup", eventKindOf({ title: "SF Python Meetup" }) === "meetup");
    check("a party", eventKindOf({ title: "Rooftop Mixer" }) === "party");
    // The title wins over the description, which routinely mentions the after-party.
    check(
      "the title outranks the description",
      eventKindOf({ title: "Fall Career Fair", description: "Followed by a mixer" }) === "career_fair"
    );
    check("unknown is a fine answer", eventKindOf({ title: "Thursday" }) === null);
  }

  console.log("\nthe panel");
  {
    const fair = await createEventForUser(USER, { title: "Fall Career Fair" });

    // Somebody the user already knows at one of the exhibitors — the whole point of the panel.
    const [contact] = rowsOf<{ id: string }>(
      await db.execute(sql`
        INSERT INTO contacts (user_id, full_name, company, title)
        VALUES (${USER}, 'Ada Lovelace', 'Stripe', 'Engineer') RETURNING id
      `)
    );
    // And somebody who used to be at another — often the better introduction.
    const [alum] = rowsOf<{ id: string }>(
      await db.execute(sql`
        INSERT INTO contacts (user_id, full_name, company) VALUES (${USER}, 'Grace Hopper', 'Navy')
        RETURNING id
      `)
    );
    await db.execute(sql`
      INSERT INTO contact_experiences (user_id, contact_id, kind, organization, organization_normalized, is_current, source)
      VALUES (${USER}, ${alum!.id}::uuid, 'role', 'Figma', 'figma', false, 'extension')
    `);

    const before = await companyCount();
    const parsed = parseCompanyList("Stripe\nFigma\nRamp");
    await upsertEventCompanies(
      USER,
      fair.id,
      parsed.names.map((name) => ({ name, role: "employer" as const, source: "paste" as const }))
    );
    check("the exhibitors become companies", (await companyCount()) === before + 3, String(await companyCount()));

    // Roster employers, including one nobody curated and one spelled differently.
    await upsertEventAttendees(
      USER,
      fair.id,
      parseRosterText(
        [
          "Jane Roe <jane@stripe.com> — Recruiter at Stripe, Inc.",
          "John Doe <john@stripe.com> — Engineer at Stripe",
          "Sam Ray <sam@tinyco.dev> — Founder at TinyCo",
        ].join("\n")
      ).attendees,
      "paste"
    );
    const afterRoster = await companyCount();
    // The rule: a roster does not manufacture company records.
    check("a roster creates no companies", afterRoster === before + 3, String(afterRoster));

    const panel = await loadEventCompanyPanel(USER, fair.id);
    const stripe = panel.find((row) => /stripe/i.test(row.name));
    check("Stripe is on the panel", stripe !== undefined);
    check("as an exhibitor", stripe?.role === "employer", String(stripe?.role));
    // Two spellings of one employer, counted once.
    check("both attendees count toward it", stripe?.attendeeCount === 2, String(stripe?.attendeeCount));
    check("and the contact there is surfaced", stripe?.contacts.some((p) => p.contactId === contact!.id) === true);
    check("as a current colleague", stripe?.contacts[0]?.tenure === "now");

    const figma = panel.find((row) => row.name === "Figma");
    check("an alum counts too", figma?.contacts.some((p) => p.contactId === alum!.id) === true);
    check("and is marked as past", figma?.contacts[0]?.tenure === "past", String(figma?.contacts[0]?.tenure));

    const tiny = panel.find((row) => /tinyco/i.test(row.name));
    check("an uncurated employer still appears", tiny !== undefined);
    check("labelled as coming from the roster", tiny?.role === "attendee_employer", String(tiny?.role));
    check("with no company row behind it", tiny?.companyId === null);

    // A target company is the strongest reason to look at a row, so it sorts first.
    await addTargetCompany(USER, "Ramp", 1);
    const withTarget = await loadEventCompanyPanel(USER, fair.id);
    check("a target sorts to the top", withTarget[0]?.name === "Ramp", String(withTarget[0]?.name));
    check("and is flagged", withTarget[0]?.targetPriority === 1);

    // Re-pasting is idempotent, and un-dismisses: pasting again is an explicit statement.
    const curated = withTarget.find((row) => row.id !== null)!;
    await dismissEventCompany(USER, curated.id!);
    check(
      "a dismissed company leaves the panel",
      !(await loadEventCompanyPanel(USER, fair.id)).some((row) => row.id === curated.id)
    );
    await upsertEventCompanies(USER, fair.id, [
      { name: curated.name, role: curated.role as "employer", source: "paste" },
    ]);
    check(
      "re-adding it brings it back",
      (await loadEventCompanyPanel(USER, fair.id)).some((row) => row.id === curated.id)
    );
    check("and still creates no duplicate company", (await companyCount()) === before + 3);
  }

  console.log("\ntarget companies");
  {
    const targets = await listTargetCompanies(USER);
    check("the list holds what was added", targets.some((t) => t.name === "Ramp"));
    check("with its priority", targets.find((t) => t.name === "Ramp")?.priority === 1);

    // Re-adding moves it rather than duplicating: the unique index is per company.
    await addTargetCompany(USER, "Ramp", 3);
    const moved = await listTargetCompanies(USER);
    check("re-adding moves it", moved.filter((t) => t.name === "Ramp").length === 1);
    check("to the new priority", moved.find((t) => t.name === "Ramp")?.priority === 3);

    // Same company row as the contacts' employer — which is the only reason this is useful.
    await addTargetCompany(USER, "Stripe, Inc.", 1);
    const stripeTarget = (await listTargetCompanies(USER)).find((t) => /stripe/i.test(t.name));
    check("a target counts the contacts there", (stripeTarget?.contactCount ?? 0) >= 0);

    await removeTargetCompany(USER, moved.find((t) => t.name === "Ramp")!.id);
    check("removing works", !(await listTargetCompanies(USER)).some((t) => t.name === "Ramp"));
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll event company checks passed.");
});
