/**
 * Attachment rules: ownership by path prefix, real sizes from head(), per-mailbox limits,
 * blocked types, filename cleaning, and loading bytes. The blob client is faked.
 * Run: npx tsx scripts/smoke-email-attachments.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import {
  attachmentPrefixFor,
  isBlockedFilename,
  loadAttachmentBytes,
  safeFilename,
  setAttachmentBlobClientForTests,
  verifyAttachmentRefs,
} from "../src/lib/email/attachments";
import { MailProviderError } from "../src/lib/email/providers/types";

const USER = "user-a";
let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const store = new Map<string, { size: number; contentType: string; bytes: Uint8Array }>();
const MB = 1024 * 1024;
function putFake(pathname: string, size: number, contentType = "application/pdf") {
  store.set(pathname, { size, contentType, bytes: new Uint8Array(Math.min(size, 16)).fill(7) });
}
let outage = false;
setAttachmentBlobClientForTests({
  async head(p: string) {
    const b = store.get(p);
    if (!b) throw Object.assign(new Error("not found"), { name: "BlobNotFoundError" });
    return { pathname: p, url: `https://blob.test/${p}`, size: b.size, contentType: b.contentType };
  },
  async get(p: string) {
    if (outage) throw new Error("503");
    const b = store.get(p);
    return b ? { bytes: b.bytes } : null;
  },
  async del() {},
  async list() {
    return { blobs: [], hasMore: false, cursor: undefined };
  },
});

async function main() {
  const mine = attachmentPrefixFor(USER);
  check("prefix is user-scoped", mine === "email-attachments/user-a/");

  console.log("names and types");
  check("exe is blocked", isBlockedFilename("invoice.EXE") && isBlockedFilename("a.b.js"));
  check("pdf is fine", !isBlockedFilename("resume.pdf") && !isBlockedFilename("notes"));
  check("paths are stripped", safeFilename("../../etc/passwd") === "passwd" && safeFilename("C:\\x\\y.pdf") === "y.pdf");
  check("control chars stripped, never empty", safeFilename("a\u0000\r\nb.pdf") === "ab.pdf" && safeFilename("\u0000") === "attachment");

  console.log("verification");
  putFake(`${mine}1/resume.pdf`, 2 * MB);
  putFake(`${mine}2/deck.pdf`, 2 * MB);
  putFake("email-attachments/user-b/3/theirs.pdf", 1 * MB);
  const ok = await verifyAttachmentRefs(USER, [{ pathname: `${mine}1/resume.pdf`, filename: "resume.pdf" }], "gmail");
  check("own upload verifies, with the real size", ok.ok && ok.refs[0]!.size === 2 * MB && ok.refs[0]!.contentType === "application/pdf", JSON.stringify(ok));
  const foreign = await verifyAttachmentRefs(USER, [{ pathname: "email-attachments/user-b/3/theirs.pdf", filename: "x.pdf" }], "gmail");
  check("another user's upload is refused", !foreign.ok && foreign.reason === "not_found");
  const escape = await verifyAttachmentRefs(USER, [{ pathname: `${mine}../user-b/3/theirs.pdf`, filename: "x.pdf" }], "gmail");
  check("a traversal out of the prefix is refused", !escape.ok);
  const missing = await verifyAttachmentRefs(USER, [{ pathname: `${mine}9/gone.pdf`, filename: "gone.pdf" }], "gmail");
  check("a missing blob is refused", !missing.ok && missing.reason === "not_found");
  const blocked = await verifyAttachmentRefs(USER, [{ pathname: `${mine}1/resume.pdf`, filename: "run.exe" }], "gmail");
  check("a blocked name is refused", !blocked.ok && blocked.reason === "blocked_type");
  const twoForOutlook = await verifyAttachmentRefs(USER, [
    { pathname: `${mine}1/resume.pdf`, filename: "resume.pdf" },
    { pathname: `${mine}2/deck.pdf`, filename: "deck.pdf" },
  ], "outlook");
  check("4 MB is over Outlook's 3 MB", !twoForOutlook.ok && twoForOutlook.reason === "too_large" && /Outlook/.test(twoForOutlook.message), JSON.stringify(twoForOutlook));
  check("but fine for Gmail", (await verifyAttachmentRefs(USER, [
    { pathname: `${mine}1/resume.pdf`, filename: "resume.pdf" },
    { pathname: `${mine}2/deck.pdf`, filename: "deck.pdf" },
  ], "gmail")).ok);
  putFake(`${mine}4/huge.zip`, 21 * MB, "application/zip");
  check("21 MB is over Gmail's 20 MB", !(await verifyAttachmentRefs(USER, [{ pathname: `${mine}4/huge.zip`, filename: "huge.zip" }], "gmail")).ok);
  const eleven = Array.from({ length: 11 }, () => ({ pathname: `${mine}1/resume.pdf`, filename: "r.pdf" }));
  const tooMany = await verifyAttachmentRefs(USER, eleven, "gmail");
  check("11 files is too many", !tooMany.ok && tooMany.reason === "too_many");
  check("no attachments is fine", (await verifyAttachmentRefs(USER, [], "outlook")).ok);

  console.log("loading");
  const refs = ok.ok ? ok.refs : [];
  const loaded = await loadAttachmentBytes(refs);
  check("bytes load with the stored name and type", loaded.length === 1 && loaded[0]!.filename === "resume.pdf" && loaded[0]!.bytes.length > 0);
  outage = true;
  const outageErr = await loadAttachmentBytes(refs).then(() => null, (e) => e);
  check("a blob outage is transient", outageErr instanceof MailProviderError && outageErr.kind === "transient");
  outage = false;
  store.delete(`${mine}1/resume.pdf`);
  const goneErr = await loadAttachmentBytes(refs).then(() => null, (e) => e);
  check("a deleted blob is permanent", goneErr instanceof MailProviderError && goneErr.kind === "permanent");

  setAttachmentBlobClientForTests(null);
  if (failures) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll attachment checks passed.");
}

run(main);
