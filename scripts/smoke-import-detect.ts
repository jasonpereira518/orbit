/**
 * File detection — which importer a dropped file belongs to.
 *
 * The fixtures are written the way each exporter actually writes them, because every one of
 * these was a way for "drop anything here" to quietly not work: LinkedIn's three-line `Notes:`
 * preamble (parse it unstripped and the header is the preamble, so a real Connections.csv
 * matches nothing), an archive that is mostly files nobody asked about, and a CSV whose name
 * says one thing and whose header says another.
 *
 * Pure tier: no database, no DOM. `File` and `Blob.text()` are Node globals.
 *
 * Run: npx tsx scripts/smoke-import-detect.ts
 */
import JSZip from "jszip";
import {
  classifyByHead,
  classifyByName,
  detectImportFiles,
  RUN_ORDER,
  type ImportTarget,
} from "../src/lib/imports/detect-import-file";
import type { DroppedFile } from "../src/lib/capture/file-drop";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

function drop(name: string, body: string, path = ""): DroppedFile {
  return { file: new File([body], name, { type: "text/plain" }), path };
}

// ---------------------------------------------------------------------------- fixtures

/** A real Connections.csv: three `Notes:` lines, a blank, then the header. */
const CONNECTIONS_WITH_PREAMBLE = [
  "Notes:",
  '"When exporting your connection data, you may notice that some of the email addresses are missing."',
  '"You will only see email addresses for connections who have allowed their connections to see it."',
  "",
  "First Name,Last Name,URL,Email Address,Company,Position,Connected On",
  "Jane,Doe,https://www.linkedin.com/in/jane-doe,jane@acme.example,Acme,Engineer,15 Jan 2024",
  "Raj,Patel,https://www.linkedin.com/in/raj-patel,,Globex,Designer,02 Feb 2024",
].join("\n");

const MESSAGES_CSV = [
  "CONVERSATION ID,CONVERSATION TITLE,FROM,SENDER PROFILE URL,TO,DATE,SUBJECT,CONTENT",
  "c1,Jane Doe,Jane Doe,https://www.linkedin.com/in/jane-doe,Me,2024-03-01 10:00:00 UTC,,Hey there",
].join("\n");

const GOOGLE_CSV = [
  "Name,Given Name,Family Name,E-mail 1 - Value,Organization Name,Phone 1 - Value",
  "Jane Doe,Jane,Doe,jane@acme.example,Acme,555-0100",
].join("\n");

const OUTLOOK_CSV = [
  "First Name,Last Name,E-mail Address,Company,Job Title,Business Phone",
  "Jane,Doe,jane@acme.example,Acme,Engineer,555-0100",
].join("\n");

const VCARD = [
  "BEGIN:VCARD",
  "VERSION:3.0",
  "FN:Jane Doe",
  "EMAIL:jane@acme.example",
  "END:VCARD",
].join("\n");

const ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "UID:abc-123",
  "SUMMARY:Coffee with Jane",
  "DTSTART:20240301T100000Z",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\n");

const CALENDAR_CSV = [
  "Subject,Start Date,Start Time,End Date,End Time,Required Attendees,Organizer",
  "Coffee with Jane,03/01/2024,10:00 AM,03/01/2024,10:30 AM,jane@acme.example,me@self.example",
].join("\n");

/** What LinkedIn actually puts in the archive alongside the two files that matter. */
const ARCHIVE_NOISE = [
  "Ad_Targeting.csv",
  "Invitations.csv",
  "Rich_Media.csv",
  "Registration.csv",
  "Profile.csv",
  "Skills.csv",
  "Endorsement_Received_Info.csv",
];

/**
 * The two archive members that are not merely noise but actively misleading: each one
 * classifies as an importer it does not belong to, so a folder drop that sniffed everything
 * could stage the wrong file.
 */
const INVITATIONS = [
  "From,To,Sent At,Message,Direction",
  "Ada Lovelace,Me,3/1/24 10:00 AM, ,INCOMING",
  "Grace Hopper,Me,3/2/24 11:00 AM,Hi there,INCOMING",
].join("\n");

