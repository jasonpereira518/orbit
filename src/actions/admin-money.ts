"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { startupExpenses } from "@/db/schema";
import { requireAdminUserId } from "@/lib/admin";
import { setInfraCost } from "@/lib/infra-costs";
import { requireClientDate } from "@/lib/input/dates";
import { z } from "zod";
import { defineAction } from "@/lib/input/action";
import { anyNumber } from "@/lib/input/schemas";

/**
 * Cost entry for the Money section.
 *
 * ONE FORM, TWO DESTINATIONS, because the two kinds of cost genuinely behave differently.
 * A monthly provider bill is upserted per provider per month — a restated bill has to
 * replace the earlier figure, not double it. A one-off is appended — upserting those would
 * silently collapse two real expenses that shared a category and a month.
 *
 * `requireAdminUserId` is called here rather than relied upon from the layout: layouts do
 * not re-run for Server Action POSTs, so the route guard does not cover this path.
 *
 * Every export in a "use server" file must be async. A single non-async export breaks every
 * export in the file, and tsc cannot see it.
 */

export const setInfraCostAction = defineAction(
  { auth: () => requireAdminUserId(), schema: z.tuple([z.looseObject({ provider: z.string(), month: z.string(), amountUsd: anyNumber, note: z.string().optional() })]) },
  async (_caller, input: {
    provider: string;
    month: string;
    amountUsd: number;
    note?: string;
  }): Promise<{ ok: true }> => {
    await setInfraCost({
      provider: input.provider,
      month: requireClientDate(input.month, "month"),
      // Entered in dollars because that is what the bill says; stored in cents because
      // floats do not survive being summed.
      amountCents: Math.round(input.amountUsd * 100),
      note: input.note?.trim() || null,
    });

    revalidatePath("/admin/billing/costs");
    revalidatePath("/admin/billing");
    return { ok: true };
  }
);

export const addOneOffCostAction = defineAction(
  { auth: () => requireAdminUserId(), schema: z.tuple([z.looseObject({ category: z.string(), amountUsd: anyNumber, incurredAt: z.string(), note: z.string().optional() })]) },
  async (_caller, input: {
    category: string;
    amountUsd: number;
    incurredAt: string;
    note?: string;
  }): Promise<{ ok: true }> => {
    const db = await getDb();

    await db.insert(startupExpenses).values({
      category: input.category,
      amountUsd: input.amountUsd,
      incurredAt: requireClientDate(input.incurredAt, "date"),
      note: input.note?.trim() || null,
    });

    revalidatePath("/admin/billing/costs");
    revalidatePath("/admin/billing");
    // Runway reads the same rows through `monthlyCosts`, so it must not keep a stale burn.
    revalidatePath("/admin/yc/runway");
    return { ok: true };
  }
);
