import { sql } from "drizzle-orm";
import { contacts } from "@/db/schema";

/**
 * "Does this contact have written notes?" as a boolean computed in SQL.
 *
 * The `notes` column itself is never selected into the graph or dashboard payloads — it is
 * multi-KB per row and both scans exclude it explicitly, with `scripts/smoke-page-budgets.ts`
 * asserting that it stays excluded (pulling it is what once made those pages time out). But
 * constellation eligibility needs to know whether it is empty, so the test happens in the
 * database and only the answer travels.
 *
 * Safe against that smoke assertion as written: it matches `"notes"` followed by a comma or
 * `from`, and every occurrence here is followed by ` is` or `)`.
 */
export const contactHasNotesSql = sql<boolean>`(
  ${contacts.notes} is not null and btrim(${contacts.notes}) <> ''
)`;
