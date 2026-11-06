import { and, count, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts, interactions } from "@/db/schema";
import { TOUR_EXAMPLE_SOURCE } from "@/lib/onboarding-examples/marker";
import { notTourExample } from "@/lib/onboarding-examples/sql";

/** How many example people are still in the account — zero for almost everyone. */
export async function countTourExamples(userId: string): Promise<number> {
  const db = await getDb();
  const [row] = await db
    .select({ value: count() })
    .from(contacts)
    .where(and(eq(contacts.userId, userId), eq(contacts.source, TOUR_EXAMPLE_SOURCE)));
  return row?.value ?? 0;
}

/** Whether the person has logged anything of their own yet (the tour's examples don't count). */
export async function hasOwnInteraction(userId: string): Promise<boolean> {
  const db = await getDb();
  const [row] = await db
    .select({ id: interactions.id })
    .from(interactions)
    .where(and(eq(interactions.userId, userId), notTourExample(interactions.source)))
    .limit(1);
  return row != null;
}
