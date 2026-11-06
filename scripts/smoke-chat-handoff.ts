/**
 * Chat handoff — dropped chat files reach the Chat messages card.
 *
 * Two things went unchecked and a browser pass had to find them: the row id the hub opens
 * must be one its row map actually knows, and the handed-off files must survive until the
 * card (mounted only once its row is open) takes them.
 *
 * Pure tier. Run: npx tsx scripts/smoke-chat-handoff.ts
 */
import "./smoke/_env";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { clearChatHandoff, getChatHandoff, handOffChatFiles } from "../src/lib/imports/chat-handoff";

function check(label: string, ok: boolean, detail = "") {
  if (!ok) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const f = (name: string) => new File(["x"], name);
const snapshot = () => getChatHandoff().map((x) => x.name);

check("empty before any drop", snapshot().length === 0);
handOffChatFiles([f("a.txt")]);
check("files wait for the card to mount", snapshot().join() === "a.txt");
handOffChatFiles([f("b.zip")]);
check("a second drop before consumption adds to the first", snapshot().join() === "a.txt,b.zip");
const held = getChatHandoff();
check("the snapshot is referentially stable between changes", getChatHandoff() === held);
handOffChatFiles([]);
check("an empty handoff is a no-op", snapshot().length === 2);
clearChatHandoff();
check("clear empties it", snapshot().length === 0);
clearChatHandoff();
check("clearing twice is harmless", snapshot().length === 0);

// The id the hub passes to setOpen must be a row id the hub knows, and the card row it
// opens must exist behind `chatImports`.
const hub = readFileSync(join(__dirname, "../src/components/imports/import-hub.tsx"), "utf8");
const setOpenIds = [...hub.matchAll(/setOpen\("([^"]+)"\)/g)].map((m) => m[1]);
const rowUnion = hub.match(/type RowId =([\s\S]*?);/)?.[1] ?? "";
const anchorMap = hub.match(/ROW_FOR_ANCHOR[^=]*=\s*\{([\s\S]*?)\};/)?.[1] ?? "";
check("the hub opens the chats row", setOpenIds.includes("import-panel-chats"), setOpenIds.join());
for (const id of setOpenIds) {
  check(`setOpen("${id}") is a RowId`, rowUnion.includes(`"${id}"`));
}
check("the chats anchor maps to its own row", /"import-panel-chats":\s*"import-panel-chats"/.test(anchorMap));
check("the chats row renders with that id", /\{\.\.\.row\("import-panel-chats"\)\}/.test(hub));

console.log("chat handoff smoke tests passed");
process.exit(0);
