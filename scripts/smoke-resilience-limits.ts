/**
 * Two bounds that keep a bad dependency or a hostile file from holding a shared function:
 * a deadline on Resend sends, and a cap on how far a .docx may inflate.
 *
 * Run: npx tsx scripts/smoke-resilience-limits.ts
 */
import JSZip from "jszip";
import { EmailDeadlineError, withEmailDeadline } from "../src/lib/email-deadline";
import { docxToText } from "../src/lib/cloud-files";
import { DriveFileTooLargeError } from "../src/lib/drive";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function docx(body: string): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("word/document.xml", body);
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

async function main() {
  process.on("unhandledRejection", (reason) => {
    console.log("  reason:", String(reason));
    failures++;
    console.log("  FAIL  an abandoned call became an unhandled rejection");
  });

  console.log("Resend deadline");
  check("a prompt answer passes through", (await withEmailDeadline(Promise.resolve("ok"), 200)) === "ok");
  let started = Date.now();
  const hung = await withEmailDeadline(new Promise<string>(() => {}), 150).catch((e) => e);
  check("a call that never answers is abandoned at the deadline",
    hung instanceof EmailDeadlineError && Date.now() - started >= 140 && Date.now() - started < 1000);
  const late = await withEmailDeadline(new Promise<string>((_, rej) => setTimeout(() => rej(new Error("boom")), 20)), 200).catch((e) => e);
  check("the call's own error is not masked", late instanceof Error && late.message === "boom");
  await withEmailDeadline(new Promise<string>((_, rej) => setTimeout(() => rej(new Error("late")), 120)), 30).catch(() => {});
  await new Promise((r) => setTimeout(r, 200));

  console.log("\n.docx inflation");
  const real = await docx('<w:document><w:p><w:t>Hello Maya</w:t></w:p><w:p><w:t>Second line</w:t></w:p></w:document>');
  check("a normal .docx reads as text", (await docxToText(real)) === "Hello Maya\nSecond line");
  const bomb = await docx("a".repeat(25 * 1024 * 1024));
  check("fixture: the bomb is tiny on the wire", bomb.byteLength < 200_000, `${bomb.byteLength} bytes`);
  const before = process.memoryUsage().rss;
  started = Date.now();
  const refused = await docxToText(bomb).catch((e) => e);
  check("an entry that inflates past the cap is refused", refused instanceof DriveFileTooLargeError, String(refused));
  check("…without materialising it", process.memoryUsage().rss - before < 150 * 1024 * 1024,
    `${Math.round((process.memoryUsage().rss - before) / 1024 / 1024)} MB`);
  check("a .docx with no document.xml is unavailable, not a crash",
    (await docxToText(await (async () => { const z = new JSZip(); z.file("other.txt", "x"); return z.generateAsync({ type: "uint8array" }); })()).catch((e) => e)) instanceof Error);

  console.log(failures === 0 ? "\nAll resilience-limit checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}
main();
