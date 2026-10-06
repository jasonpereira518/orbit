/**
 * The "Last spoken" ordering and the "gone quiet" filter on /contacts.
 *
 * Why this exists at all: the list already had a `recent` sort, and `recent` orders by
 * `updated_at` — a column that moves whenever ANY write touches the row, including an
 * import, an enrichment pass or an avatar backfill. It answers "what changed lately", which
 * is not the question anyone is asking when they scan their contacts. "Who have I actually
 * spoken to" needs `last_interaction_at`, which only a logged interaction moves.
 *
 * The part that will break silently is pagination. `last_interaction_at` is nullable, the
 * ordering is DESC NULLS LAST, and a plain row-value cursor — `(col, id) < (NULL, x)` —
 * evaluates to NULL, which excludes every row. That does not throw; it truncates the list at
 * whatever page reaches the undated tail, and nobody notices they are missing contacts. So
 * this walks the whole list one small page at a time and asserts every contact came back
 * exactly once.
 *
 * Runs against the REAL `listContactsPage`, not a copy of its query. `requireUserId()`
 * returns "demo-user" in demo mode (no Clerk keys + NODE_ENV=development), which is the
 * whole reason this can test the shipped code path rather than a reimplementation that is
 * free to drift from it.
 *
 * Run: npx tsx scripts/smoke-contacts-last-touch.ts
 */
import "./smoke/_env";
// Assigned indirectly: `process.env.NODE_ENV` is typed readonly, and demo mode — which is
// what lets this test call the real server action — requires it.
Object.assign(process.env, { NODE_ENV: "development" });
delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
delete process.env.CLERK_SECRET_KEY;

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, userSettings } from "../src/db/schema";
import { listContactsPage } from "../src/actions/contacts";
import {
  CONTACT_SORTS,
  QUIET_OPTIONS,
  isContactSort,
  parseQuietDays,
} from "../src/lib/contacts-page";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}
function section(name: string) {
  console.log(`\n${name}`);
}

const USER = "demo-user";

function pureChecks() {
  section("The two time-ish sorts are not the same question");

  check("last_touch is offered", isContactSort("last_touch"));
  check("the legacy sorts still are", ["name", "closeness", "recent"].every(isContactSort));
  check("junk is not a sort", !isContactSort("last_touch; drop table contacts"));
  check("undefined is not a sort", !isContactSort(undefined));

  const labelOf = (v: string) => CONTACT_SORTS.find((s) => s.value === v)?.label;
  check(
    "their labels do not both read as recency",
    labelOf("last_touch") === "Last spoken" && labelOf("recent") === "Recently updated",
    `${labelOf("last_touch")} / ${labelOf("recent")} — two controls both called "Recent" is how the wrong one gets picked`
  );

  section("parseQuietDays is the only gate on the threshold");

  for (const option of QUIET_OPTIONS) {
    check(`accepts the offered ${option.value}`, parseQuietDays(option.value) === option.value);
  }
  check("accepts a string from the URL", parseQuietDays("90") === 90);
  check("rejects an unoffered interval", parseQuietDays(45) === null);
  check("rejects zero", parseQuietDays(0) === null, "0 would match everyone while the chip claimed to filter");
  check("rejects a negative", parseQuietDays(-30) === null);
  check("rejects an absurd value", parseQuietDays(99999) === null, "would match nobody, with the chip still lit");
  check("rejects junk", parseQuietDays("all of them") === null);
  check("rejects NaN", parseQuietDays(Number.NaN) === null);
  check("rejects undefined", parseQuietDays(undefined) === null);
}

