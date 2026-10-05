/**
 * The reminder-list editor's server rules (`updateReminderList`): icon and colour accept only
 * known keys and reset with null, a rename is checked for clashes, and the Inbox keeps its
 * name while taking an icon and colour like any other list.
 *
 * Runs the real action against a throwaway PGlite as demo mode's `demo-user`.
 * Run: npx tsx scripts/smoke-reminder-list-style.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { reminderLists } from "../src/db/schema";
import { createReminderList, loadReminderRail, updateReminderList } from "../src/actions/reminders";
import { LIST_COLORS, LIST_ICONS, isListColor, isListIcon } from "../src/lib/reminder-list-style";

const USER = "demo-user";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function main() {
  delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  delete process.env.CLERK_SECRET_KEY;
  (process.env as Record<string, string>).NODE_ENV = "development";
  // In demo mode requireUserId bootstraps demo-user, and an account with no contacts (this
  // one) is filled with the demo workspace — chat history and all — which then sits in the
  // suite's shared database and throws off absolute counts in other scripts
  // (smoke-admin-analytics caught it in CI).
  process.env.ORBIT_DEMO_DATA = "off";
  const db = await getDb();
  await db.delete(reminderLists).where(eq(reminderLists.userId, USER));

  console.log("Reminder list style");
  check("every icon key validates", Object.keys(LIST_ICONS).every(isListIcon));
  check("every colour key validates", Object.keys(LIST_COLORS).every(isListColor));
  check("an inherited property name is not a key", !isListIcon("constructor") && !isListColor("toString"));

  const created = await createReminderList("Fundraise");
  check("list created", created.ok);
  const id = created.ok ? created.value.id : "";

  const styled = await updateReminderList(id, { icon: "rocket", color: "violet" });
  check("a known icon and colour save", styled.ok && styled.value.icon === "rocket" && styled.value.color === "violet");

  const rail = await loadReminderRail();
  const summary = rail.lists.find((l) => l.id === id);
  check("the rail carries them", summary?.icon === "rocket" && summary?.color === "violet");

  const badIcon = await updateReminderList(id, { icon: "bg-red-500" });
  check("an unknown icon is refused", !badIcon.ok);
  const badColor = await updateReminderList(id, { color: "text-[red]" });
  check("an unknown colour is refused", !badColor.ok);

  const reset = await updateReminderList(id, { icon: null, color: null });
  check("null resets both", reset.ok && reset.value.icon === null && reset.value.color === null);

  const renamed = await updateReminderList(id, { name: "  Fundraising  round " });
  check("rename tidies whitespace", renamed.ok && renamed.value.name === "Fundraising round");

  const other = await createReminderList("Hiring");
  const clash = await updateReminderList(other.ok ? other.value.id : "", { name: "fundraising ROUND" });
  check("a rename onto another list's name is refused", !clash.ok);

  const inbox = rail.lists.find((l) => l.isInbox)!;
  const inboxRename = await updateReminderList(inbox.id, { name: "Triage" });
  check("the Inbox can't be renamed", !inboxRename.ok);
  const inboxSameName = await updateReminderList(inbox.id, { name: inbox.name, color: "teal" });
  check("…but saving its own name with a colour is fine", inboxSameName.ok && inboxSameName.value.color === "teal");
  const inboxStyle = await updateReminderList(inbox.id, { icon: "star" });
  check("…and it takes an icon", inboxStyle.ok && inboxStyle.value.icon === "star");

  const missing = await updateReminderList("00000000-0000-4000-8000-000000000000", { color: "teal" });
  check("a list that isn't yours reads as gone", !missing.ok);

  await db.delete(reminderLists).where(eq(reminderLists.userId, USER));
  console.log("\nAll reminder list style checks passed");
}

run(main);
