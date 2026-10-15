/**
 * A kept LinkedIn export, end to end on the engine: invitation messages and LinkedIn notes
 * attach by profile URL, recommendations by name + company and never by a bare name, nobody
 * is created, a re-upload adds nothing twice, target companies never overwrite the user's own,
 * and background + wanted titles reach the career profile.
 *
 * Local PGlite. Run: npx tsx scripts/smoke-linkedin-signals.ts
 */
import "./smoke/_env";
import { and, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import {
  contactIdentities,
  contacts,
  importFiles,
  importJobRows,
  imports,
  interactions,
  targetCompanies,
  userSettings,
} from "../src/db/schema";
import { gzipBase64 } from "../src/lib/imports/export-upload";
import { runImportJobById } from "../src/lib/import-job-dispatch";
import { applyExportExtras } from "../src/lib/linkedin-export-apply";
import { appendExportFiles, beginExport, finishExportUpload } from "../src/lib/linkedin-export-store";
import { addTargetCompany, listTargetCompanies } from "../src/lib/events/target-companies";
import { loadYouCurrent } from "../src/lib/career-profile-server";
import { ensureUserSettings } from "../src/lib/user-settings";
import { run } from "./smoke/_env";

const USER = "smoke-linkedin-signals-user";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const FILES: Record<string, string> = {
  "Invitations.csv": [
    "From,To,Sent At,Message,Direction,inviterProfileUrl,inviteeProfileUrl",
    'Me,Ada Lovelace,"9/22/26, 8:50 AM","Hi Ada, loved your talk",OUTGOING,https://www.linkedin.com/in/me,https://www.linkedin.com/in/ada-l',
    'Grace Hopper,Me,"9/21/26, 9:43 PM","Met you at the fair",INCOMING,https://www.linkedin.com/in/grace-h,https://www.linkedin.com/in/me',
    'Me,Stranger Pending,"9/20/26, 1:00 PM","Hello?",OUTGOING,https://www.linkedin.com/in/me,https://www.linkedin.com/in/nobody-here',
  ].join("\n"),
  "Notes.csv": [
    "Connection First Name,Connection Last Name,Connection Profile URL,Note,Created On,Edited On",
    "Ada,Lovelace,https://www.linkedin.com/in/ada-l,Ask about the engine,2026-09-10,",
  ].join("\n"),
  "Recommendations_Received.csv": [
    "First Name,Last Name,Company,Job Title,Text,Creation Date,Status",
    'Grace,Hopper,Navy,Admiral,"A brilliant engineer.","08/25/26, 07:03 PM",VISIBLE',
    'Alan,Turing,Bletchley,Codebreaker,"Sharp mind.","08/12/26, 03:38 AM",VISIBLE',
  ].join("\n"),
  "Jobs/Job Seeker Preferences.csv": [
    "Job Titles,Dream Companies",
    '"Software Engineer | Data Analyst","Stripe | Anthropic"',
  ].join("\n"),
  "Jobs/Job Applications.csv": [
    "Application Date,Company Name,Job Title",
    '"11/13/25, 11:35 AM",Citadel,SWE Intern',
  ].join("\n"),
  "Certifications.csv": ["Name,Url,Authority,Started On,Finished On,License Number", "AWS Cloud Practitioner,u,AWS,Mar 2024,,1"].join("\n"),
  "Company Follows.csv": "Organization,Followed On\nMeta,Mon Jan 05 2026\n",
};

async function exportOnce(): Promise<string> {
  const db = await getDb();
  const { importId } = await beginExport(USER, "LinkedIn export");
  await appendExportFiles(
    USER,
    importId,
    await Promise.all(Object.entries(FILES).map(async ([path, t]) => ({ path, byteSize: t.length, gz: await gzipBase64(t) }))),
  );
  const stats = await finishExportUpload(USER, importId, { tooLarge: 0, private: 0 });
  const extras = await applyExportExtras(USER, importId);
  await db
    .update(imports)
    .set({ status: "processing", totalRows: extras.rows, stats: { ...stats, targetsAdded: extras.targetsAdded } })
    .where(eq(imports.id, importId));
  try {
    await runImportJobById(importId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.startsWith("Invariant: static generation store missing")) throw err;
  }
  return importId;
}

async function reset() {
  const db = await getDb();
  await db.delete(interactions).where(eq(interactions.userId, USER));
  await db.delete(importFiles).where(eq(importFiles.userId, USER));
  await db.delete(importJobRows).where(eq(importJobRows.userId, USER));
  await db.delete(imports).where(eq(imports.userId, USER));
  await db.delete(targetCompanies).where(eq(targetCompanies.userId, USER));
  await db.delete(contactIdentities).where(eq(contactIdentities.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await ensureUserSettings(USER);
}

async function main() {
  const db = await getDb();
  await reset();
  const [ada, grace, alan] = await db
    .insert(contacts)
    .values([
      { userId: USER, fullName: "Ada Lovelace", linkedinUrl: "https://www.linkedin.com/in/ada-l" },
      { userId: USER, fullName: "Grace Hopper", company: "Navy", linkedinUrl: "https://www.linkedin.com/in/grace-h" },
      // Same name as the recommender, different company: a bare name must not attach.
      { userId: USER, fullName: "Alan Turing", company: "Google" },
    ])
    .returning();
  await addTargetCompany(USER, "Stripe", 3, "my own note");

  console.log("the first upload");
  const first = await exportOnce();
  const ints = await db.select().from(interactions).where(eq(interactions.userId, USER));
  const on = (id: string) => ints.filter((i) => i.contactId === id);
  check("Ada: her invitation and the user's note", on(ada.id).map((i) => i.interactionType).sort().join(",") === "note,reach_out", JSON.stringify(on(ada.id).map((i) => i.rawNotes)));
  check(
    "Grace: her incoming request and her recommendation, both as notes",
    on(grace.id).length === 2 && on(grace.id).every((i) => i.interactionType === "note") &&
      on(grace.id).some((i) => i.rawNotes?.startsWith("Recommended you on LinkedIn")),
    JSON.stringify(on(grace.id).map((i) => i.rawNotes)),
  );
  check("Alan at another company gets nothing", on(alan.id).length === 0);
  check("every note carries this import's id", ints.length === 4 && ints.every((i) => i.importId === first), String(ints.length));
  check("nobody was created", (await db.select().from(contacts).where(eq(contacts.userId, USER))).length === 3);
  check(
    "the invitation's date moved Ada's first touch",
    (await db.query.contacts.findFirst({ where: eq(contacts.id, ada.id) }))?.firstInteractionAt?.toISOString().startsWith("2026-09-22") === true,
  );
  const job = await db.query.imports.findFirst({ where: eq(imports.id, first) });
  check("the job completed and kept its file counts", job?.status === "completed" && job.stats?.filesSaved === Object.keys(FILES).length && job.stats?.interactionsLogged === 4, JSON.stringify(job?.stats));

  console.log("\ntargets and the career profile");
  const targets = await listTargetCompanies(USER);
  const t = (name: string) => targets.find((x) => x.name === name);
  check("Stripe keeps the user's own priority and note", t("Stripe")?.priority === 3 && t("Stripe")?.note === "my own note");
  check("Anthropic arrives as a dream company", t("Anthropic")?.priority === 1);
  check("Citadel arrives from the application", t("Citadel")?.priority === 2 && t("Citadel")?.note?.includes("applied") === true);
  check("company follows never become targets", !t("Meta"));
  check("only the two new ones were counted", job?.stats?.targetsAdded === 2, String(job?.stats?.targetsAdded));
  const { career } = await loadYouCurrent(USER);
  check("wanted titles became role keywords", career?.roleKeywords?.join("|") === "Software Engineer|Data Analyst");
  check("background is there", career?.background?.[0]?.title === "AWS Cloud Practitioner");

  console.log("\nre-uploading the same export");
  await exportOnce();
  check("adds no note twice", (await db.select().from(interactions).where(eq(interactions.userId, USER))).length === 4);
  check("…and no target twice", (await listTargetCompanies(USER)).length === targets.length);
  check(
    "only the latest export's files are kept",
    (await db.select().from(importFiles).where(and(eq(importFiles.userId, USER), eq(importFiles.importId, first)))).length === 0,
  );

  await reset();
  console.log(failures ? `\n${failures} check(s) failed` : "\nsmoke-linkedin-signals: all checks passed");
  if (failures) process.exit(1);
}

run(main);
