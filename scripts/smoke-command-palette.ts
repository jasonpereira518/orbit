/**
 * The command palette's matching rules: what a query finds, in what order, what an
 * operator's hidden surfaces take away, and when typed text counts as a question.
 *
 * Pure — no database, no DOM. The palette component is a thin renderer over these.
 *
 * Run: npx tsx scripts/smoke-command-palette.ts
 */
import {
  emailVerbTerm,
  isComingSoonEntry,
  looksLikeNote,
  looksLikeQuestion,
  rankEntries,
  scoreEntry,
  visibleEntries,
  type PaletteEntry,
} from "../src/lib/command-palette";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const ENTRIES: PaletteEntry[] = [
  { id: "capture", label: "New capture", href: "/capture", keywords: "log interaction notes photo upload" },
  { id: "voice", label: "Record a voice note", href: "/capture?mode=voice", keywords: "dictate audio" },
  { id: "contact", label: "Add a contact", href: "/contacts/new", keywords: "new person create" },
  { id: "reminders", label: "Reminders", href: "/reminders" },
  { id: "recruiters", label: "Recruiters", href: "/recruiters" },
  { id: "chat", label: "Chat", href: "/chat" },
  { id: "settings-ai", label: "Settings › AI provider", href: "/settings#settings-ai", settingsId: "settings-ai" },
  { id: "theme", label: "Switch to dark mode", keywords: "theme appearance" },
];

const ids = (list: PaletteEntry[]) => list.map((e) => e.id).join(",");

console.log("Ranking");
check("an empty query keeps everything, in order", ids(rankEntries(ENTRIES, "  ")) === ids(ENTRIES));
check("a label prefix wins", rankEntries(ENTRIES, "rem")[0]?.id === "reminders", ids(rankEntries(ENTRIES, "rem")));
check("a word inside a label still matches", rankEntries(ENTRIES, "voice")[0]?.id === "voice");
check("keywords find entries the label does not name", rankEntries(ENTRIES, "dictate")[0]?.id === "voice");
check("case and accents do not matter", rankEntries(ENTRIES, "RÉCRUIT")[0]?.id === "recruiters");
check(
  "every word must match — a stray word empties the list rather than widening it",
  rankEntries(ENTRIES, "new zebra").length === 0
);
check("word order does not matter", rankEntries(ENTRIES, "contact add")[0]?.id === "contact");
check(
  "a label hit outranks a keyword hit",
  scoreEntry("new", ENTRIES[0]!) > scoreEntry("new", ENTRIES[2]!),
  `${scoreEntry("new", ENTRIES[0]!)} vs ${scoreEntry("new", ENTRIES[2]!)}`
);
// Three labels start with "re"; they tie, so they come back in the order they were declared.
check("ties keep declared order", ids(rankEntries(ENTRIES, "re")).startsWith("voice,reminders,recruiters"), ids(rankEntries(ENTRIES, "re")));
check("settings are findable by section name", rankEntries(ENTRIES, "ai prov")[0]?.id === "settings-ai");

console.log("\nHidden surfaces");
const noCapture = visibleEntries(ENTRIES, new Set(["page.capture"]));
check("hiding Capture removes every entry that lands there, query string or not", !noCapture.some((e) => e.id === "capture" || e.id === "voice"));
check("  and nothing else", noCapture.length === ENTRIES.length - 2);
check("hiding Contacts takes a nested route with it", !visibleEntries(ENTRIES, new Set(["page.contacts"])).some((e) => e.id === "contact"));
check("hiding Contacts leaves Recruiters, which has its own switch", visibleEntries(ENTRIES, new Set(["page.contacts"])).some((e) => e.id === "recruiters"));
check("a hidden settings section drops its anchor", !visibleEntries(ENTRIES, new Set(["settings.ai"])).some((e) => e.id === "settings-ai"));
check("an entry that goes nowhere is never hidden", visibleEntries(ENTRIES, new Set(["page.capture", "page.chat"])).some((e) => e.id === "theme"));

console.log("\nExplicit surface gating");
// An Integrations page is `/settings`, which says nothing about which account it is; a verb has
// no href at all. Both name the surface that hides them.
const GATED: PaletteEntry[] = [
  { id: "int-notion", label: "Integrations › Notion", href: "/settings?integration=notion", surface: "feature.notion" },
  { id: "int-google", label: "Integrations › Google", href: "/settings?integration=google", surface: "page.imports" },
  { id: "compose", label: "Write an email", surface: "feature.compose" },
  { id: "settings", label: "Settings", href: "/settings" },
];
const gated = (hidden: string[]) => ids(visibleEntries(GATED, new Set(hidden)));
check("a closed feature removes only the page that names it", gated(["feature.notion"]) === "int-google,compose,settings", gated(["feature.notion"]));
check("a hidden page takes the account pages that embed it", gated(["page.imports"]) === "int-notion,compose,settings", gated(["page.imports"]));
check("a verb with no href goes with its feature", gated(["feature.compose"]) === "int-notion,int-google,settings", gated(["feature.compose"]));
// Both checks apply: the named surface AND the page the entry lands on. The account pages live
// inside Settings, so hiding Settings takes them with it, and a verb has no page to lose.
check("hiding Settings takes the account pages that live inside it", gated(["page.settings"]) === "compose", gated(["page.settings"]));

console.log("\nComing soon");
const SOON = new Set(["page.radar", "page.outreach"]);
check("a page marked coming soon is flagged", isComingSoonEntry({ href: "/radar" }, SOON));
check("  and so is anything nested under it", isComingSoonEntry({ href: "/outreach/new" }, SOON));
check("  query string and hash do not hide it from the check", isComingSoonEntry({ href: "/radar?focus=x" }, SOON));
check("a live page is not", !isComingSoonEntry({ href: "/contacts" }, SOON));
check("a verb with no href is not", !isComingSoonEntry({}, SOON));
check("an empty set flags nothing", !isComingSoonEntry({ href: "/radar" }, new Set()));

console.log("\nQuestions");
for (const q of ["who do I know at Stripe", "Who works in AI?", "which recruiters have I talked to", "anyone at openai?"]) {
  check(`"${q}" reads as a question`, looksLikeQuestion(q));
}
for (const q of ["sarah", "reminders", "who", "is", "new capture", "how to"]) {
  check(`"${q}" does not`, !looksLikeQuestion(q));
}

console.log("\nNotes");
for (const q of [
  "met Sarah at AWS, she's moving to Stripe",
  "coffee with Priya tomorrow about the Notion role",
  "Marcus intro to Linear infra team",
]) {
  check(`"${q}" reads as a note to capture`, looksLikeNote(q));
}
for (const q of ["sarah", "new capture", "sarah stripe", "who do I know at Stripe?", "   "]) {
  check(`"${q}" does not`, !looksLikeNote(q));
}

// "email <name>": the one typed verb. People rows become "Email <name>" and open Compose.
check("'email maya' is the email verb for maya", emailVerbTerm("email maya") === "maya");
check("'Mail  Sam Ortiz' too, trimmed", emailVerbTerm("Mail  Sam Ortiz") === "Sam Ortiz");
check("'e-mail ben' too", emailVerbTerm("e-mail ben") === "ben");
check("'email' alone has no name yet", emailVerbTerm("email") === null && emailVerbTerm("email ") === null);
check("'emailing notes' is not the verb", emailVerbTerm("emailing notes") === null);
check("an ordinary search is not the verb", emailVerbTerm("maya") === null);

console.log("\nsmoke-command-palette: all checks passed");