const ARCHIVE_CONTACTS = [
  "First Name,Last Name,Email,Company",
  "Ada,Lovelace,ada@analytical.example,Acme",
].join("\n");

// ---------------------------------------------------------------- name and head, in isolation

console.log("Filename alone");
check(
  "Connections.csv is certain",
  classifyByName("Connections.csv")?.target === "linkedin_connections" &&
    classifyByName("Connections.csv")?.confidence === "certain"
);
check("messages.csv is certain", classifyByName("messages.csv")?.target === "linkedin_messages");
check("a .ics is certain", classifyByName("work.ics")?.target === "calendar_ics");
check("a .vcf is certain", classifyByName("cards.vcf")?.target === "contacts_file");
check("an unrelated name says nothing", classifyByName("notes.txt") === null);
check("a bare my-export.csv says nothing", classifyByName("my-export.csv") === null);

console.log("Header alone");
check(
  "Connections.csv WITH its Notes: preamble is still recognised",
  classifyByHead(CONNECTIONS_WITH_PREAMBLE)?.target === "linkedin_connections",
  String(classifyByHead(CONNECTIONS_WITH_PREAMBLE)?.target)
);
check("a messages header", classifyByHead(MESSAGES_CSV)?.target === "linkedin_messages");
check("a Google contacts CSV", classifyByHead(GOOGLE_CSV)?.target === "contacts_file");
check("an Outlook contacts CSV", classifyByHead(OUTLOOK_CSV)?.target === "contacts_file");
check("a vCard by its BEGIN line", classifyByHead(VCARD)?.target === "contacts_file");
check("an iCalendar by its BEGIN line", classifyByHead(ICS)?.target === "calendar_ics");
check(
  "a calendar CSV beats the contacts recogniser despite its organizer column",
  classifyByHead(CALENDAR_CSV)?.target === "calendar_csv",
  String(classifyByHead(CALENDAR_CSV)?.target)
);
check("prose is nothing", classifyByHead("lorem ipsum dolor sit amet\n") === null);

// ------------------------------------------------------------------------ end to end

