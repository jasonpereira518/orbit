/**
 * Reading a dropped folder, and the previews the sorter shows for what comes out.
 *
 * THE BUG THIS EXISTS FOR: `FileSystemDirectoryReader.readEntries` returns a BATCH, not the
 * directory. Chrome caps it at 100 entries and signals the end with an empty array, so code
 * that calls it once and uses the result turns a folder of 140 meeting notes into 100 — and
 * the missing 40 are indistinguishable from meetings that never happened.
 *
 * Reproducing that with real files needs a 100-file fixture folder and a browser. The walk
 * takes structural entry objects instead, so it is reachable here with plain data.
 *
 * Run: npx tsx scripts/smoke-capture-file-drop.ts
 */
import {
  MAX_DROP_DEPTH,
  MAX_DROP_FILES,
  isIgnorableFile,
  pathFromRelative,
  readDroppedEntries,
  type DropEntry,
} from "../src/lib/capture/file-drop";
import { looksTextual, snippetFromText } from "../src/lib/capture/file-preview";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** A file entry whose `file()` hands back something File-shaped. */
function fileEntry(name: string): DropEntry {
  return {
    isFile: true,
    isDirectory: false,
    name,
    file: (ok) => ok({ name, size: 10, lastModified: 0 } as unknown as File),
  };
}

/** A file the browser refuses to hand over — a permissions error, or a vanished file. */
function brokenEntry(name: string): DropEntry {
  return {
    isFile: true,
    isDirectory: false,
    name,
    file: (_ok, fail) => fail?.(new Error("nope")),
  };
}

/**
 * A directory that hands out its children in batches of `batchSize` and then an empty array,
 * exactly as the real reader does.
 */
function dirEntry(name: string, children: DropEntry[], batchSize = 100): DropEntry {
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => {
      let cursor = 0;
      return {
        readEntries: (ok) => {
          const batch = children.slice(cursor, cursor + batchSize);
          cursor += batch.length;
          ok(batch);
        },
      };
    },
  };
}

/** The same, but counting how many times the reader was asked. */
function countingDir(name: string, children: DropEntry[], batchSize: number) {
  const calls = { n: 0 };
  const entry = dirEntry(name, children, batchSize);
  const inner = entry.createReader!;
  entry.createReader = () => {
    const reader = inner();
    return {
      readEntries: (ok, fail) => {
        calls.n += 1;
        reader.readEntries(ok, fail);
      },
    };
  };
  return { entry, calls };
}

