/**
 * The capture parse's per-person details are matched back to the people they describe by NAME.
 * A reply that reorders or drops someone must not put one person's fields on another, and a
 * person it skipped is asked about once more. Local PGlite, stubbed Gemini.
 * Run: npx tsx scripts/smoke-capture-detail-match.ts
 */
import "./smoke/_env";
process.env.ORBIT_AI_RESULT_CACHE = "off";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { userSettings } from "../src/db/schema";
import { encrypt } from "../src/lib/crypto";
import { matchDetailResults, parseMultiPersonNotesWithAI } from "../src/lib/ai";

const USER = "smoke-capture-detail-match-user";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok  ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/* ---- the matcher ---- */
const names = (...n: string[]) => n.map((name) => ({ name }));
check("exact names match whatever the order", JSON.stringify(matchDetailResults(["A B", "C D"], names("C D", "A B"))) === "[1,0]");
check("a missing person is null, and nobody takes their place", JSON.stringify(matchDetailResults(["A B", "C D", "E F"], names("E F", "A B"))) === "[1,null,0]");
check("a reply that dropped a middle name still matches", JSON.stringify(matchDetailResults(["Ana Maria Ruiz"], names("Ana Ruiz"))) === "[0]");
check("a one-word request matches the one reply starting with it", JSON.stringify(matchDetailResults(["Priya"], names("Priya Raman"))) === "[0]");
check("…but not when two replies could be them", JSON.stringify(matchDetailResults(["Priya"], names("Priya Raman", "Priya Shah"))) === "[null]");
check("one reply answers at most one request", JSON.stringify(matchDetailResults(["Sam Lee", "Sam Lee"], names("Sam Lee"))) === "[0,null]");
check("a different person with the same first name is not a match", JSON.stringify(matchDetailResults(["Sam Lee"], names("Sam Fox"))) === "[null]");

/* ---- the parse, against a stub that gets it wrong ---- */
const PEOPLE = ["Alice Ng", "Bob Ray", "Cara Lee", "Dan Fox", "Eve Poe"];
const COMPANY: Record<string, string> = { "Alice Ng": "A-Co", "Bob Ray": "B-Co", "Cara Lee": "C-Co", "Dan Fox": "D-Co", "Eve Poe": "E-Co" };
let detailCalls: string[][] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!/generativelanguage/.test(url)) return realFetch(input, init);
  const raw = init?.body ?? (input instanceof Request ? await input.clone().text() : null);
  const body = (typeof raw === "string" ? JSON.parse(raw) : {}) as {
    systemInstruction?: { parts?: Array<{ text?: string }> };
    contents?: Array<{ parts?: Array<{ text?: string }> }>;
  };
  const system = (body.systemInstruction?.parts ?? []).map((p) => p.text ?? "").join("");
  const user = (body.contents ?? []).flatMap((c) => (c.parts ?? []).map((p) => p.text ?? "")).join("");
  let reply: unknown = {};
  if (/identify every distinct person/.test(system)) {
    reply = { shared_notes: [], interaction_date: null, people: PEOPLE.map((name) => ({ name, presence: "participant" })), mentions: [] };
  } else if (/structured contact fields for a batch/.test(system)) {
    const asked = PEOPLE.filter((n) => new RegExp(`\\d\\. ${n}`).test(user.split("EXTRACT FULL DETAILS")[1] ?? ""));
    detailCalls.push(asked);
    const entry = (name: string) => ({ name, company: COMPANY[name], source_excerpt: `${name} said hello` });
    if (asked.length === 4) {
      // The wrong answer: reversed, and Cara left out.
      reply = { people: asked.filter((n) => n !== "Cara Lee").reverse().map(entry) };
    } else {
      reply = { people: asked.map(entry) };
    }
  }
  return Response.json({
    candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify(reply) }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
  });
}) as typeof fetch;

async function main() {
  const db = await getDb();
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await db.insert(userSettings).values({ userId: USER, aiProvider: "gemini", aiModel: "gemini-3.8-flash", geminiApiKeyEncrypted: encrypt("fake-gemini") });

  const notes = PEOPLE.map((n) => `${n} came to the dinner and we talked about their company at length. `.repeat(8)).join("\n") + "x".repeat(2600);
  const out = await parseMultiPersonNotesWithAI(USER, notes);
  const companyOf = (name: string) => out.people.find((p) => p.name === name)?.company ?? null;

  console.log("\nA reply that reverses the people and skips one");
  check("everyone is in the result, in the order they were found", JSON.stringify(out.people.map((p) => p.name)) === JSON.stringify(PEOPLE), JSON.stringify(out.people.map((p) => p.name)));
  check("each person has their OWN company, not their neighbour's", PEOPLE.every((n) => companyOf(n) === COMPANY[n]), JSON.stringify(PEOPLE.map(companyOf)));
  check("the skipped person was asked about once more, on their own", detailCalls.some((c) => c.length === 1 && c[0] === "Cara Lee"), JSON.stringify(detailCalls));

  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  if (failures) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll capture detail-matching checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
