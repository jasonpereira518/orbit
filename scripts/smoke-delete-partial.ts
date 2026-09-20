/**
 * A delete that stops part-way reports what finished and what is pending, as data.
 * Run: npx tsx scripts/smoke-delete-partial.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { sql } from "drizzle-orm";
import { getDb } from "../src/db";
import * as schema from "../src/db/schema";
import { deletionOutcome, purgeUserData } from "../src/lib/user-data";

const USER = "smoke-delete-partial-user";

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function main() {
  const db = await getDb();
  await db.insert(schema.userSettings).values({ userId: USER });
  const whole = await deletionOutcome(() => purgeUserData(USER, { only: ["chat", "goals"] }));
  check("a finished delete lists its categories", whole.deleted.sort().join(",") === "chat,goals" && whole.pending.length === 0, JSON.stringify(whole));

  await db.execute(sql`ALTER TABLE user_goals RENAME TO user_goals_parked`);
  try {
    const partial = await deletionOutcome(() => purgeUserData(USER, { only: ["events", "goals", "tags"] }));
    check("a stopped delete does not throw", true);
    check("...reports what finished (events runs before goals)", partial.deleted.join(",") === "events", JSON.stringify(partial));
    check("...and what is pending", partial.pending.join(",") === "goals,tags", JSON.stringify(partial));
    check("...never the internal billing step", ![...partial.deleted, ...partial.pending].includes("billing" as never));
  } finally {
    await db.execute(sql`ALTER TABLE IF EXISTS user_goals_parked RENAME TO user_goals`);
    await purgeUserData(USER, { keepSettings: false }).catch(() => {});
  }
  console.log("\nAll partial-delete checks passed.");
}

run(main);
