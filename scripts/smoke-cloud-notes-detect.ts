/**
 * Cloud notes, without a database: which docs read as meeting notes (rules only), turning a
 * .docx and a Teams/Zoom .vtt into text, and the Drive/Graph listing and change calls against
 * canned responses — including the cursor hand-off and the "only follow Graph's own links" guard.
 *
 * Run: npx tsx scripts/smoke-cloud-notes-detect.ts
 */
import JSZip from "jszip";
import {
  docxToText,
  listChanges,
  listRecentFiles,
  readFileText,
  startChangeCursor,
  vttToText,
} from "../src/lib/cloud-files";
import { classifyNoteDoc } from "../src/lib/cloud-notes/detect";
import { ReauthRequiredError } from "../src/lib/errors";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {
  console.log("Detection");
  const v = (name: string, head: string) => classifyNoteDoc({ name, head }).verdict;
  check("Gemini meeting notes", v("Weekly product sync", "Notes by Gemini\nAttendees: Ana, Raj\nSummary…") === "yes");
  check("attendees line, neutral name", v("Q3 thoughts", "Oct 2, 2026\nAttendees: Priya, Marco\nWe talked about…") === "yes");
  check("action items heading", v("Untitled document", "Spoke with Lena about the role.\n\nAction items\n- send deck") === "yes");
  check(
    "chat transcript",
    v("export", "[10:02] Priya Shah: hey!\n[10:03] Jason: hi\n[10:05] Priya Shah: are we still on for Friday?\n[10:06] Jason: yes") === "yes",
  );
  check("named 1:1 with a date line", v("1:1 Priya / Jason", "2026-10-01\nShe wants to move to platform.") === "yes");
  check("named like notes, nothing in the text → maybe", v("Coffee with Marco", "He grew up in Lisbon and loves cycling.") === "maybe");
  check(
    "a maybe named like notes is offered without an engine",
    classifyNoteDoc({ name: "Coffee with Marco", head: "He grew up in Lisbon." }).offerWithoutEngine === true,
  );
  check("only a date → maybe, not offered without an engine", classifyNoteDoc({ name: "Thoughts", head: "Oct 3\nRandom ideas for the garden" }).offerWithoutEngine === false);
  check("template is ruled out by name", v("Meeting notes template", "Attendees:\nAgenda:") === "no");
  check("résumé is ruled out by name", v("Resume 2026", "Experience\nAcme — Engineer") === "no");
  check("plain essay → no", v("Essay draft", "The history of the bicycle begins in 1817.") === "no");
  check("empty doc → no", v("Untitled document", "   ") === "no");

  console.log("\nReading formats");
  const zip = new JSZip();
  zip.file(
    "word/document.xml",
    `<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t>Attendees: Ana &amp; Raj</w:t></w:r></w:p><w:p><w:r><w:t>Next</w:t></w:r><w:r><w:tab/><w:t>steps</w:t></w:r></w:p></w:body></w:document>`,
  );
  const docx = await zip.generateAsync({ type: "arraybuffer" });
  const docxText = await docxToText(docx);
  check("docx paragraphs become lines, entities decoded", docxText === "Attendees: Ana & Raj\nNext\tsteps", JSON.stringify(docxText));
  const vtt = vttToText("WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.000\n<v Priya Shah>Hello there</v>\n\n2\n00:00:04.000 --> 00:00:05.000\n<v Jason>Hi</v>\n");
  check("vtt keeps speaker: line, drops timings", vtt === "Priya Shah: Hello there\nJason: Hi", JSON.stringify(vtt));

  console.log("\nGoogle Drive calls");
  const seen: string[] = [];
  const google: typeof fetch = async (input) => {
    const url = String(input);
    seen.push(url);
    if (url.includes("/changes/startPageToken")) return Response.json({ startPageToken: "100" });
    if (url.includes("/changes?")) {
      const page = new URL(url).searchParams.get("pageToken");
      if (page === "100") {
        return Response.json({
          nextPageToken: "101",
          changes: [
            { file: { id: "doc-aaaaaaaaaa", name: "Sync notes", mimeType: "application/vnd.google-apps.document", modifiedTime: "2026-10-10T10:00:00Z" } },
            { file: { id: "sheet-aaaaaaaa", name: "Budget", mimeType: "application/vnd.google-apps.spreadsheet" } },
            { removed: true },
          ],
        });
      }
      return Response.json({ newStartPageToken: "102", changes: [] });
    }
    if (url.includes("/files?")) {
      return Response.json({ files: [{ id: "doc-bbbbbbbbbb", name: "1:1 Ana", mimeType: "application/vnd.google-apps.document", modifiedTime: "2026-10-09T10:00:00Z" }] });
    }
    return new Response("nope", { status: 404 });
  };
  const gctx = { token: "t", fetchImpl: google };
  check("start cursor", (await startChangeCursor(gctx, "google")) === "100");
  const page1 = await listChanges(gctx, "google", "100");
  check("changes keep Docs only", page1.files.length === 1 && page1.files[0].id === "doc-aaaaaaaaaa");
  check("a next page is not done", page1.cursor === "101" && !page1.done);
  const page2 = await listChanges(gctx, "google", "101");
  check("the last page hands back the from-now cursor", page2.cursor === "102" && page2.done);
  await listRecentFiles(gctx, "google", { query: "Ana's", since: new Date("2026-09-14T00:00:00Z") });
  const q = new URL(seen.at(-1)!).searchParams.get("q") ?? "";
  check("search quotes the name and bounds the date", q.includes("name contains 'Ana\\'s'") && q.includes("modifiedTime > '2026-09-14"), q);

  const dead: typeof fetch = async () => new Response("", { status: 401 });
  let reauth = false;
  try {
    await listChanges({ token: "t", fetchImpl: dead }, "google", "100");
  } catch (err) {
    reauth = err instanceof ReauthRequiredError;
  }
  check("a 401 is a reconnect, not a crash", reauth);

  console.log("\nOneDrive calls");
  const GRAPH = "https://graph.microsoft.com/v1.0";
  const ms: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("delta?token=latest")) return Response.json({ value: [], "@odata.deltaLink": `${GRAPH}/me/drive/root/delta?token=d1` });
    if (url.includes("token=d1")) {
      return Response.json({
        value: [
          { id: "ITEM!1aaaa", name: "Standup.docx", file: {}, lastModifiedDateTime: "2026-10-10T10:00:00Z", size: 1000 },
          { id: "ITEM!2aaaa", name: "photo.jpg", file: {} },
          { id: "ITEM!3aaaa", name: "Folder", folder: {} },
          { id: "ITEM!4aaaa", name: "Old.docx", file: {}, deleted: {} },
        ],
        "@odata.deltaLink": `${GRAPH}/me/drive/root/delta?token=d2`,
      });
    }
    if (url.includes("/me/drive/recent")) {
      return Response.json({ value: [{ id: "ITEM!5aaaa", name: "Call.txt", file: {}, lastModifiedDateTime: "2026-10-01T10:00:00Z" }] });
    }
    if (url.includes("/content")) return new Response(docx);
    return new Response("nope", { status: 404 });
  };
  const mctx = { token: "t", fetchImpl: ms };
  const mstart = await startChangeCursor(mctx, "microsoft");
  check("delta link as the cursor", mstart.endsWith("token=d1"));
  const mpage = await listChanges(mctx, "microsoft", mstart);
  check("only readable, live files", mpage.files.map((f) => f.id).join() === "ITEM!1aaaa");
  check("the delta link closes the page", mpage.done && mpage.cursor.endsWith("token=d2"));
  let refused = false;
  try {
    await listChanges(mctx, "microsoft", "https://evil.example.com/steal");
  } catch {
    refused = true;
  }
  check("never follows a cursor that is not Graph's", refused);
  const recent = await listRecentFiles(mctx, "microsoft");
  check("recent lists text files", recent.files.length === 1 && recent.files[0].name === "Call.txt");
  const text = await readFileText(mctx, "microsoft", { id: "ITEM!1aaaa", name: "Standup.docx" });
  check("a OneDrive .docx reads as text", text.startsWith("Attendees: Ana & Raj"));

  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll cloud-notes detection checks passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