async function dbChecks() {
  const db = await getDb();
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));

  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

  // Deliberately includes a tie (two contacts at 10 days) and an undated tail: the tie
  // exercises the id tiebreak, the tail exercises the NULLS LAST cursor.
  const spec: { name: string; days: number | null }[] = [
    { name: "A Yesterday", days: 1 },
    { name: "B Tied One", days: 10 },
    { name: "C Tied Two", days: 10 },
    { name: "D Month", days: 35 },
    { name: "E Quarter", days: 100 },
    { name: "F Ancient", days: 400 },
    { name: "G Never One", days: null },
    { name: "H Never Two", days: null },
  ];
  const inserted = await db
    .insert(contacts)
    .values(
      spec.map((p) => ({
        userId: USER,
        fullName: p.name,
        lastInteractionAt: p.days === null ? null : daysAgo(p.days),
        // Deliberately the inverse of last_interaction_at, so a `last_touch` sort that
        // secretly reads updated_at produces visibly the wrong order rather than passing.
        updatedAt: p.days === null ? daysAgo(1) : daysAgo(400 - p.days),
      }))
    )
    .returning();
  const nameById = new Map(inserted.map((c) => [c.id, c.fullName]));

  /** Walk every page, the way the UI's infinite scroll does. */
  async function walk(filters: Parameters<typeof listContactsPage>[0]) {
    const names: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 50; guard++) {
      const page = await listContactsPage({ ...filters, cursor: cursor ?? undefined, limit: 3 });
      names.push(...page.items.map((i) => nameById.get(i.id) ?? i.fullName));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    return names;
  }

  section("Last spoken, ordered and paginated");

  const walked = await walk({ sort: "last_touch" });
  check(
    "every contact came back exactly once",
    walked.length === spec.length && new Set(walked).size === spec.length,
    `${walked.length} of ${spec.length}: ${walked.join(", ")} — a short list here is the NULLS LAST cursor truncating the tail`
  );
  check(
    "most recently spoken to first",
    walked[0] === "A Yesterday",
    `got ${walked[0]}`
  );
  check(
    "the undated tail sorts last, not first",
    new Set(walked.slice(-2)).size === 2 &&
      walked.slice(-2).every((n) => n.startsWith("G ") || n.startsWith("H ")),
    `tail was ${walked.slice(-2).join(", ")} — DESC puts NULLs first by default, which opens the list with the people you know least about`
  );
  check(
    "the dated rows run oldest-last",
    walked.slice(0, 6).join(",").includes("F Ancient") &&
      walked.indexOf("F Ancient") === 5,
    `got ${walked.slice(0, 6).join(", ")}`
  );
  check(
    "a tie does not drop or repeat either side",
    walked.filter((n) => n.startsWith("B ") || n.startsWith("C ")).length === 2,
    "the id tiebreak has to run the same direction as the column it breaks"
  );

  section("It is genuinely not the `recent` sort");

  const byRecent = await walk({ sort: "recent" });
  check(
    "ordering by updated_at gives a different answer",
    byRecent.join(",") !== walked.join(","),
    "seeded so updated_at is the inverse of last_interaction_at; identical output means last_touch is reading the wrong column"
  );
  check("and still returns everyone", byRecent.length === spec.length);

  section("Gone quiet");

  const quiet90 = await walk({ quiet: 90, sort: "last_touch" });
  check(
    "90+ keeps only the genuinely quiet",
    quiet90.sort().join(",") === ["E Quarter", "F Ancient", "G Never One", "H Never Two"].sort().join(","),
    `got ${quiet90.join(", ")}`
  );
  check(
    "never-spoken counts as quiet",
    quiet90.some((n) => n.startsWith("G ")),
    "'never' is quieter than any threshold; excluding them hides exactly the people most at risk"
  );
  const quiet30 = await walk({ quiet: 30, sort: "last_touch" });
  check("30+ is a superset of 90+", quiet90.every((n) => quiet30.includes(n)));
  check("and excludes the recent ones", !quiet30.includes("A Yesterday") && !quiet30.includes("B Tied One"));

  const unfiltered = await walk({ sort: "last_touch" });
  check("an unparseable threshold filters nothing", (await walk({ quiet: 45, sort: "last_touch" })).length === unfiltered.length);

  section("The first page reports a total that matches the filter");

  const firstQuiet = await listContactsPage({ quiet: 90, sort: "last_touch", limit: 3 });
  check(
    "total counts the filtered set, not the whole network",
    firstQuiet.total === 4,
    `got ${firstQuiet.total} — the count has to run through the same conditions as the rows`
  );

  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
}

async function main() {
  pureChecks();
  await dbChecks();

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll contacts last-touch checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