async function main() {
  console.log("A whole drop");

  const mixed = await detectImportFiles([
    drop("messages.csv", MESSAGES_CSV),
    drop("Connections.csv", CONNECTIONS_WITH_PREAMBLE),
    drop("work.ics", ICS),
    drop("readme.txt", "hello"),
  ]);
  check(
    "connections runs before messages regardless of drop order",
    mixed.staged.map((d) => d.target).join(",") ===
      "linkedin_connections,linkedin_messages,calendar_ics",
    mixed.staged.map((d) => d.target).join(",")
  );
  check("an unreadable file is ignored, not failed", mixed.ignored.length === 1);
  check("nothing was skipped", mixed.skipped.length === 0);

  const mislabelled = await detectImportFiles([drop("my-export.csv", MESSAGES_CSV)]);
  check(
    "a mislabelled CSV routes on its header instead of being refused",
    mislabelled.staged[0]?.target === "linkedin_messages",
    String(mislabelled.staged[0]?.target)
  );

  const renamed = await detectImportFiles([drop("Connections.csv", MESSAGES_CSV)]);
  check(
    "a header beats even a name LinkedIn controls",
    renamed.staged[0]?.target === "linkedin_messages",
    String(renamed.staged[0]?.target)
  );

  const twins = await detectImportFiles([
    drop("Connections.csv", CONNECTIONS_WITH_PREAMBLE),
    drop("Connections.csv", CONNECTIONS_WITH_PREAMBLE + "\nAmy,Lee,,,Initech,PM,03 Mar 2024"),
  ]);
  check("two files of one kind stage only one", twins.staged.length === 1);
  check("…the larger one", (twins.staged[0]?.bytes ?? 0) > (twins.skipped[0]?.bytes ?? 0));
  check("…and the other is skipped, with a reason", twins.skipped.length === 1);

  const nothing = await detectImportFiles([drop("holiday.jpg", "\xff\xd8\xff")]);
  check("a drop with nothing in it stages nothing", nothing.staged.length === 0);
  check("…and reports it as ignored, not an error", nothing.ignored.length === 1);

  const noise = await detectImportFiles([drop(".DS_Store", "junk"), drop("work.ics", ICS)]);
  check("platform noise never appears at all", noise.ignored.length === 0 && noise.staged.length === 1);

  const big = await detectImportFiles([drop("Connections.csv", CONNECTIONS_WITH_PREAMBLE)], {
    maxBytes: 10,
  });
  check("an oversize file is skipped, not staged", big.staged.length === 0 && big.skipped.length === 1);
  check("…and says why", /too big/.test(big.skipped[0]?.reason ?? ""));

  console.log("A LinkedIn archive");
  const zip = new JSZip();
  zip.file("Connections.csv", CONNECTIONS_WITH_PREAMBLE);
  zip.file("messages.csv", MESSAGES_CSV);
  for (const name of ARCHIVE_NOISE) zip.file(name, "Header\nrow\n");
  const zipBlob = await zip.generateAsync({ type: "arraybuffer" });
  const archive: DroppedFile = {
    file: new File([zipBlob], "Basic_LinkedInDataExport_01-01-2024.zip"),
    path: "",
  };

  const fromZip = await detectImportFiles([archive]);
  check(
    "the two files that matter are staged, in run order",
    fromZip.staged.map((d) => d.target).join(",") === "linkedin_connections,linkedin_messages",
    fromZip.staged.map((d) => d.target).join(",")
  );
  check(
    `the other ${ARCHIVE_NOISE.length} members are silent`,
    fromZip.ignored.length === 0 && fromZip.skipped.length === 0
  );
  check(
    "their text is carried, so nothing is read twice",
    fromZip.staged.every((d) => (d.text ?? "").length > 0)
  );
  check(
    "the connections text kept its preamble for the parser to strip",
    (fromZip.staged[0]?.text ?? "").startsWith("Notes:")
  );

  const soloZip = new JSZip();
  soloZip.file("export/whatever.csv", GOOGLE_CSV);
  const soloBlob = await soloZip.generateAsync({ type: "arraybuffer" });
  const solo = await detectImportFiles([
    { file: new File([soloBlob], "backup.zip"), path: "" },
  ]);
  check(
    "a ZIP holding one unrecognised-by-name CSV is sniffed",
    solo.staged[0]?.target === "contacts_file",
    String(solo.staged[0]?.target)
  );

  const emptyZip = new JSZip();
  emptyZip.file("photo.png", "binary");
  const emptyBlob = await emptyZip.generateAsync({ type: "arraybuffer" });
  const nothingInside = await detectImportFiles([
    { file: new File([emptyBlob], "photos.zip"), path: "" },
  ]);
  check(
    "a ZIP with nothing importable is ignored, not an error",
    nothingInside.staged.length === 0 && nothingInside.ignored.length === 1
  );

  console.log("A whole LinkedIn export folder");
  // Named the way the archive actually unzips: everything under one folder.
  const folder = (name: string, body: string) =>
    drop(name, body, "Basic_LinkedInDataExport_01-01-2024");
  const exportFolder = await detectImportFiles([
    folder("Connections.csv", CONNECTIONS_WITH_PREAMBLE),
    folder("messages.csv", MESSAGES_CSV),
    folder("Invitations.csv", INVITATIONS),
    folder("Contacts.csv", ARCHIVE_CONTACTS),
    ...ARCHIVE_NOISE.filter((n) => n !== "Invitations.csv").map((n) =>
      folder(n, "Header,Row\na,b\n")
    ),
  ]);
  check(
    "only Connections.csv and messages.csv are staged",
    exportFolder.staged.map((d) => d.target).join(",") ===
      "linkedin_connections,linkedin_messages",
    exportFolder.staged.map((d) => `${d.file.name}:${d.target}`).join(" | ")
  );
  check(
    "Invitations.csv is not staged, though its From/To columns sniff as messages",
    classifyByHead(INVITATIONS)?.target === "linkedin_messages" &&
      !exportFolder.staged.some((d) => d.file.name === "Invitations.csv"),
    String(classifyByHead(INVITATIONS)?.target)
  );
  check(
    "the archive's own Contacts.csv is not staged either",
    classifyByHead(ARCHIVE_CONTACTS)?.target === "contacts_file" &&
      !exportFolder.staged.some((d) => d.file.name === "Contacts.csv")
  );
  check(
    "nothing is silently lost — the rest is accounted for as ignored",
    exportFolder.ignored.length === ARCHIVE_NOISE.length + 1,
    `${exportFolder.ignored.length} ignored`
  );
  check(
    "...and says why, once",
    exportFolder.ignored.every((d) => d.reason === "not needed from a LinkedIn export")
  );
  check("nothing is skipped", exportFolder.skipped.length === 0);

  // A bigger Invitations.csv would otherwise WIN the messages slot outright.
  const lopsided = await detectImportFiles([
    folder("messages.csv", MESSAGES_CSV),
    folder("Invitations.csv", INVITATIONS + "\n" + "x,y,z,w,v\n".repeat(400)),
  ]);
  check(
    "a large Invitations.csv cannot displace the real messages.csv",
    lopsided.staged.length === 1 && lopsided.staged[0].file.name === "messages.csv",
    lopsided.staged.map((d) => d.file.name).join(",")
  );

  // Loose files are hand-picked, so a Connections.csv among them must not bin the others.
  const handPicked = await detectImportFiles([
    drop("Connections.csv", CONNECTIONS_WITH_PREAMBLE),
    drop("work.ics", ICS),
    drop("my-contacts.csv", GOOGLE_CSV),
  ]);
  check(
    "a loose Connections.csv does not discard the other files dropped with it",
    handPicked.staged.map((d) => d.target).join(",") ===
      "linkedin_connections,contacts_file,calendar_ics",
    handPicked.staged.map((d) => d.target).join(",")
  );

  // ...but the same three INSIDE an export folder are gated.
  const insideFolder = await detectImportFiles([
    drop("Connections.csv", CONNECTIONS_WITH_PREAMBLE, "LinkedInExport"),
    drop("work.ics", ICS, "LinkedInExport"),
    drop("my-contacts.csv", GOOGLE_CSV, "LinkedInExport"),
  ]);
  check(
    "the same files inside an export folder are gated to the members",
    insideFolder.staged.map((d) => d.target).join(",") === "linkedin_connections",
    insideFolder.staged.map((d) => d.target).join(",")
  );

  // The gate keys on the export's own member names, so an ordinary folder is unaffected.
  const ordinary = await detectImportFiles([
    drop("my-contacts.csv", GOOGLE_CSV, "exports"),
    drop("team.ics", ICS, "exports"),
  ]);
  check(
    "a folder that is not a LinkedIn export still sniffs normally",
    ordinary.staged.map((d) => d.target).sort().join(",") === "calendar_ics,contacts_file",
    ordinary.staged.map((d) => d.target).join(",")
  );

  console.log("Contracts");
  const targets: ImportTarget[] = [
    "linkedin_connections",
    "contacts_file",
    "linkedin_messages",
    "calendar_ics",
    "calendar_csv",
  ];
  check(
    "RUN_ORDER covers every importable target exactly once",
    targets.every((t) => RUN_ORDER.filter((r) => r === t).length === 1) &&
      RUN_ORDER.length === targets.length
  );
  check(
    "no reason reads like a file path or an error code",
    [...mixed.staged, ...mixed.ignored, ...twins.skipped].every(
      (d) => !/[/\\]|Error|undefined|null/.test(d.reason)
    )
  );

  if (failures) {
    console.error(`\n${failures} detection check${failures === 1 ? "" : "s"} failed`);
    process.exit(1);
  }
  console.log("\nimport detection smoke tests passed");
  process.exit(0);
}

void main();
