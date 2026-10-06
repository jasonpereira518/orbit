import { sql, type AnyColumn, type SQL } from "drizzle-orm";
import { TOUR_EXAMPLE_SOURCE } from "@/lib/onboarding-examples/marker";

/**
 * "This row is not one of the tour's example people." `IS DISTINCT FROM` because `source`
 * is nullable and a plain `<>` would drop every unlabelled real contact.
 *
 * Used wherever a count of contacts stands for something the examples must not inflate:
 * the plan's contact cap, the admin "activated" and "first contact" predicates, and the
 * first-run gate's probe.
 */
export function notTourExample(column: AnyColumn | SQL): SQL {
  return sql`${column} IS DISTINCT FROM ${TOUR_EXAMPLE_SOURCE}`;
}
