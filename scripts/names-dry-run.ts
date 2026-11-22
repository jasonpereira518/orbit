/**
 * What the names engine would do to the contacts already stored. READ-ONLY: nothing is written.
 *
 * Run this against production before the re-check of existing contacts (names PR3) turns on
 * removal and renaming, and read the numbers: how many real people the "not a person" rules
 * would catch is the one thing no test can tell us.
 *
 * For every contact it reports:
 *  - the verdict `classifyName` gives its name (with its email), and whether it is certain;
 *  - whether `isAdmissibleRecord` would have refused it at import (company, machine mailbox,
 *    shared inbox with no person's name);
 *  - whether `formatPersonName` would reformat it ("DOE, JANE" → Jane Doe).
 * Counts per verdict, then a few sample names per bucket (names only, no ids or emails).
 *
 * TARGETS `DATABASE_URL`, and refuses to run without one (see `requireRealDatabase`).
 *
 * Run: npx tsx scripts/names-dry-run.ts [--user <userId>] [--samples 8]
 */
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts } from "../src/db/schema";
import { classifyName, isAdmissibleRecord } from "../src/lib/names/classify";
import { formatPersonName } from "../src/lib/names/parse";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const { requireRealDatabase } = await import("./lib/operational-db");
  requireRealDatabase("names-dry-run");
  const userId = arg("user");
  const samples = Number(arg("samples") ?? 8);

  const db = await getDb();
  const rows = await db
    .select({ fullName: contacts.fullName, email: contacts.email, company: contacts.company, nameGuess: contacts.nameGuess })
    .from(contacts)
    .where(userId ? eq(contacts.userId, userId) : undefined);

  const buckets = new Map<string, string[]>();
  const add = (key: string, name: string) => buckets.set(key, [...(buckets.get(key) ?? []), name]);
  for (const r of rows) {
    const { verdict, certain } = classifyName(r.fullName, { email: r.email, company: r.company });
    add(`verdict ${verdict}${certain ? " (certain)" : ""}`, r.fullName);
    if (!isAdmissibleRecord(r.fullName, r.email)) add("would be refused at import", r.fullName);
    if (r.nameGuess?.source === "user") add("user-confirmed (never changed)", r.fullName);
    const formatted = formatPersonName(r.fullName)?.fullName;
    if (formatted && formatted !== r.fullName.trim() && (verdict === "person_full" || verdict === "person_partial")) {
      add("would be reformatted", `${r.fullName} → ${formatted}`);
    }
  }

  console.log(`\n${rows.length} contacts${userId ? " for one user" : " across all users"}\n`);
  for (const [key, names] of [...buckets].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`${String(names.length).padStart(7)}  ${key}`);
    for (const n of names.slice(0, samples)) console.log(`           ${n}`);
  }
}

if (process.argv[1] && /names-dry-run\.ts$/.test(process.argv[1])) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
