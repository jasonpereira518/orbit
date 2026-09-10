/**
 * Duplicate prevention, at the only place it can actually be enforced.
 *
 * The properties here are the reason `contact_identities` exists at all:
 *
 *  - The same person presented twice produces ONE contact, whichever identifier they were
 *    presented by, and however the value was spelled.
 *  - A lost race converges: two contacts that both end up claiming one identifier are
 *    merged into the older of the two, and the caller is handed the survivor's id rather
 *    than a uuid that no longer exists. This is the case a "search, then insert" check
 *    cannot cover, and the whole reason for the unique index.
 *  - A record carrying identifiers held by two DIFFERENT contacts collapses them: it is
 *    direct evidence they were duplicates.
 *  - A shared mailbox (info@) is not an identity, and must not collapse the people who
 *    list it.
 *  - A name match the app is CONFIDENT about (name + company, name + title) folds on its
 *    own, before inserting, so no duplicate row is ever created. A bare full name does not:
 *    two different people can share one, so both contacts are kept and the pair is queued.
 *
 * Writes to local PGlite. Stop this worktree's dev server first — two writers corrupt it.
 * Run: npx tsx scripts/smoke-contact-resolve.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { sql } from "drizzle-orm";
import { getDb, rowsOf, closeDb } from "../src/db";
import { resolveOrCreateContact } from "../src/lib/contact-resolve";
import { backfillContactIdentities } from "../src/lib/contact-identity";
import { claimIdentities } from "../src/lib/contact-identity";
import { identityKeysFor } from "../src/lib/duplicates";
import { createContactsBulkForUser, type ContactInput } from "../src/lib/contact-writes";
import { createCompanyResolver } from "../src/lib/companies";

const USER = "contact-resolve-smoke-user";

// Bulk-path flags throughout: this script has no request scope, so revalidatePath and the
// embedding round trip must both be skipped.
const OPTS = {
  skipRevalidate: true,
  skipEmbedding: true,
  skipSummary: true,
  skipCloseness: true,
} as const;

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function reset() {
  const db = await getDb();
  await db.execute(sql`DELETE FROM contact_merges WHERE user_id = ${USER}`);
  await db.execute(sql`DELETE FROM duplicate_suggestions WHERE user_id = ${USER}`);
  await db.execute(sql`DELETE FROM contacts WHERE user_id = ${USER}`);
  await db.execute(sql`DELETE FROM companies WHERE user_id = ${USER}`);
}

async function contactCount(): Promise<number> {
  const db = await getDb();
  return rowsOf<{ v: number }>(
    await db.execute(sql`SELECT count(*)::int AS v FROM contacts WHERE user_id = ${USER}`)
  )[0]!.v;
}

const resolve = (input: ContactInput) => resolveOrCreateContact(USER, input, OPTS);

async function main() {
  await reset();
  const db = await getDb();

  // ---------------------------------------------------------------------------------
  console.log("\nThe same person, presented twice...");
  {
    const first = await resolve({
      fullName: "Ada Lovelace",
      linkedinUrl: "https://www.linkedin.com/in/adalovelace",
      company: "Analytical Engines",
    });
    // Same profile, spelled differently, with new information attached.
    const second = await resolve({
      fullName: "Ada Lovelace",
      linkedinUrl: "http://linkedin.com/in/AdaLovelace/?trk=nav",
      title: "Mathematician",
    });

    check("the second write matched rather than created", second.outcome === "matched");
    check("both resolved to one contact", first.contactId === second.contactId);
    check("only one contact exists", (await contactCount()) === 1);
    check(
      "the new field was folded in",
      (await rowsOf<{ title: string | null }>(
        await db.execute(sql`SELECT title FROM contacts WHERE id = ${first.contactId}::uuid`)
      ))[0]!.title === "Mathematician"
    );
  }

  // ---------------------------------------------------------------------------------
  console.log("\nEvery identifier kind is enforced...");
  await reset();
  {
    const cases: [string, ContactInput, ContactInput][] = [
      [
        "email, case and whitespace insensitive",
        { fullName: "Grace Hopper", email: "grace@cobol.mil" },
        { fullName: "G. Hopper", email: "  Grace@COBOL.mil " },
      ],
      [
        "X handle, URL vs bare handle",
        { fullName: "Alan Turing", xHandle: "https://x.com/alanturing" },
        { fullName: "A. Turing", xHandle: "@AlanTuring" },
      ],
      [
        "phone, formatting insensitive",
        { fullName: "Jean Bartik", phone: "(415) 555-0142" },
        { fullName: "J. Bartik", phone: "+1 415-555-0142" },
      ],
    ];
    for (const [label, a, b] of cases) {
      await reset();
      const first = await resolve(a);
      const second = await resolve(b);
      check(label, first.contactId === second.contactId && (await contactCount()) === 1);
    }
  }

  // ---------------------------------------------------------------------------------
  console.log("\nA lost race converges on the older contact...");
  await reset();
  {
    // Simulates the interleaving a read-then-insert cannot survive: two writers both find
    // nothing, both insert, and only then does one of them claim the identifier. Staged by
    // creating the second contact with no identifiers, so the claim happens after both rows
    // exist — exactly the state a real race leaves behind.
    const older = await resolve({ fullName: "Katherine Johnson", email: "kj@nasa.gov" });
    const newer = await resolve({ fullName: "Katherine Johnson", company: "NASA" });
    check("staged two separate contacts", older.contactId !== newer.contactId);

    // The newer row now tries to claim the identifier the older one holds.
    const owners = await claimIdentities(
      USER,
      newer.contactId,
      identityKeysFor({ email: "kj@nasa.gov" })
    );
    check(
      "the claim reports the incumbent, not the caller",
      owners.length === 1 && owners[0].contactId === older.contactId
    );

    // ...which is precisely what the resolver acts on. Presenting the record again drives
    // the convergence.
    const third = await resolve({ fullName: "Katherine Johnson", email: "kj@nasa.gov" });
    check("the resolver returns the older contact", third.contactId === older.contactId);
    check(
      "and never hands back an id it merged away",
      (await rowsOf<{ v: number }>(
        await db.execute(
          sql`SELECT count(*)::int AS v FROM contacts WHERE id = ${third.contactId}::uuid`
        )
      ))[0]!.v === 1
    );
  }

  // ---------------------------------------------------------------------------------
  console.log("\nA record spanning two contacts collapses them...");
  await reset();
  {
    const a = await resolve({ fullName: "Margaret Hamilton", email: "mh@mit.edu" });
    const b = await resolve({
      fullName: "Margaret Hamilton",
      linkedinUrl: "https://linkedin.com/in/margarethamilton",
    });
    check("two contacts, no shared identifier yet", a.contactId !== b.contactId);
    check("both exist", (await contactCount()) === 2);

    // One record carrying BOTH identifiers is evidence they were always the same person.
    const joined = await resolve({
      fullName: "Margaret Hamilton",
      email: "mh@mit.edu",
      linkedinUrl: "https://linkedin.com/in/margarethamilton",
    });
    check("they collapse to one contact", (await contactCount()) === 1);
    check("the survivor is the older of the two", joined.contactId === a.contactId);
    check(
      "the merge is recorded and reversible",
      (await rowsOf<{ v: number }>(
        await db.execute(
          sql`SELECT count(*)::int AS v FROM contact_merges WHERE user_id = ${USER}`
        )
      ))[0]!.v === 1
    );
  }

  // ---------------------------------------------------------------------------------
  console.log("\nA shared mailbox is not an identity...");
  await reset();
  {
    const a = await resolve({ fullName: "First Person", email: "info@acme.com" });
    const b = await resolve({ fullName: "Second Person", email: "info@acme.com" });
    check("two people sharing info@ stay two contacts", a.contactId !== b.contactId);
    check("both exist", (await contactCount()) === 2);
    check(
      "and no identity row was claimed for the shared address",
      (await rowsOf<{ v: number }>(
        await db.execute(
          sql`SELECT count(*)::int AS v FROM contact_identities
               WHERE user_id = ${USER} AND value = 'info@acme.com'`
        )
      ))[0]!.v === 0
    );
  }

  // ---------------------------------------------------------------------------------
  console.log("\nA confident name match folds without asking...");
  await reset();
  {
    // Same name AND same employer scores 0.90, above the 0.85 the app acts on. It folds —
    // and, importantly, folds *before* inserting, so no duplicate row is created and then
    // merged away (which would also burn a slot against a free plan's contact cap).
    const a = await resolve({ fullName: "John Smith", company: "Acme" });
    const b = await resolve({ fullName: "John Smith", company: "Acme", title: "Engineer" });

    check("the second write matched rather than created", b.outcome === "matched");
    check("both resolved to one contact", a.contactId === b.contactId);
    check("only one contact exists", (await contactCount()) === 1);
    check(
      "it folded before inserting, so nothing had to be merged away",
      (await rowsOf<{ v: number }>(
        await db.execute(sql`SELECT count(*)::int AS v FROM contact_merges WHERE user_id = ${USER}`)
      ))[0]!.v === 0
    );
    check(
      "the new field came across",
      (await rowsOf<{ title: string | null }>(
        await db.execute(sql`SELECT title FROM contacts WHERE id = ${a.contactId}::uuid`)
      ))[0]!.title === "Engineer"
    );
  }

  // ---------------------------------------------------------------------------------
  console.log("\n...but a bare name on its own is a question, not an answer...");
  await reset();
  {
    // Nothing but a shared full name: 0.60, below the line. Two different people genuinely
    // can be called the same thing, and there is no employer or title to corroborate it.
    const a = await resolve({ fullName: "Jane Doe" });
    const b = await resolve({ fullName: "Jane Doe" });

    check("both contacts are kept", a.contactId !== b.contactId);
    check("two contacts exist", (await contactCount()) === 2);
    check("nothing was merged", (await rowsOf<{ v: number }>(
      await db.execute(sql`SELECT count(*)::int AS v FROM contact_merges WHERE user_id = ${USER}`)
    ))[0]!.v === 0);
    check(
      "the pair is queued for review instead",
      (await rowsOf<{ v: number }>(
        await db.execute(
          sql`SELECT count(*)::int AS v FROM duplicate_suggestions
               WHERE user_id = ${USER} AND status = 'pending'`
        )
      ))[0]!.v === 1
    );
    check("and the caller was told about it", b.suggestions.length === 1);
  }

  // ---------------------------------------------------------------------------------
  console.log("\n...and a different employer keeps them apart...");
  await reset();
  {
    // Same name, DIFFERENT companies. No tier fires above the bare-name 0.60, so these stay
    // two contacts — the case the old 0.6 calendar floor used to collapse.
    const a = await resolve({ fullName: "Chris Lee", company: "Acme" });
    const b = await resolve({ fullName: "Chris Lee", company: "Globex" });

    check("two employers, two people", a.contactId !== b.contactId);
    check("two contacts exist", (await contactCount()) === 2);
    check(
      "still surfaced for review",
      (await rowsOf<{ v: number }>(
        await db.execute(
          sql`SELECT count(*)::int AS v FROM duplicate_suggestions
               WHERE user_id = ${USER} AND status = 'pending'`
        )
      ))[0]!.v === 1
    );
  }

  // ---------------------------------------------------------------------------------
  console.log("\nThe backfill claims identities oldest-first and reports the rest...");
  await reset();
  {
    // Two contacts written straight to SQL, as pre-existing rows would be — no identities.
    await db.execute(sql`
      INSERT INTO contacts (user_id, full_name, email, created_at)
      VALUES (${USER}, 'Old Row', 'dup@example.com', now() - interval '2 days'),
             (${USER}, 'New Row', 'dup@example.com', now() - interval '1 day')
    `);
    const result = await backfillContactIdentities({ userId: USER });

    check("both contacts were examined", result.scanned === 2);
    check("exactly one claimed the shared address", result.claimed === 1);
    check("the other is reported as contested", result.contested.length === 1);
    check(
      "the OLDEST contact is the one that holds it",
      (await rowsOf<{ name: string }>(
        await db.execute(sql`
          SELECT c.full_name AS name FROM contact_identities i
            JOIN contacts c ON c.id = i.contact_id
           WHERE i.user_id = ${USER} AND i.value = 'dup@example.com'
        `)
      ))[0]!.name === "Old Row"
    );
    check(
      "the backfill merged nothing — the duplicates are left for review",
      (await contactCount()) === 2
    );
    check("running it again is a no-op", (await backfillContactIdentities({ userId: USER })).claimed === 0);
  }

  // ---------------------------------------------------------------------------------
  console.log("\nThe bulk create path claims identities too...");
  await reset();
  {
    // The highest-volume contact-creating path in the product: every import and every
    // calendar sync lands here rather than in `createContactForUser`. A contact created
    // without identity rows is invisible to duplicate prevention forever after, and the
    // only thing that would notice is this check.
    const resolver = await createCompanyResolver(USER);
    const created = await createContactsBulkForUser(
      USER,
      [
        { fullName: "Bulk One", email: "bulk1@example.com" },
        { fullName: "Bulk Two", linkedinUrl: "https://linkedin.com/in/bulktwo" },
        { fullName: "Bulk Three" },
        // A duplicate WITHIN the batch: only one row may hold the identifier.
        { fullName: "Bulk One Again", email: "bulk1@example.com" },
      ],
      resolver,
      OPTS
    );
    check("all four rows were inserted", created.length === 4);
    const claimed = rowsOf<{ kind: string; value: string }>(
      await db.execute(
        sql`SELECT kind, value FROM contact_identities WHERE user_id = ${USER} ORDER BY kind, value`
      )
    );
    // Two rows, not four: "Bulk Three" carries no identifier at all, and the in-batch
    // duplicate's email is already spoken for by the row before it.
    check(
      "one identity row per distinct identifier in the batch",
      claimed.length === 2,
      JSON.stringify(claimed)
    );
    check(
      "the in-batch duplicate did not raise a unique violation",
      (await rowsOf<{ v: number }>(
        await db.execute(
          sql`SELECT count(*)::int AS v FROM contact_identities
               WHERE user_id = ${USER} AND value = 'bulk1@example.com'`
        )
      ))[0]!.v === 1
    );
    // And a later single write for the same person now resolves into the existing contact
    // rather than adding a third row.
    const again = await resolve({ fullName: "Bulk One", email: "bulk1@example.com" });
    check("a later write matches the bulk-created contact", again.outcome === "matched");
    check("and creates nothing new", (await contactCount()) === 4);
  }

  await reset();
  await closeDb();

  console.log(
    failures === 0
      ? "\nAll contact-resolve checks passed."
      : `\n${failures} contact-resolve check(s) FAILED.`
  );
  if (failures) process.exit(1);
}

run(main);
