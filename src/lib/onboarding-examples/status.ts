import { and, count, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts } from "@/db/schema";
import { TOUR_EXAMPLE_SOURCE } from "@/lib/onboarding-examples/marker";

/** How many example people are still in the account — zero for almost everyone. */
export async function countTourExamples(userId: string): Promise<number> {
  const db = await getDb();
  const [row] = await db
    .select({ value: count() })
    .from(contacts)
    .where(and(eq(contacts.userId, userId), eq(contacts.source, TOUR_EXAMPLE_SOURCE)));
  return row?.value ?? 0;
}
