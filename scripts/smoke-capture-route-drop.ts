/**
 * Capture's universal drop — which destination each file of a drop goes to.
 *
 * Import detection decides first; only what it cannot read is retried as a note or a
 * recording. So a `Connections.csv` full of messages is still a messages import, an `.ics`
 * is a calendar import rather than a note, and a PDF or `.m4a` is never refused.
 *
 * Pure tier: no database, no DOM. `File` and `Blob.text()` are Node globals.
 *
 * Run: npx tsx scripts/smoke-capture-route-drop.ts
 */
import JSZip from "jszip";
import type { DroppedFile } from "../src/lib/capture/file-drop";
import {
  isMixedDrop,
  matchesAccept,
  routeDrop,
  summarizeRoute,
} from "../src/lib/capture/route-drop";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

function drop(name: string, body: BlobPart, path = "", type = ""): DroppedFile {
  return { file: new File([body], name, { type }), path };
}

const CONNECTIONS = [
  "First Name,Last Name,URL,Email Address,Company,Position,Connected On",
  "Jane,Doe,https://www.linkedin.com/in/jane-doe,jane@acme.example,Acme,Engineer,15 Jan 2024",
].join("\n");
const MESSAGES = [
  "CONVERSATION ID,CONVERSATION TITLE,FROM,SENDER PROFILE URL,TO,DATE,SUBJECT,CONTENT",
  "c1,Jane Doe,Jane Doe,https://www.linkedin.com/in/jane-doe,Me,2024-03-01 10:00:00 UTC,,Hey there",
].join("\n");
const ICS = "BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nSUMMARY:Coffee\nDTSTART:20240301T100000Z\nEND:VEVENT\nEND:VCALENDAR\n";
const PDF = "%PDF-1.4\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\n";

async function linkedInZip(): Promise<File> {
  const zip = new JSZip();
  zip.file("Connections.csv", CONNECTIONS);
  zip.file("messages.csv", MESSAGES);
  zip.file("Invitations.csv", "From,To,Sent At,Message,Direction\n");
  zip.file("Receipts_v2.csv", "Transaction Made At,Description\n");
  const bytes = await zip.generateAsync({ type: "arraybuffer" });
  return new File([bytes], "Basic_LinkedInDataExport_01-01-2024.zip", { type: "application/zip" });
}

async function main() {
  console.log("\naccept matching");
  check(".m4a by extension", matchesAccept(".m4a", { name: "Memo.M4A", type: "" }));
  check("audio/* by type", matchesAccept("audio/*", { name: "x", type: "audio/mpeg" }));
  check("exact type", matchesAccept("application/pdf", { name: "x", type: "application/pdf" }));
  check("no match", !matchesAccept(".pdf,image/*", { name: "a.exe", type: "application/x-msdownload" }));

  console.log("\na Connections.csv full of messages goes to messages");
  {
    const r = await routeDrop([drop("Connections.csv", MESSAGES)]);
    check("staged as messages", r.imports.staged.map((d) => d.target).join() === "linkedin_messages",
      r.imports.staged.map((d) => d.target).join());
    check("not a note", r.notes.length === 0);
  }

  console.log("\na PDF goes to notes");
  {
    const r = await routeDrop([drop("Standup.pdf", PDF, "", "application/pdf")]);
    check("one note", r.notes.length === 1 && r.notes[0]!.file.name === "Standup.pdf");
    check("not ignored", r.ignored.length === 0 && r.imports.ignored.length === 0);
    check("not mixed", !isMixedDrop(r));
  }

  console.log("\nan .m4a goes to audio");
  {
    const r = await routeDrop([drop("Voice memo.m4a", new Uint8Array([0, 0, 0, 32, 102, 116, 121, 112]))]);
    check("one recording", r.audio.length === 1 && r.notes.length === 0);
  }

  console.log("\na mixed folder");
  {
    const r = await routeDrop(
      [
        drop("Q1 sync.pdf", PDF, "Notes", "application/pdf"),
        drop("1-1 Raj.md", "# Raj\nTalked about hiring", "Notes"),
        drop("whiteboard.png", new Uint8Array([137, 80, 78, 71]), "Notes", "image/png"),
        drop("Kickoff.m4a", new Uint8Array([0, 0, 0, 32]), "Notes", "audio/mp4"),
        drop("invite.ics", ICS, "Notes"),
        drop("setup.exe", new Uint8Array([77, 90]), "Notes"),
        { file: await linkedInZip(), path: "" },
      ],
      { text: "met https://www.linkedin.com/in/jane-doe today" },
    );
    check("3 notes, paths kept",
      r.notes.length === 3 && r.notes.every((n) => n.path === "Notes"),
      r.notes.map((n) => n.file.name).join());
    check("1 recording", r.audio.length === 1);
    const targets = r.imports.staged.map((d) => d.target);
    check("ics is a calendar import, not a note",
      targets.includes("calendar_ics") && !r.notes.some((n) => n.file.name.endsWith(".ics")));
    check("LinkedIn ZIP staged", targets.includes("linkedin_connections") && targets.includes("linkedin_messages"),
      targets.join());
    check("export kept", r.imports.exportFiles.length > 0);
    check("exe ignored with its reason",
      r.ignored.length === 1 && r.ignored[0]!.name === "setup.exe" && r.ignored[0]!.reason === "not something Orbit reads",
      JSON.stringify(r.ignored));
    check("import queue no longer lists the notes",
      r.imports.ignored.every((d) => !/\.(pdf|md|png|m4a)$/.test(d.file.name)));
    check("private export member is not a skipped file",
      !r.ignored.some((i) => i.name.startsWith("Receipts")));
    check("LinkedIn URL from the text", r.linkedinUrls.length === 1, r.linkedinUrls.join());
    check("mixed", isMixedDrop(r));
    const summary = summarizeRoute(r);
    check("summary", summary === "3 notes, 1 recording, 1 LinkedIn export, 1 calendar file, 1 LinkedIn profile, 1 skipped", summary);
  }

  console.log(failures ? `\n${failures} failed` : "\nall passed");
  process.exit(failures ? 1 : 0);
}

void main();
