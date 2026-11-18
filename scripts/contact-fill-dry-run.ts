/**
 * What the kept LinkedIn export would change on one account's contacts. READ-ONLY: nothing is
 * written. Runs the same match (`planFromStoredExport`) and the same field rule
 * (`decideFieldWrites`, as "linkedin_export" dated to the upload) the real fill uses, and
 * reports per field: filled (was empty), replaced (Orbit's own older value), offered (a
 * suggestion against what the user typed), kept (theirs, untouched).
 *
 * TARGETS `DATABASE_URL`, and refuses to run without one (see `requireRealDatabase`).
 *
 * Run: npx tsx scripts/contact-fill-dry-run.ts --user <userId> [--all] [--samples 8]
 *   --all  every contact (default: only those still without a LinkedIn URL, as the fill does)
 */
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts } from "../src/db/schema";
import { FIELD_KEYS, decideFieldWrites, type FieldKey } from "../src/lib/contact-fields";
import { planFromStoredExport } from "../src/lib/linkedin-export-facts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const { requireRealDatabase } = await import("./lib/operational-db");
  requireRealDatabase("contact-fill-dry-run");
  const userId = arg("user");
  if (!userId) throw new Error("--user <userId> is required");
  const samples = Number(arg("samples") ?? 8);

  const db = await getDb();
  const ids = process.argv.includes("--all")
    ? (await db.select({ id: contacts.id }).from(contacts).where(eq(contacts.userId, userId))).map((r) => r.id)
    : undefined;
  const plan = await planFromStoredExport(userId, ids);
  if (!plan) {
    console.log("No kept LinkedIn export (or no Connections.csv in it) for this account.");
    return;
  }
  const rows = plan.merges.length
    ? await db
        .select()
        .from(contacts)
        .where(and(eq(contacts.userId, userId), inArray(contacts.id, plan.merges.map((m) => m.contactId))))
    : [];
  const byId = new Map(rows.map((r) => [r.id, r]));

  const buckets = new Map<string, string[]>();
  const add = (key: string, line: string) => buckets.set(key, [...(buckets.get(key) ?? []), line]);
  for (const m of plan.merges) {
    const c = byId.get(m.contactId);
    if (!c) continue;
    const current = Object.fromEntries(FIELD_KEYS.map((k) => [k, (c as Record<string, unknown>)[k] as string | null]));
    const incoming = Object.fromEntries(FIELD_KEYS.map((k) => [k, m.input[k as keyof typeof m.input] as string | undefined]));
    const d = decideFieldWrites(current, c.fieldSources, incoming, "linkedin_export", plan.uploadedAt);
    for (const field of FIELD_KEYS as readonly FieldKey[]) {
      const after = incoming[field];
      if (!after) continue;
      const before = current[field];
      const change = d.changes.find((x) => x.field === field);
      const kind =
        change?.status === "suggested" ? "offered" : field in d.write ? (before?.trim() ? "replaced" : "filled") : "kept";
      add(`${kind} ${field}`, `${c.fullName}: ${before ?? "—"} → ${after}`);
    }
  }

  console.log(`\n${plan.merges.length} contacts matched a row of the export uploaded ${plan.uploadedAt.toISOString().slice(0, 10)}\n`);
  for (const [key, lines] of [...buckets].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`${String(lines.length).padStart(7)}  ${key}`);
    for (const l of lines.slice(0, samples)) console.log(`           ${l}`);
  }
}

if (process.argv[1] && /contact-fill-dry-run\.ts$/.test(process.argv[1])) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
