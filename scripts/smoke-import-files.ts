/**
 * Keeping a LinkedIn export's files: begin → append → finish, read back byte for byte, only the
 * latest export kept, private members refused server-side, other accounts untouched, and the
 * account purge taking them all.
 *
 * Local PGlite. Run: npx tsx scripts/smoke-import-files.ts
 */
import "./smoke/_env";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { importFiles, imports } from "../src/db/schema";
import { gzipBase64 } from "../src/lib/imports/export-upload";
import {
  appendExportFiles,
  beginExport,
  deleteExportFiles,
  finishExportUpload,
  listExportFiles,
  readExportTexts,
} from "../src/lib/linkedin-export-store";
import { purgeUserData } from "../src/lib/user-data";
import { run } from "./smoke/_env";

const USER = "smoke-export-files-user";
const OTHER = "smoke-export-files-other";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

async function refuses(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
}

const INVITES = 'From,To,Sent At,Message,Direction\nAda,Me,"1/2/26, 9:00 AM","Hi — loved your talk,\nlet\'s connect",INCOMING\n';
const FOLLOWS = "Organization,Followed On\nAcme,Mon Jan 05 2026\n";

async function upload(userId: string, files: Record<string, string>) {
  const { importId } = await beginExport(userId, "LinkedIn export");
  const batch = await Promise.all(
    Object.entries(files).map(async ([path, text]) => ({
      path,
      byteSize: Buffer.byteLength(text),
      gz: await gzipBase64(text),
    })),
  );
  const appended = await appendExportFiles(userId, importId, batch);
  const stats = await finishExportUpload(userId, importId, { tooLarge: 0, private: 2 });
  await (await getDb()).update(imports).set({ status: "completed", stats }).where(eq(imports.id, importId));
  return { importId, appended, stats };
}

async function main() {
  const db = await getDb();
  for (const u of [USER, OTHER]) {
    await db.delete(importFiles).where(eq(importFiles.userId, u));
    await db.delete(imports).where(eq(imports.userId, u));
  }

  console.log("an export is kept file by file");
  const first = await upload(USER, {
    "Invitations.csv": INVITES,
    "Company Follows.csv": FOLLOWS,
    // A private member that got past the browser anyway: never stored.
    "Registration.csv": "Registered At,Registration Ip\n1/1/20,10.0.0.1\n",
    "notes.txt": "not a csv",
  });
  check("only the two allowed files are saved", first.appended.saved === 2 && first.stats.filesSaved === 2, JSON.stringify(first));
  check("the counts the browser sent are recorded", first.stats.filesPrivate === 2 && first.stats.filesTooLarge === 0);
  const listed = await listExportFiles(USER, first.importId);
  check(
    "listed by path, with the role decided on the server",
    listed.map((f) => `${f.path}:${f.role}`).join(",") === "Company Follows.csv:stored,Invitations.csv:parsed",
    listed.map((f) => `${f.path}:${f.role}`).join(","),
  );
  const texts = await readExportTexts(USER, first.importId);
  check("read back byte for byte (quoted multi-line message intact)", texts.get("invitations.csv") === INVITES);
  check("the uncompressed size is kept", listed.find((f) => f.path === "Invitations.csv")?.byteSize === Buffer.byteLength(INVITES));

  console.log("\nthe upload is closed once finished");
  check(
    "appending to a finished export is refused",
    await refuses(() => appendExportFiles(USER, first.importId, [{ path: "Notes.csv", byteSize: 1, gz: "" }])),
  );
  const { importId: staging } = await beginExport(USER, "x");
  check(
    "another account cannot append to it",
    await refuses(() => appendExportFiles(OTHER, staging, [{ path: "Notes.csv", byteSize: 1, gz: "" }])),
  );
  check("…nor read it", (await readExportTexts(OTHER, first.importId)).size === 0 && (await listExportFiles(OTHER, first.importId)).length === 0);
  await db.delete(imports).where(eq(imports.id, staging));

  console.log("\nonly the latest export is kept");
  const otherUpload = await upload(OTHER, { "Invitations.csv": INVITES });
  const second = await upload(USER, { "Invitations.csv": INVITES });
  check("the first export's files are gone", (await listExportFiles(USER, first.importId)).length === 0);
  check("…its history row stays", Boolean(await db.query.imports.findFirst({ where: eq(imports.id, first.importId) })));
  check("the second export's file is there", (await listExportFiles(USER, second.importId)).length === 1);
  check("another account's export is untouched", (await listExportFiles(OTHER, otherUpload.importId)).length === 1);

  console.log("\nforgetting them");
  await deleteExportFiles(USER, second.importId);
  check("deleting removes the files", (await listExportFiles(USER, second.importId)).length === 0);
  await purgeUserData(OTHER, { only: ["imports"] });
  check(
    "the account purge (imports) leaves no files behind",
    (await db.select().from(importFiles).where(eq(importFiles.userId, OTHER))).length === 0,
  );

  for (const u of [USER, OTHER]) {
    await db.delete(importFiles).where(eq(importFiles.userId, u));
    await db.delete(imports).where(eq(imports.userId, u));
  }
  console.log(failures ? `\n${failures} check(s) failed` : "\nsmoke-import-files: all checks passed");
  if (failures) process.exit(1);
}

run(main);
