/**
 * A conversation exported as Markdown (`@/lib/chat-export`).
 *
 * Pure: no network, no database. Run: npx tsx scripts/smoke-chat-export.ts
 */
import { chatAsMarkdown, chatExportFileName } from "../src/lib/chat-export";
import { directivesAsText } from "../src/lib/chat-directives";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : ` (${detail})`}`);
  if (!ok) failures++;
}

const answer = directivesAsText(
  "You know two people there [e1].\n\n::people[c1,c2]\n\nMaya is closest [e2][e3].",
  (id) => ({ c1: "Maya Chen", c2: "Raj Patel" })[id],
);
const md = chatAsMarkdown("  Stripe contacts ", [
  { role: "user", text: "Who do I know at Stripe?" },
  { role: "assistant", text: answer },
  { role: "assistant", text: "   " },
  { role: "user", text: "Draft an intro" },
]);

check("starts with the title as a heading", md.startsWith("# Stripe contacts\n\n"), md.slice(0, 40));
check("questions are marked as the person's", md.includes("**You:** Who do I know at Stripe?"));
check("answers are marked as Orbit's", md.includes("**Orbit:**\n\nYou know two people there."));
check("a people block reads as a list of names", md.includes("- Maya Chen\n- Raj Patel"), md);
check("source markers are dropped, with the space before them", !/\[e\d+\]/.test(md) && md.includes("Maya is closest."), md);
check("an empty turn (a stopped answer) is left out", md.split("\n\n---\n\n").length === 3, String(md.split("\n\n---\n\n").length));
check("an untitled chat still gets a heading", chatAsMarkdown("", []).startsWith("# Chat\n"));
check("file name is a slug of the title", chatExportFileName("Who can help: Stripe / Plaid?") === "who-can-help-stripe-plaid.md", chatExportFileName("Who can help: Stripe / Plaid?"));
check("an empty title still names a file", chatExportFileName("  ") === "chat.md");

console.log(failures === 0 ? "\nsmoke-chat-export: all checks passed" : `\nsmoke-chat-export: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
