/**
 * Attachment rules: ownership by path prefix, real sizes from head(), per-mailbox limits,
 * blocked types, filename cleaning, and loading bytes. The blob client is faked.
 * Run: npx tsx scripts/smoke-email-attachments.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import { purgeUserData } from "../src/lib/user-data";
import {
  attachmentPrefixFor,
  purgeEmailAttachmentsForUser,
  sweepEmailAttachments,
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
const deleted: string[] = [];
let listed: { pathname: string; url: string; uploadedAt: Date }[] = [];
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
  async del(p: string | string[]) {
    deleted.push(...(Array.isArray(p) ? p : [p]));
  },
  async list({ prefix }: { prefix: string }) {
    return { blobs: listed.filter((b) => b.pathname.startsWith(prefix)), hasMore: false, cursor: undefined };
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

  console.log("token route");
  const fs = await import("node:fs");
  const route = fs.readFileSync("src/app/api/email/attachments/upload/route.ts", "utf8");
  check("the token route is gated on Compose", route.includes("requireUserForSurface(COMPOSE_SURFACE_KEY)"));
  check("tokens are only for the user's own prefix", route.includes("attachmentPrefixFor(userId)"));
  check("only token requests are handled (no unauthenticated completion callback)", route.includes('body.type !== "blob.generate-client-token"'));
  check("the token route is not public", !fs.readFileSync("src/lib/public-routes.ts", "utf8").includes("/api/email/attachments"));

  console.log("sweep");
  const SWEEP = "smoke-attach-sweep";
  const db = await getDb();
  await purgeUserData(SWEEP, { keepSettings: false }).catch(() => {});
  try {
    const p = attachmentPrefixFor(SWEEP);
    const day = 24 * 3600_000;
    const ago = (ms: number) => new Date(Date.now() - ms);
    const ref = (key: string) => JSON.stringify([{ blobKey: key, filename: "f.pdf", contentType: "application/pdf", size: 4 }]);
    const row = async (status: string, key: string, updated: Date) => {
      await db.execute(sql`
        INSERT INTO email_sends (user_id, provider, from_email, to_emails, subject, body_text, origin, status, send_at, rfc_message_id, attachments, updated_at)
        VALUES (${SWEEP}, 'gmail', 'me@acme-corp.io', '["a@work.org"]'::jsonb, 'S', 'B', 'compose', ${status}, now(), ${`<${key}@orbit.mail>`}, ${ref(key)}::jsonb, ${updated})`);
    };
    await row("sent", `${p}old/f.pdf`, ago(8 * day));
    await row("sent", `${p}new/f.pdf`, ago(1 * day));
    await row("queued", `${p}live/f.pdf`, ago(9 * day));
    listed = [
      { pathname: `${p}orphan/f.pdf`, url: "u", uploadedAt: ago(3 * day) },
      { pathname: `${p}live/f.pdf`, url: "u", uploadedAt: ago(9 * day) },
      { pathname: `${p}fresh/f.pdf`, url: "u", uploadedAt: ago(3600_000) },
    ];
    deleted.length = 0;
    const swept = await sweepEmailAttachments();
    const rows = rowsOf<{ id: string; attachments: unknown[] }>(
      await db.execute(sql`SELECT rfc_message_id AS id, attachments FROM email_sends WHERE user_id = ${SWEEP}`)
    );
    const files = (k: string) => rows.find((r) => r.id.includes(k))?.attachments.length;
    check("a send settled 8 days ago loses its files", files("old") === 0 && deleted.includes(`${p}old/f.pdf`), JSON.stringify(swept));
    check("one settled yesterday keeps them", files("new") === 1 && !deleted.includes(`${p}new/f.pdf`));
    check("an old unsent upload is deleted", deleted.includes(`${p}orphan/f.pdf`));
    check("a file a queued send needs is kept", files("live") === 1 && !deleted.includes(`${p}live/f.pdf`));
    check("a fresh upload is kept", !deleted.includes(`${p}fresh/f.pdf`));
    check("counts add up", swept.settled === 1 && swept.orphans === 1, JSON.stringify(swept));

    deleted.length = 0;
    await purgeEmailAttachmentsForUser(SWEEP);
    check("purge deletes everything under the user's prefix", deleted.length === 3 && deleted.every((d) => d.startsWith(p)));
  } finally {
    await purgeUserData(SWEEP, { keepSettings: false }).catch(() => {});
  }

  setAttachmentBlobClientForTests(null);
  if (failures) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll attachment checks passed.");
}

run(main);
