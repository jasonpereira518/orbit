/**
 * The launch catch-up for people who imported before the LinkedIn deep read: their full history
 * from the export they already uploaded (only when they had applied their own details from it),
 * the per-person notes that were never staged, closeness marked for a redraw, and a kick for
 * the one-time origin pass. Before launch it reaches admins only.
 *
 * Run: npx tsx scripts/smoke-deep-read-catch-up.ts
 */
import "./smoke/_env";

process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke-catch-up";
process.env.CLERK_SECRET_KEY ||= "sk_test_smoke-catch-up";

import { eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import {
  appSurfaceFlags, closenessCohorts, contacts, importFiles, importJobRows, imports, interactions, relationshipDigests, targetCompanies, userSettings,
  type ClosenessCohortSnapshot,
} from "../src/db/schema";
import { clearCareerProfile, loadYouCurrent, saveCareerPatch } from "../src/lib/career-profile-server";
import { deepReadLaunched } from "../src/lib/deep-read";
import {
  catchUpHistory,
  markCohortsForDeepRead,
  restageExportSignals,
  runDeepReadCatchUp,
  usersNeedingHistory,
} from "../src/lib/deep-read-catch-up";
import { setSchools } from "../src/lib/events/target-companies";
import { gzipBase64 } from "../src/lib/imports/export-upload";
import { runImportJobById } from "../src/lib/import-job-dispatch";
import { appendExportFiles, beginExport, finishExportUpload } from "../src/lib/linkedin-export-store";
import { usersWithPendingRelationshipWork } from "../src/lib/relationship-engine/pending";
import { invalidateHiddenSurfaceKeys } from "../src/lib/surface-visibility";
import { LINKEDIN_DEEP_READ_SURFACE_KEY } from "../src/lib/surfaces";
import { ensureUserSettings } from "../src/lib/user-settings";

const U1 = "smoke-catch-up-u1";
const U2 = "smoke-catch-up-u2";
const U3 = "smoke-catch-up-u3";
const U4 = "smoke-catch-up-u4";
const USERS = [U1, U2, U3, U4];
/** Hiding the surface is the kill switch once it is released: the catch-up goes back to admins only. */
const HIDDEN = LINKEDIN_DEEP_READ_SURFACE_KEY;

async function hide(on: boolean) {
  const db = await getDb();
  if (on) await db.insert(appSurfaceFlags).values({ surfaceKey: HIDDEN, hiddenBy: "smoke-catch-up" }).onConflictDoNothing();
  else await db.delete(appSurfaceFlags).where(eq(appSurfaceFlags.surfaceKey, HIDDEN));
  invalidateHiddenSurfaceKeys();
}

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const POSITIONS = [
  "Company Name,Title,Description,Location,Started On,Finished On",
  "Acme,Engineer,,,May 2021,",
  "Beta,Intern,,,Jun 2019,Aug 2020",
].join("\n");
const EDUCATION = ["School Name,Start Date,End Date,Notes,Degree Name,Activities", "UNC Chapel Hill,2016,2020,,BS Computer Science,"].join("\n");
const INVITATIONS = [
  "From,To,Sent At,Message,Direction,inviterProfileUrl,inviteeProfileUrl",
  'Me Myself,Ada Lovelace,"9/22/24, 8:50 AM","Hi Ada! Great meeting you at the robotics fair",OUTGOING,https://www.linkedin.com/in/me,https://www.linkedin.com/in/ada-l',
].join("\n");

async function reset() {
  const db = await getDb();
  for (const t of [relationshipDigests, interactions, importJobRows, importFiles, imports, targetCompanies, contacts, closenessCohorts, userSettings]) {
    await db.delete(t).where(inArray(t.userId, USERS));
  }
  await db.delete(appSurfaceFlags).where(eq(appSurfaceFlags.surfaceKey, HIDDEN));
  invalidateHiddenSurfaceKeys();
  for (const u of USERS) await ensureUserSettings(u);
}

/** A kept export as an upload from before the deep read left it: files stored, import completed, nothing staged. */
async function keepExport(userId: string, files: Record<string, string>): Promise<string> {
  const db = await getDb();
  const { importId } = await beginExport(userId, "LinkedIn export");
  await appendExportFiles(userId, importId, await Promise.all(Object.entries(files).map(async ([path, t]) => ({ path, byteSize: t.length, gz: await gzipBase64(t) }))));
  const stats = await finishExportUpload(userId, importId, { tooLarge: 0, private: 0 });
  await db.update(imports).set({ status: "completed", totalRows: 0, stats }).where(eq(imports.id, importId));
  return importId;
}

const career = async (userId: string) => (await loadYouCurrent(userId)).career;
const setRole = (userId: string, title: string, company: string) =>
  // What applying Positions.csv from Imports writes: the role and an import stamp.
  saveCareerPatch(userId, { career: { role: { title, company }, importedAt: new Date().toISOString() }, senderBio: null, schools: null, message: "" });
/** What applying Education.csv writes: the schools list and an import stamp. */
const applySchools = async (userId: string, schools: string[]) => {
  await setSchools(userId, schools);
  await saveCareerPatch(userId, { career: { importedAt: new Date().toISOString() }, senderBio: null, schools: null, message: "" });
};
/** The engine revalidates paths when a job ends, which only a request can do. */
const runJob = async (importId: string) => {
  try {
    await runImportJobById(importId);
  } catch (err) {
    if (!(err instanceof Error) || !err.message.startsWith("Invariant: static generation store missing")) throw err;
  }
};

async function main() {
  await reset();
  const db = await getDb();
  const priorAdmins = process.env.ADMIN_USER_IDS;
  delete process.env.ADMIN_USER_IDS;

  console.log("launched?");
  check("yes: the surface is released", (await deepReadLaunched()) === true);
  await hide(true);
  check("no once the surface is hidden (the kill switch)", (await deepReadLaunched()) === false);
  await hide(false);

  console.log("\nyour history");
  await setRole(U1, "Engineer", "Acme");
  await setRole(U2, "Founder", "Other");
  await applySchools(U3, ["UNC Chapel Hill"]);
  // Applied their schools before the stamp existed, then pressed "Remove imported details":
  // the schools list stays (it is not career_profile), the import stamp is gone.
  await setSchools(U4, ["UNC Chapel Hill"]);
  const u1Import = await keepExport(U1, { "Positions.csv": POSITIONS, "Invitations.csv": INVITATIONS });
  await keepExport(U2, { "Positions.csv": POSITIONS });
  await keepExport(U3, { "Education.csv": EDUCATION });
  await keepExport(U4, { "Education.csv": EDUCATION });

  check("all four are owed a look", (await usersNeedingHistory(25, null)).sort().join() === [...USERS].sort().join());
  check("a scope narrows it", (await usersNeedingHistory(25, [U3])).join() === U3);
  check("an empty scope is nobody", (await usersNeedingHistory(25, [])).length === 0);

  const r1 = await catchUpHistory(U1);
  const c1 = await career(U1);
  check("the role came from this export: every role is written", r1.positions === 2 && r1.education === 0 && c1?.positions?.length === 2, JSON.stringify(r1));
  check("…stamped, and the role itself untouched", Boolean(c1?.historyCheckedAt) && c1?.role?.title === "Engineer" && c1.role.company === "Acme");
  check("…and closeness is marked for a redraw", (await db.query.closenessCohorts.findFirst({ where: eq(closenessCohorts.userId, U1) }))?.dirtyAt != null);

  const r2 = await catchUpHistory(U2);
  const c2 = await career(U2);
  check("a role that did not come from the export: nothing is written", r2.positions === 0 && r2.education === 0 && c2?.positions === undefined, JSON.stringify(c2));
  check("…but it is stamped, so it is not looked at again", Boolean(c2?.historyCheckedAt) && !(await usersNeedingHistory(25, null)).includes(U2));
  check("…and a second call is a no-op", JSON.stringify(await catchUpHistory(U2)) === JSON.stringify({ positions: 0, education: 0 }) && (await career(U2))?.positions === undefined);

  const r3 = await catchUpHistory(U3);
  check("schools already imported from this export: degrees and dates are written", r3.education === 1 && (await career(U3))?.education?.[0]?.school === "UNC Chapel Hill", JSON.stringify(r3));

  const r4 = await catchUpHistory(U4);
  check("schools left behind by Remove imported details: nothing is written", r4.education === 0 && (await career(U4))?.education === undefined, JSON.stringify(r4));

  await clearCareerProfile(U1);
  const cleared = await career(U1);
  check("Remove imported details removes the history and keeps the stamp", cleared?.positions === undefined && Boolean(cleared?.historyCheckedAt), JSON.stringify(cleared));
  check("…so the catch-up never writes it back", !(await usersNeedingHistory(25, null)).includes(U1) && (await catchUpHistory(U1)).positions === 0 && (await career(U1))?.positions === undefined);

  console.log("\nthe per-person notes");
  const [ada] = await db.insert(contacts).values({ userId: U1, fullName: "Ada Lovelace", linkedinUrl: "https://www.linkedin.com/in/ada-l" }).returning();
  const targetsBefore = (await db.select().from(targetCompanies).where(eq(targetCompanies.userId, U1))).length;
  const staged = await restageExportSignals(U1, { run: runJob });
  const notes = await db.select().from(interactions).where(eq(interactions.userId, U1));
  check("the kept export's invitation is staged and attached", staged === 1 && notes.length === 1 && notes[0].contactId === ada.id && (notes[0].externalId ?? "").startsWith("li-export:invitation_sent:"), JSON.stringify(notes.map((n) => n.externalId)));
  check("the import is completed again", (await db.query.imports.findFirst({ where: eq(imports.id, u1Import) }))?.status === "completed");
  check("target companies are not re-applied", (await db.select().from(targetCompanies).where(eq(targetCompanies.userId, U1))).length === targetsBefore);
  const before = await db.query.imports.findFirst({ where: eq(imports.id, u1Import) });
  check("with notes already there, nothing is staged again", (await restageExportSignals(U1, { run: runJob })) === 0);
  const after = await db.query.imports.findFirst({ where: eq(imports.id, u1Import) });
  check("…and the import is untouched", after?.status === before?.status && after?.updatedAt.getTime() === before?.updatedAt.getTime() && (await db.select().from(importJobRows).where(eq(importJobRows.importId, u1Import))).length === 1);

  console.log("\ncloseness");
  const snap = (deepRead: boolean) => ({ deepRead } as unknown as ClosenessCohortSnapshot);
  await db.delete(closenessCohorts).where(inArray(closenessCohorts.userId, USERS));
  await db.insert(closenessCohorts).values([
    { userId: U1, snapshot: snap(false), contactCount: 1 },
    { userId: U2, snapshot: snap(true), contactCount: 1 },
    { userId: U3, snapshot: {} as ClosenessCohortSnapshot, contactCount: 1 },
  ]);
  const cohort = async (u: string) => (await db.query.closenessCohorts.findFirst({ where: eq(closenessCohorts.userId, u) }))!;
  check("a scope touches only its users", (await markCohortsForDeepRead([U1])) === 1 && (await cohort(U1)).dirtyAt !== null && (await cohort(U3)).dirtyAt === null);
  const firstMark = (await cohort(U1)).dirtyAt!.getTime();
  // Counted among every user in this database, so compare the three rows, not the total.
  await markCohortsForDeepRead(null);
  check("a cohort already drawn with the deep read is left alone", (await cohort(U2)).dirtyAt === null);
  check("one drawn without it is marked", (await cohort(U3)).dirtyAt !== null);
  check("marking twice keeps the first mark", (await cohort(U1)).dirtyAt!.getTime() === firstMark);

  console.log("\nthe cron stage");
  const [con] = await db.insert(contacts).values({ userId: U1, fullName: "Owed Origin", source: "linkedin" }).returning();
  await db.insert(relationshipDigests).values({ contactId: con.id, userId: U1, summary: "s", messageCount: 2, sources: ["linkedin"], watermarkAt: new Date("2024-01-01T00:00:00Z") });
  const kicked: string[] = [];
  const kick = async (u: string) => void kicked.push(u);
  await hide(true);
  const dark = await runDeepReadCatchUp({ kick, run: runJob });
  check("dark with no admins: nothing at all", JSON.stringify(dark) === JSON.stringify({ deepHistoryCaughtUp: 0, deepSignalsRestaged: 0, deepCohortsMarked: 0, deepOriginKicks: 0 }) && kicked.length === 0, JSON.stringify(dark));
  process.env.ADMIN_USER_IDS = U1;
  const admin = await runDeepReadCatchUp({ kick, run: runJob });
  check("dark with an admin: only the admin is kicked", admin.deepOriginKicks === 1 && kicked.join() === U1, JSON.stringify(admin));
  delete process.env.ADMIN_USER_IDS;
  await hide(false);

  console.log("\nsignal-only contacts and the backstop");
  const [sig] = await db.insert(contacts).values({ userId: U3, fullName: "Signal Only", source: "linkedin" }).returning();
  await db.insert(interactions).values({ userId: U3, contactId: sig.id, interactionType: "reach_out", interactionDate: new Date("2023-05-01T12:00:00Z"), source: "linkedin_export", externalId: `li-export:invitation_sent:k:${sig.id}`, rawNotes: "Great meeting you at the fair", topics: [] });
  const now = new Date();
  check("with the deep read the backstop sees a contact with only an invitation", (await usersWithPendingRelationshipWork(500, now, { deepRead: true })).includes(U3));
  check("without it, it does not", !(await usersWithPendingRelationshipWork(500, now, { deepRead: false })).includes(U3) && !(await usersWithPendingRelationshipWork(500, now)).includes(U3));

  if (priorAdmins !== undefined) process.env.ADMIN_USER_IDS = priorAdmins;
  await reset();
  console.log("\nsmoke-deep-read-catch-up: all checks passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