async function main() {
  console.log("\na folder is read whole, not one batch of it");
  {
    // Asked directly, because the file cap sits below a real 100-entry batch: what matters
    // is that the reader is drained until it returns empty, not how many files came back.
    const twenty = Array.from({ length: 20 }, (_, i) => fileEntry(`n${i}.md`));
    const counted = countingDir("notes", twenty, 5);
    const drained = await readDroppedEntries([counted.entry]);
    check("the reader is drained, not called once", counted.calls.n > 1, `${counted.calls.n} call(s)`);
    check("  so every file comes back", drained.files.length === 20, String(drained.files.length));
    // The empty batch IS the end-of-directory signal, and it costs one extra call.
    check("  ending on the empty batch", counted.calls.n === 5, `${counted.calls.n} call(s)`);

    const children = Array.from({ length: 140 }, (_, i) => fileEntry(`n${i}.md`));
    const out = await readDroppedEntries([dirEntry("notes", children)]);
    check(`a folder past the cap stops at ${MAX_DROP_FILES}`, out.files.length === MAX_DROP_FILES, String(out.files.length));
    check("  and it says it stopped early", out.truncated);
  }
  {
    const children = Array.from({ length: 12 }, (_, i) => fileEntry(`n${i}.md`));
    const out = await readDroppedEntries([dirEntry("notes", children, 5)]);
    check("a small folder read in batches of 5 comes back whole", out.files.length === 12, String(out.files.length));
    check("  and is not reported as truncated", !out.truncated);
  }

  console.log("\nnested folders");
  {
    const inner = dirEntry("q1", [fileEntry("jan.md"), fileEntry("feb.md")]);
    const outer = dirEntry("notes", [fileEntry("readme.md"), inner]);
    const out = await readDroppedEntries([outer]);
    check("files come out of subfolders too", out.files.length === 3, String(out.files.length));
    // The path is what tells two files called notes.md apart in the tray.
    const jan = out.files.find((f) => f.file.name === "jan.md");
    check("  carrying the folder they came from", jan?.path === "notes/q1", jan?.path ?? "none");
    const readme = out.files.find((f) => f.file.name === "readme.md");
    check("  and the top level is just the folder", readme?.path === "notes", readme?.path ?? "none");
  }
  {
    // A deep tree is somebody's home directory, not a folder of notes.
    let deep: DropEntry = fileEntry("buried.md");
    for (let i = 0; i < MAX_DROP_DEPTH + 3; i++) deep = dirEntry(`d${i}`, [deep]);
    const out = await readDroppedEntries([deep]);
    check("a tree deeper than the cap stops rather than recursing forever", out.files.length === 0, String(out.files.length));
  }

  console.log("\nnoise nobody meant to upload");
  {
    const out = await readDroppedEntries([
      dirEntry("notes", [fileEntry(".DS_Store"), fileEntry("Thumbs.db"), fileEntry("real.md")]),
    ]);
    check("platform droppings are skipped", out.files.length === 1 && out.files[0]!.file.name === "real.md", JSON.stringify(out.files.map((f) => f.file.name)));
    check("  dotfiles as a class", isIgnorableFile(".git") && isIgnorableFile(".env"));
    check("  but a real file is kept", !isIgnorableFile("notes.md"));
  }

  console.log("\none unreadable file is not a failed drop");
  {
    const out = await readDroppedEntries([
      dirEntry("notes", [fileEntry("a.md"), brokenEntry("locked.md"), fileEntry("b.md")]),
    ]);
    check("the rest still come through", out.files.length === 2, String(out.files.length));
  }

  console.log("\nthe fallback path");
  {
    // Some engines hand over no entries at all. `DataTransfer.files` is then all there is —
    // it cannot see inside a folder, but it is better than reading nothing.
    const plain = [{ name: "a.md" }, { name: ".DS_Store" }] as unknown as File[];
    const out = await readDroppedEntries([], plain);
    check("plain files are used when there are no entries", out.files.length === 1, String(out.files.length));
    check("  with the same noise filter", out.files[0]!.file.name === "a.md");
  }
  {
    // And the fallback must NOT fire when entries were present and simply yielded nothing,
    // or a dropped empty folder would re-add itself as a zero-byte "file".
    const empty = dirEntry("empty", []);
    const folderAsFile = [{ name: "empty" }] as unknown as File[];
    const out = await readDroppedEntries([empty], folderAsFile);
    check("an empty folder does not fall back to itself", out.files.length === 0, JSON.stringify(out.files.map((f) => f.file.name)));
  }

  console.log("\nthe folder picker's paths");
  {
    check("a nested pick keeps its folder", pathFromRelative("notes/q1/jan.md", "jan.md") === "notes/q1");
    check("a top-level pick has no folder", pathFromRelative("jan.md", "jan.md") === "");
    check("no relative path at all is fine", pathFromRelative(undefined, "jan.md") === "");
  }

  console.log("\nwhat a tile shows before anything is uploaded");
  {
    check("markdown is textual", looksTextual({ name: "notes.md", type: "" }));
    check("a calendar invite is too", looksTextual({ name: "invite.ics", type: "" }));
    check("a photo is not", !looksTextual({ name: "board.jpg", type: "image/jpeg" }));

    // Without this every .ics previews as "BEGIN:VCALENDAR" — the same non-answer for every
    // file of that kind, which is worse than no preview because it looks like it worked.
    const ics = "BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nSUMMARY:Infra sync with Ada\nEND:VEVENT";
    check("an invite previews as its summary", snippetFromText("invite.ics", ics) === "Infra sync with Ada", snippetFromText("invite.ics", ics));

    const eml = "Delivered-To: me@example.com\nFrom: ada@example.com\nSubject: Re: the migration\n\nBody here.";
    check("an email previews as its subject", snippetFromText("thread.eml", eml) === "Re: the migration", snippetFromText("thread.eml", eml));

    const md = "# Standup\n\nTalked to Ada about the cutover.";
    check("markdown previews as its heading, unhashed", snippetFromText("standup.md", md) === "Standup", snippetFromText("standup.md", md));

    const ruled = "---\n\nActually the first line.";
    check("a horizontal rule is not a first line", snippetFromText("n.md", ruled) === "Actually the first line.", snippetFromText("n.md", ruled));
    check("an empty file previews as nothing", snippetFromText("n.md", "\n\n  \n") === "");
  }

  console.log(failures === 0 ? "\nAll capture file-drop checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
