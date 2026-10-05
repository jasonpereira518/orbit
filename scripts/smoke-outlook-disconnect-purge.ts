/**
 * "Disconnect Outlook and delete what Orbit imported" — what it removes, and what it must not.
 *
 * The Outlook recruiter scan's watermark is not a row of its own: it is the newest completed
 * scan job's frozen `scanStartedAt` (`lastCompletedScanStart`). Deleting the recruiters but
 * leaving that job would make the next scan incremental and skip all the mail the user just
 * asked Orbit to forget — so the recruiters purge has to take those jobs with it.
 *
 * Run: npx tsx scripts/smoke-outlook-disconnect-purge.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import {
  importJobRows,
  imports,
  recruiters,
  userRecruiterLinks,
} from "../src/db/schema";
import { DISCONNECT_DELETE_CATEGORIES } from "../src/lib/data-categories";
import { OUTLOOK_SCAN_IMPORT_TYPE } from "../src/lib/outlook-scan-type";
import { GMAIL_SCAN_IMPORT_TYPE } from "../src/lib/gmail-scan-type";
import { lastCompletedScanStart } from "../src/lib/recruiter-scan-state";
import { ensureUserLink, upsertCanonicalRecruiter } from "../src/lib/recruiters";
import { purgeUserData } from "../src/lib/user-data";

const USER = "smoke-outlook-purge-user";
const OTHER = "smoke-outlook-purge-other";
const USERS = [USER, OTHER];
const MARK = "smoke-outlook-purge-firm";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function cleanup() {
  const db = await getDb();
  const rows = await db.query.recruiters.findMany({ where: eq(recruiters.firm, MARK) });
  await db.delete(userRecruiterLinks).where(inArray(userRecruiterLinks.userId, USERS));
  if (rows.length) await db.delete(recruiters).where(inArray(recruiters.id, rows.map((r) => r.id)));
  await db.delete(importJobRows).where(inArray(importJobRows.userId, USERS));
  await db.delete(imports).where(inArray(imports.userId, USERS));
}

async function completedScan(userId: string, importType: string, at: Date) {
  const db = await getDb();
  const [job] = await db
    .insert(imports)
    .values({
      userId,
      importType,
      status: "completed",
      totalRows: 1,
      stats: { discoveryComplete: true, scanStartedAt: at.toISOString() },
    })
    .returning();
  await db.insert(importJobRows).values({
    importId: job.id,
    userId,
    rowIndex: 0,
    payload: {
      kind: importType === OUTLOOK_SCAN_IMPORT_TYPE ? "outlook_sender" : "gmail_sender",
      email: "r@example.test",
      name: "R",
      firm: MARK,
      messageIds: ["m1"],
    },
    status: "done",
  });
  return job.id;
}

async function exists(importId: string) {
  const db = await getDb();
  return Boolean(await db.query.imports.findFirst({ where: eq(imports.id, importId) }));
}

run(async () => {
  const db = await getDb();
  await cleanup();

  try {
    check(
      "Outlook offers exactly the recruiters category",
      DISCONNECT_DELETE_CATEGORIES.outlook.length === 1 &&
        DISCONNECT_DELETE_CATEGORIES.outlook[0] === "recruiters"
    );

    const at = new Date("2026-09-01T00:00:00Z");
    const outlookScan = await completedScan(USER, OUTLOOK_SCAN_IMPORT_TYPE, at);
    const gmailScan = await completedScan(USER, GMAIL_SCAN_IMPORT_TYPE, at);
    const otherUsersScan = await completedScan(OTHER, OUTLOOK_SCAN_IMPORT_TYPE, at);
    const [linkedIn] = await db
      .insert(imports)
      .values({ userId: USER, importType: "linkedin_connections", status: "completed", totalRows: 0, stats: {} })
      .returning();

    // Made the way the scan makes them, so the row is shaped like a real one.
    const rec = await upsertCanonicalRecruiter({
      fullName: "Outlook Purge Recruiter",
      firm: MARK,
      email: "r@example.test",
      specialty: [],
    });
    await ensureUserLink({ userId: USER, recruiterId: rec.id, status: "contacted", source: "outlook" });

    check(
      "before: the Outlook watermark exists",
      (await lastCompletedScanStart(USER, OUTLOOK_SCAN_IMPORT_TYPE))?.getTime() === at.getTime()
    );

    // Exactly what disconnectOutlook({ alsoDelete: true }) runs.
    await purgeUserData(USER, { only: DISCONNECT_DELETE_CATEGORIES.outlook });

    check("the recruiter link is gone", !(await db.query.userRecruiterLinks.findFirst({ where: eq(userRecruiterLinks.userId, USER) })));
    check("the Outlook scan job is gone", !(await exists(outlookScan)));
    check("its staged sender rows went with it", (await db.query.importJobRows.findMany({ where: eq(importJobRows.importId, outlookScan) })).length === 0);
    check(
      "after: no Outlook watermark, so the next scan is a FULL one",
      (await lastCompletedScanStart(USER, OUTLOOK_SCAN_IMPORT_TYPE)) === null
    );

    check("the user's Gmail scan job is untouched", await exists(gmailScan));
    check("an unrelated import (LinkedIn) is untouched", await exists(linkedIn.id));
    check("another user's Outlook scan is untouched", await exists(otherUsersScan));
    check(
      "another user's Outlook watermark is untouched",
      (await lastCompletedScanStart(OTHER, OUTLOOK_SCAN_IMPORT_TYPE))?.getTime() === at.getTime()
    );
  } finally {
    await cleanup();
  }

  if (failures > 0) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll Outlook disconnect-purge checks passed.");
});
