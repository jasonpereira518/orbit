/**
 * The recruiter directory's contact-detail boundary (audit A8).
 *
 * `recruiters` is global. Linking any row by id, or by name + firm, used to unlock its
 * email, phone and LinkedIn for anyone — whether or not the person who contributed them
 * had sharing on — and anyone could fill a row's empty contact fields. Now details unlock
 * for the row's creator, or for a sharing viewer when the creator shares; a private caller
 * never writes details onto an existing row.
 *
 * Run: npx tsx scripts/smoke-recruiter-pii.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { recruiters, userRecruiterLinks, userSettings } from "../src/db/schema";
import {
  ensureUserLink,
  isCreatorLink,
  toPublicRecruiter,
  unlockedRecruiterIds,
  upsertCanonicalRecruiter,
} from "../src/lib/recruiters";

const A = "smoke-pii-a";
const B = "smoke-pii-b";
const FIRM = "ZZSmokePii";
const NAME = `${FIRM} Recruiter`;
const A_EMAIL = "alex@zzsmokepii.test";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

async function cleanup() {
  const db = await getDb();
  await db.delete(userRecruiterLinks).where(inArray(userRecruiterLinks.userId, [A, B]));
  await db.delete(recruiters).where(eq(recruiters.firm, FIRM));
  await db.delete(userSettings).where(inArray(userSettings.userId, [A, B]));
}

async function setSharing(userId: string, on: boolean) {
  const db = await getDb();
  await db.update(userSettings).set({ recruiterSharing: on ? 1 : 0 }).where(eq(userSettings.userId, userId));
}

async function row(id: string) {
  const db = await getDb();
  return (await db.query.recruiters.findFirst({ where: eq(recruiters.id, id) }))!;
}

async function unlockedFor(userId: string, id: string) {
  return (await unlockedRecruiterIds(userId, [await row(id)])).has(id);
}

run(async () => {
  await cleanup();
  const db = await getDb();
  for (const userId of [A, B]) await db.insert(userSettings).values({ userId, recruiterSharing: 0 });

  console.log("The creator sees what they contributed");
  // What logRecruiter does: create the row, then the creator's link.
  const created = await upsertCanonicalRecruiter({ fullName: NAME, firm: FIRM, email: A_EMAIL }, { callerIsSharing: false });
  await ensureUserLink({ userId: A, recruiterId: created.id });
  // Age the row and A's link by an hour, so B's link (made now) is unambiguously not the creator's.
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
  await db.update(recruiters).set({ createdAt: hourAgo }).where(eq(recruiters.id, created.id));
  await db
    .update(userRecruiterLinks)
    .set({ createdAt: new Date(hourAgo.getTime() + 1000) })
    .where(and(eq(userRecruiterLinks.userId, A), eq(userRecruiterLinks.recruiterId, created.id)));
  check("A (private, creator) sees the email", await unlockedFor(A, created.id));

  console.log("\nB, sharing off, links the same row by id");
  const { link: linkB } = await ensureUserLink({ userId: B, recruiterId: created.id });
  check("B's link is not the creator's", !isCreatorLink(await row(created.id), linkB));
  check("B cannot read A's email", !(await unlockedFor(B, created.id)));
  check("toPublicRecruiter hides it from B", toPublicRecruiter(await row(created.id), linkB, false).email === null);

  console.log("\nB logs the same person by name + firm with their own details");
  const matched = await upsertCanonicalRecruiter(
    { fullName: NAME, firm: FIRM, email: "other@zzsmokepii.test", phone: "+15555550100", specialty: ["Platform"] },
    { callerIsSharing: false }
  );
  const afterB = await row(created.id);
  check("it matched A's row", matched.id === created.id);
  check("B's phone was NOT written onto the shared row", afterB.phone === null, String(afterB.phone));
  check("A's email is unchanged", afterB.email === A_EMAIL);
  check("non-contact fields still merge (specialty)", (afterB.specialty ?? []).includes("Platform"));
  check("B still cannot read A's email", !(await unlockedFor(B, created.id)));

  console.log("\nConsent follows the contributor");
  await setSharing(B, true);
  check("B sharing alone does not unlock A's private details", !(await unlockedFor(B, created.id)));
  await setSharing(A, true);
  check("once A shares, sharing B sees them", await unlockedFor(B, created.id));
  await setSharing(B, false);
  check("B opting out loses them again", !(await unlockedFor(B, created.id)));

  console.log("\nA sharing caller may still fill an empty field");
  await upsertCanonicalRecruiter({ fullName: NAME, firm: FIRM, phone: "+15555550199" }, { callerIsSharing: true });
  check("the phone was filled", (await row(created.id)).phone === "+15555550199");

  console.log("\nisCreatorLink edges");
  const t = new Date("2026-09-15T12:00:00Z");
  check("same instant counts", isCreatorLink({ createdAt: t }, { createdAt: t }));
  check("two minutes later counts", isCreatorLink({ createdAt: t }, { createdAt: new Date(t.getTime() + 120_000) }));
  check("three minutes later does not", !isCreatorLink({ createdAt: t }, { createdAt: new Date(t.getTime() + 180_000) }));
  check("a link older than the row does not", !isCreatorLink({ createdAt: t }, { createdAt: new Date(t.getTime() - 1000) }));
  check("no link does not", !isCreatorLink({ createdAt: t }, null));

  await cleanup();
  if (failures > 0) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll recruiter PII checks passed.");
});
