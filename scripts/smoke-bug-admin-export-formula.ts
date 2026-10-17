/**
 * KNOWN BUG — documented, not fixed.
 *
 * Symptom: the admin console's CSV export writes user-typed text into the file verbatim, so a
 * waitlist signup whose first name is `=HYPERLINK("https://evil.example.com","x")` becomes a
 * live formula in the operator's spreadsheet (CSV / formula injection, CWE-1236). Spreadsheet
 * apps evaluate cells starting with `=`, `+`, `-`, `@`, tab or CR; HYPERLINK / WEBSERVICE /
 * DDE payloads can exfiltrate neighbouring cells (other people's emails) or phish the
 * operator.
 *
 * Why: `GET /api/admin/export` (src/app/api/admin/export/route.ts:91) serialises with
 * `Papa.unparse(rows)` and no `escapeFormulae` option. The interest-list dataset carries
 * strings anyone on the internet controls — `first_name` / `last_name` (validated only for
 * length by `interestNameSchema`, src/lib/interest-list-schema.ts:34), `referrer`, `utm_*`,
 * `landing_path` — and the feedback dataset carries `text` typed by any signed-in user.
 *
 * Trigger path: an anonymous visitor joins the waitlist and, on step two, enters a formula as
 * their first name (`saveInterestListNameCore`); the operator clicks "Export CSV" on the
 * interest list and opens the file in Excel / Sheets / Numbers.
 *
 * Severity: medium — needs the operator to open the file and (in most apps) accept a
 * warning, but the attacker is unauthenticated and the file holds the whole waitlist.
 *
 * Fix: `Papa.unparse(rows, { escapeFormulae: true })` (prefixes such cells with `'`), or the
 * equivalent for every CSV this route emits. This script then exits 0 and should be promoted
 * to the pglite tier.
 *
 * Runs the real route handler. The admin gate is satisfied the way a local worktree satisfies
 * it — demo mode (`NODE_ENV=development`, no Clerk publishable key), where `isAdminUser` is
 * true for the local `demo-user` (src/lib/admin.ts:55).
 *
 * Writes to local PGlite. Run: npx tsx scripts/smoke-bug-admin-export-formula.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import Papa from "papaparse";
import { getDb } from "../src/db";
import { adminAuditLog, feedback, interestListSignups } from "../src/db/schema";
import { interestNameSchema } from "../src/lib/interest-list-schema";
import { checker } from "./smoke/check";
import { fakeUserId, purgeUsers } from "./smoke/factories";

const t = checker();
const PAYLOAD = '=HYPERLINK("https://evil.example.com","x")';
const FEEDBACK_PAYLOAD = "=1+2 is what the import page showed me";
const REFERRER_PAYLOAD = "@SUM(1+1)";
const SUBMITTER = fakeUserId("export-formula");
const tag = randomUUID().slice(0, 8);
const EMAIL = `formula-${tag}@example.com`;

/** Leading characters a spreadsheet treats as the start of a formula (OWASP CSV injection). */
const FORMULA_START = /^[=+\-@\t\r]/;

run(async () => {
  // Demo mode: the only way a script satisfies `requireAdminUserId()`.
  delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  (process.env as Record<string, string>).NODE_ENV = "development";
  const { GET } = await import("../src/app/api/admin/export/route");
  const get = (qs: string) =>
    GET(new Request(`http://localhost/api/admin/export?${qs}`) as unknown as Parameters<typeof GET>[0]);

  const db = await getDb();
  await purgeUsers(db, [SUBMITTER]);

  try {
    t.check("setup: the public name form accepts a formula as a first name", interestNameSchema.safeParse({ shareToken: "tok", firstName: PAYLOAD, lastName: "Doe" }).success);

    await db.insert(interestListSignups).values({
      email: EMAIL,
      unsubscribeToken: `unsub-${tag}`,
      firstName: PAYLOAD,
      lastName: "Doe",
      referrer: REFERRER_PAYLOAD,
    });
    await db.insert(feedback).values({ userId: SUBMITTER, kind: "freeform", text: FEEDBACK_PAYLOAD });

    const waitlist = await get("dataset=interest-list&format=csv");
    t.check("the export answers 200 to an admin", waitlist.status === 200, String(waitlist.status));
    const parsed = Papa.parse<Record<string, string>>(await waitlist.text(), { header: true, skipEmptyLines: true });
    const row = parsed.data.find((r) => r.email === EMAIL);
    t.check("setup: the seeded signup is in the CSV", Boolean(row));
    t.check("the formula text survives (it is neutralised, not dropped)", Boolean(row?.first_name?.includes("HYPERLINK")));
    t.knownBug(
      "BUG: admin CSV export writes a waitlist first_name starting with '=' as a live formula",
      Boolean(row) && !FORMULA_START.test(row!.first_name),
      `first_name cell = ${JSON.stringify(row?.first_name)}`
    );
    t.knownBug(
      "BUG: admin CSV export writes a waitlist referrer starting with '@' as a live formula",
      Boolean(row) && !FORMULA_START.test(row!.referrer),
      `referrer cell = ${JSON.stringify(row?.referrer)}`
    );

    const fb = await get("dataset=feedback&format=csv");
    const fbRows = Papa.parse<Record<string, string>>(await fb.text(), { header: true, skipEmptyLines: true }).data;
    const fbRow = fbRows.find((r) => r.text?.includes("import page showed me"));
    t.check("setup: the seeded feedback is in the CSV", Boolean(fbRow));
    t.knownBug(
      "BUG: admin CSV export writes feedback text starting with '=' as a live formula",
      Boolean(fbRow) && !FORMULA_START.test(fbRow!.text),
      `text cell = ${JSON.stringify(fbRow?.text)}`
    );

    const json = await get("dataset=interest-list&format=json");
    const jsonRows = (await json.json()) as Array<Record<string, unknown>>;
    t.check("JSON export keeps the value exactly (escaping is a CSV concern only)", jsonRows.some((r) => r.first_name === PAYLOAD));
  } finally {
    await db.delete(interestListSignups).where(eq(interestListSignups.email, EMAIL));
    await purgeUsers(db, [SUBMITTER]);
    await db.delete(adminAuditLog).where(eq(adminAuditLog.adminUserId, "demo-user"));
  }

  t.done("admin export formula injection (known bug)");
});
