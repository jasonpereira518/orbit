/**
 * Browser-side chat file reading: which exporter wrote a file, and what a zip yields.
 *
 * Pure tier: no database, no DOM. `File` and `Blob.text()` are Node globals.
 * The media rule ("no `async()` on any member but a .txt") is checked by spying on the
 * ZipObject prototype JSZip shares across loads, so the reader's own zip is observed.
 *
 * Run: npx tsx scripts/smoke-chat-read-files.ts
 */
import "./smoke/_env";
import JSZip from "jszip";
import { detectChatSource, readChatFiles } from "../src/lib/conversations/read-files";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const WA_IOS = [
  "[13/03/2024, 09:15:02] Messages and calls are end-to-end encrypted. No one outside of this chat can read them.",
  "[13/03/2024, 09:15:02] Maya Chen: Hey! Are you free next Tuesday?",
  "[13/03/2024, 09:16:40] Jason Pereira: Yes — lunch at 1?",
].join("\n");
const WA_ANDROID = [
  "3/13/24, 2:05 PM - Messages and calls are end-to-end encrypted.",
  "3/13/24, 2:05 PM - Diego: Can you intro me to Priya?",
  "3/13/24, 2:07 PM - You: Sure, Friday",
].join("\n");
const IMESSAGE = ["", "Mar 05, 2024  2:03:45 PM", "+14155550134", "Are we still on for Thursday?", ""].join("\n");
const CSV = "First Name,Last Name,URL,Email Address,Company,Position,Connected On\nAna,Lee,,,,,01 Jan 2024\n";
const PROSE = "Notes from the offsite.\n\nWe talked about pricing: it should be simpler.\n";

console.log("detectChatSource");
check("whatsapp iOS head", detectChatSource("WhatsApp Chat with Maya Chen.txt", WA_IOS) === "whatsapp");
check("whatsapp Android head", detectChatSource("WhatsApp Chat with Diego.txt", WA_ANDROID) === "whatsapp");
check("imessage head", detectChatSource("+14155550134.txt", IMESSAGE) === "imessage");
check("csv head is not a chat", detectChatSource("Connections.csv", CSV) === null);
check("prose is not a chat", detectChatSource("notes.txt", PROSE) === null);
check(
  "a timestamped system line alone is not a chat",
  detectChatSource("x.txt", "[13/03/2024, 09:15:02] Messages and calls are end-to-end encrypted.") === null,
);

async function main() {
  // Spy on every ZipObject read. JSZip creates members from one shared prototype, so the
  // reader's own `loadAsync` uses the spied method too.
  const probe = await JSZip.loadAsync(await new JSZip().file("p.txt", "x").generateAsync({ type: "arraybuffer" }));
  const zipObjectProto = Object.getPrototypeOf(probe.file("p.txt")!) as {
    async: (this: { name: string }, ...args: unknown[]) => Promise<unknown>;
    nodeStream: (this: { name: string }, ...args: unknown[]) => unknown;
  };
  const reads: string[] = [];
  const realAsync = zipObjectProto.async;
  const realNodeStream = zipObjectProto.nodeStream;
  zipObjectProto.async = function (...args) {
    reads.push(this.name);
    return realAsync.apply(this, args);
  };
  zipObjectProto.nodeStream = function (...args) {
    reads.push(this.name);
    return realNodeStream.apply(this, args);
  };

  console.log("readChatFiles");
  const zip = new JSZip();
  zip.file("_chat.txt", WA_IOS);
  zip.file("IMG-0001.jpg", new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
  const zipBlob = await zip.generateAsync({ type: "arraybuffer" });
  reads.length = 0;
  const fromZip = await readChatFiles([new File([zipBlob], "WhatsApp Chat - Maya Chen.zip")]);
  check("zip: one chat file", fromZip.files.length === 1 && fromZip.ignored.length === 0, JSON.stringify(fromZip));
  check("zip: the .txt text", fromZip.files[0].text === WA_IOS);
  check("zip: named after the zip", fromZip.files[0].fileName === "WhatsApp Chat - Maya Chen.zip");
  check("zip: source detected", fromZip.files[0].source === "whatsapp");
  check("zip: the spy saw the .txt read (not vacuous)", reads.includes("_chat.txt"), JSON.stringify(reads));
  check("zip: the jpg was never read", !reads.some((n) => /\.jpg$/i.test(n)), JSON.stringify(reads));

  // A zip with a macOS resource fork twin and a second .txt: `_chat.txt` wins.
  const twin = new JSZip();
  twin.file("__MACOSX/._chat.txt", "binary junk");
  twin.file("notes.txt", PROSE);
  twin.file("_chat.txt", WA_ANDROID);
  const twinRes = await readChatFiles([
    new File([await twin.generateAsync({ type: "arraybuffer" })], "WhatsApp Chat - Diego.zip"),
  ]);
  check("zip: prefers _chat.txt", twinRes.files.length === 1 && twinRes.files[0].text === WA_ANDROID);

  const mixed = await readChatFiles([
    new File([IMESSAGE], "+14155550134.txt", { type: "text/plain" }),
    new File([CSV], "Connections.csv", { type: "text/csv" }),
    new File([PROSE], "notes.txt", { type: "text/plain" }),
    new File([await new JSZip().file("a.jpg", "x").generateAsync({ type: "arraybuffer" })], "photos.zip"),
  ]);
  check("txt: imessage read", mixed.files.length === 1 && mixed.files[0].source === "imessage" && mixed.files[0].text === IMESSAGE);
  check(
    "rejected files are listed as ignored",
    mixed.ignored.join("|") === "Connections.csv|notes.txt|photos.zip",
    JSON.stringify(mixed.ignored),
  );

  zipObjectProto.async = realAsync;
  zipObjectProto.nodeStream = realNodeStream;
  console.log("smoke-chat-read-files: all ok");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
