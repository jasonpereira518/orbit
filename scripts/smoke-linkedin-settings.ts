/**
 * The LinkedIn integration page's read and its one write (`src/actions/linkedin-settings.ts`)
 * against a throwaway PGlite: counts come from LinkedIn's own rows only, a whole-export upload
 * counts as the last import, "about you" is summarised from the career profile, and the
 * refresh interval accepts only the page's choices and feeds the refresh level.
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import {
  contacts,
  imports,
  interactions,
  userSettings,
} from "../src/db/schema";
import { ensureUserSettings } from "../src/lib/user-settings";
import { checker } from "./smoke/check";

const t = checker();
const USER = "demo-user";
const DAY = 86_400_000;

run(async () => {
  // `requireUserId()` answers `demo-user` in demo mode — the trick smoke-integration-statuses uses.
  delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  delete process.env.CLERK_SECRET_KEY;
  (process.env as Record<string, string>).NODE_ENV = "development";
  process.env.ORBIT_DEMO_DATA = "off";
  const { getLinkedInPanel, setLinkedInRefreshInterval } =
    await import("../src/actions/linkedin-settings");

  const db = await getDb();
  const cleanup = async () => {
    await db.delete(interactions).where(eq(interactions.userId, USER));
    await db.delete(contacts).where(eq(contacts.userId, USER));
    await db
      .delete(imports)
      .where(
        and(
          eq(imports.userId, USER),
          inArray(imports.importType, [
            "linkedin_connections",
            "linkedin_messages",
            "linkedin_export",
          ]),
        ),
      );
    await db
      .update(userSettings)
      .set({ careerProfile: null, linkedinRefreshIntervalDays: null })
      .where(eq(userSettings.userId, USER));
  };
  await ensureUserSettings(USER);
  await cleanup();

  const empty = await getLinkedInPanel();
  t.check("nothing imported: no last import", empty.lastImportAt === null);
  t.check("nothing imported: no refresh due", empty.refreshLevel === null);
  t.check(
    "nothing imported: zero counts",
    empty.connections.people === 0 && empty.messages.people === 0,
  );
  t.check("no profile: about-you is null", empty.aboutYou === null);

  const ids = await db
    .insert(contacts)
    .values([
      { userId: USER, fullName: "Ana Fox", source: "linkedin" },
      { userId: USER, fullName: "Pat Kim", source: "linkedin" },
      { userId: USER, fullName: "Sam Lee", source: "capture" },
    ])
    .returning()
    .then((rows) => rows.map((r) => r.id));
  await db.insert(interactions).values([
    { userId: USER, contactId: ids[0], interactionType: "linkedin_message" },
    { userId: USER, contactId: ids[0], interactionType: "linkedin_message" },
    { userId: USER, contactId: ids[2], interactionType: "meeting_note" },
  ]);
  const longAgo = new Date(Date.now() - 45 * DAY);
  await db.insert(imports).values([
    {
      userId: USER,
      importType: "linkedin_connections",
      status: "completed",
      createdAt: longAgo,
    },
    {
      userId: USER,
      importType: "linkedin_export",
      status: "completed",
      createdAt: longAgo,
    },
  ]);
  await db
    .update(userSettings)
    .set({
      careerProfile: {
        profile: { headline: "Building Orbit" },
        role: { title: "Founder", company: "Orbit" },
        skills: ["TypeScript", "Postgres"],
      },
    })
    .where(eq(userSettings.userId, USER));

  const p = await getLinkedInPanel();
  t.check(
    "connections count LinkedIn-sourced contacts only",
    p.connections.people === 2,
    String(p.connections.people),
  );
  t.check(
    "messages count people messaged, once each",
    p.messages.people === 1,
    String(p.messages.people),
  );
  t.check("the whole export counts as an import", p.lastImportAt !== null);
  t.check("no messages import: its date is empty", p.messages.lastAt === null);
  t.check(
    "45 days on the default month: due",
    p.refreshLevel === "notify",
    String(p.refreshLevel),
  );
  t.check(
    "about you summarises role, headline and skills",
    p.aboutYou?.role === "Founder at Orbit" &&
      p.aboutYou.headline === "Building Orbit" &&
      p.aboutYou.skills === 2,
    JSON.stringify(p.aboutYou),
  );

  await setLinkedInRefreshInterval(90);
  const quarterly = await getLinkedInPanel();
  t.check("interval saved", quarterly.intervalDays === 90);
  t.check(
    "every 3 months: 45 days is not due",
    quarterly.refreshLevel === null,
  );
  await setLinkedInRefreshInterval(0);
  t.check("off: never due", (await getLinkedInPanel()).refreshLevel === null);

  let refused = false;
  try {
    await setLinkedInRefreshInterval(7);
  } catch {
    refused = true;
  }
  t.check("an interval the page doesn't offer is refused", refused);
  t.check(
    "a refused interval writes nothing",
    (await getLinkedInPanel()).intervalDays === 0,
  );

  await cleanup();
  t.done("linkedin settings smoke tests");
});
