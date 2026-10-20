"use server";

import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { userGoals } from "@/db/schema";
import { listActiveGoalTextsForUser } from "@/lib/user-goals";
import { revalidatePathIfRequestScoped } from "@/lib/reminder-paths";
import { asActionResult, UserFacingError } from "@/lib/errors";
import { z } from "zod";
import { defineAction, failResult } from "@/lib/input/action";
import { anyNumber } from "@/lib/input/schemas";

export const listGoals = defineAction(
  {},
  async (userId) => {
    const db = await getDb();
    return db.query.userGoals.findMany({
      where: eq(userGoals.userId, userId),
      orderBy: [desc(userGoals.createdAt)],
    });
  }
);

export const listActiveGoalTexts = defineAction(
  {},
  async (userId) => {
    return listActiveGoalTextsForUser(userId);
  }
);

/** Validation comes back as data — see `asActionResult` in lib/errors.ts. */
export const addGoal = defineAction(
  { schema: z.tuple([z.string()]), invalid: failResult },
  async (userId, text: string) => {
    return asActionResult(async () => {
      const trimmed = text.trim();
      if (!trimmed) throw new UserFacingError("Write the goal first");
      if (trimmed.length > 200) {
        throw new UserFacingError("Keep the goal under 200 characters");
      }

      const db = await getDb();
      const [row] = await db
        .insert(userGoals)
        .values({
          userId,
          text: trimmed,
          active: 1,
        })
        .returning();

      revalidateGoalPaths();
      return row;
    });
  }
);

function revalidateGoalPaths() {
  for (const path of ["/settings", "/graph", "/contacts", "/dashboard"]) {
    revalidatePathIfRequestScoped(path);
  }
}

/**
 * Returns the deleted row so the toast can offer Undo — see `restoreGoal`.
 *
 * Why a hard delete plus a re-insert, rather than flipping the `active` column: four
 * readers ignore `active` (`listGoals` below, `lib/graph-data.ts`, and two admin counts),
 * so a soft-deleted goal would stay visible in Settings and on the constellation.
 * `user_goals` has no inbound foreign keys, so putting the row back with its own id and
 * `createdAt` is an exact restore that asks nothing of any reader.
 */
export const deleteGoal = defineAction(
  { schema: z.tuple([z.string()]) },
  async (userId, id: string) => {
    const db = await getDb();
    const [deleted] = await db
      .delete(userGoals)
      .where(and(eq(userGoals.id, id), eq(userGoals.userId, userId)))
      .returning();

    revalidateGoalPaths();
    return deleted
      ? {
          id: deleted.id,
          text: deleted.text,
          active: deleted.active,
          createdAt: deleted.createdAt.toISOString(),
        }
      : null;
  }
);

/**
 * Undo for `deleteGoal`: re-insert the row with its original id and `createdAt`, so it
 * returns to the same place in the list. The snapshot comes from the client, so the owner
 * is always the signed-in user, the text is re-validated as `addGoal` would, and an id
 * that already exists is left alone rather than overwritten.
 */
export const restoreGoal = defineAction(
  { schema: z.tuple([z.looseObject({ id: z.string(), text: z.string(), active: anyNumber, createdAt: z.string() })]) },
  async (userId, snapshot: {
    id: string;
    text: string;
    active: number;
    createdAt: string;
  }) => {
    const text = typeof snapshot?.text === "string" ? snapshot.text.trim() : "";
    const createdAt = new Date(snapshot?.createdAt);
    if (
      typeof snapshot?.id !== "string" ||
      !text ||
      text.length > 200 ||
      Number.isNaN(createdAt.getTime())
    ) {
      return { restored: false };
    }

    const db = await getDb();
    const inserted = await db
      .insert(userGoals)
      .values({
        id: snapshot.id,
        userId,
        text,
        active: snapshot.active === 0 ? 0 : 1,
        createdAt,
      })
      .onConflictDoNothing()
      .returning();

    revalidateGoalPaths();
    return { restored: inserted.length > 0 };
  }
);
