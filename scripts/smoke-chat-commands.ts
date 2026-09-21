/**
 * Pins the chat composer's slash commands (`src/lib/chat-commands.ts`): when a `/` is a command
 * and when it is just a character, how commands rank, that a hidden surface removes its command,
 * and that no v1 command does anything but prefill or navigate.
 *
 * Pure: no DOM. Run: npx tsx scripts/smoke-chat-commands.ts
 */
import { CHAT_COMMANDS, commandsFor, slashQueryAt } from "../src/lib/chat-commands";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const at = (text: string, caret = text.length) => slashQueryAt(text, caret);

console.log("trigger rules");
check("a bare slash opens", JSON.stringify(at("/")) === JSON.stringify({ start: 0, query: "" }));
check("word after it is the query", at("/dra")?.query === "dra");
check("start of a later line counts", JSON.stringify(at("hello\n/fol")) === JSON.stringify({ start: 6, query: "fol" }));
check("mid-sentence slash does not", at("and/or") === null);
check("after a space does not", at("what about /draft") === null);
check("a URL does not", at("see https://orbit.app/x") === null);
check("a date does not", at("1/2") === null);
check("a path closes on its second slash", at("/etc/hosts") === null);
check("a space ends the command", at("/draft ") === null);
check("caret in the middle reads up to the caret", at("/draft", 3)?.query === "dr");
check("caret before the slash is nothing", at("/draft", 0) === null);
check("caret past the end is nothing", at("/x", 9) === null);
check("a very long word stops being a command", at(`/${"a".repeat(40)}`) === null);
check("digits do not", at("/12") === null);

console.log("ranking");
const none = new Set<string>();
check("empty query lists every command in declared order", commandsFor("", none).map((c) => c.slug).join() === CHAT_COMMANDS.map((c) => c.slug).join());
check("prefix finds it", commandsFor("dra", none)[0]?.slug === "draft");
check("the slug with no space finds a two-word label", commandsFor("followup", none)[0]?.slug === "followup");
check("nonsense finds nothing", commandsFor("zzzz", none).length === 0);
check("a keyword finds it", commandsFor("recap", none)[0]?.slug === "summarize");

console.log("hidden surfaces");
const withoutReminders = commandsFor("", new Set(["page.reminders"]));
check("a hidden page removes its command", !withoutReminders.some((c) => c.slug === "remind"), withoutReminders.map((c) => c.slug).join());
check("and only that one", withoutReminders.length === CHAT_COMMANDS.length - 1);
check("hiding capture removes /log", !commandsFor("", new Set(["page.capture"])).some((c) => c.slug === "log"));
check("prefill commands are never hidden", commandsFor("", new Set(["page.reminders", "page.capture"])).filter((c) => c.prefill).length === CHAT_COMMANDS.filter((c) => c.prefill).length);

console.log("shape");
check("ids and slugs are unique", new Set(CHAT_COMMANDS.map((c) => c.id)).size === CHAT_COMMANDS.length && new Set(CHAT_COMMANDS.map((c) => c.slug)).size === CHAT_COMMANDS.length);
check("every command prefills or navigates, never both, never neither", CHAT_COMMANDS.every((c) => Boolean(c.prefill) !== Boolean(c.href)));
check("a mention prefill ends in the sigil so the menu can open", CHAT_COMMANDS.filter((c) => c.prefill?.mention).every((c) => c.prefill!.text.endsWith("@")));
check("prefills carry no control characters", CHAT_COMMANDS.every((c) => !c.prefill || [...c.prefill.text].every((ch) => ch.charCodeAt(0) >= 32)));

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll chat command checks passed");
process.exit(0);
