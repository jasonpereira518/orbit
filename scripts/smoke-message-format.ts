/**
 * Pins the house message format (`src/lib/message-format.ts`): the hard bans the code enforces
 * (dashes, exclamation marks, hype words, length limits), the one-retry rule, and the live
 * chat stream scrubber that keeps dashes out of a draft block while it streams.
 *
 * Pure: no DB, no provider. Run: npx tsx scripts/smoke-message-format.ts
 */
import {
  LINKEDIN_NOTE_MAX,
  createDraftStreamScrubber,
  draftWithFormat,
  formatRules,
  fullNameSignOff,
  hypeHits,
  retryNote,
  scrubDraft,
  scrubPunctuation,
} from "../src/lib/message-format";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}
function eq(label: string, got: string, want: string) {
  check(label, got === want, `got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
}

async function main() {
  console.log("punctuation");
  eq("an aside dash becomes a comma", scrubPunctuation("Orbit — a networking tool — helps."), "Orbit, a networking tool, helps.");
  eq("an unspaced em dash too", scrubPunctuation("I build Orbit—a CRM."), "I build Orbit, a CRM.");
  eq("an en dash between words too", scrubPunctuation("next week – Tuesday works"), "next week, Tuesday works");
  eq("a digit range keeps a hyphen", scrubPunctuation("9–5, pages 10 — 12"), "9-5, pages 10-12");
  eq("a dash opening a line is dropped", scrubPunctuation("Thanks,\n— Jason"), "Thanks,\nJason");
  eq("a dash ending a line becomes a period", scrubPunctuation("One more thing —\nNext"), "One more thing.\nNext");
  eq("dash before punctuation leaves no stray comma", scrubPunctuation("It works — ."), "It works.");
  eq("exclamation marks become periods", scrubPunctuation("Great to meet you! Talk soon!!"), "Great to meet you. Talk soon.");
  eq("?! becomes ?", scrubPunctuation("Really?!"), "Really?");
  eq("an ellipsis survives", scrubPunctuation("Well... sure"), "Well... sure");
  eq("clean text is untouched", scrubPunctuation("Hi Priya,\n\nWould Tuesday work?\n\nBest,\nJason Pereira"), "Hi Priya,\n\nWould Tuesday work?\n\nBest,\nJason Pereira");

  console.log("hype");
  check("hype words are found once each, lowercased", JSON.stringify(hypeHits("An AMAZING talk, amazing really. Huge fan.")) === JSON.stringify(["amazing", "huge fan"]));
  check("word boundaries: 'passionately' is not 'passionate'", hypeHits("I passionately disagree").length === 0);
  check("a hyphenated phrase matches", hypeHits("a real game-changer").includes("game-changer"));

  console.log("limits");
  const note = "a".repeat(LINKEDIN_NOTE_MAX);
  check("the LinkedIn note limit is the free-account 200", LINKEDIN_NOTE_MAX === 200);
  check("exactly 200 is within", scrubDraft(note, "linkedin_note").over === 0);
  check("201 is over by one", scrubDraft(`${note}a`, "linkedin_note").over === 1);
  check("an email has no hard cap", scrubDraft("x".repeat(5000), "email_cold").over === 0);
  check("emoji count as one character", scrubDraft("👋".repeat(200), "linkedin_note").over === 0);

  console.log("retry");
  check("a clean draft needs no retry", retryNote(scrubDraft("Hi Priya, open to a chat?", "linkedin_note"), "linkedin_note") === null);
  const note2 = retryNote(scrubDraft(`Amazing work. ${note}`, "linkedin_note"), "linkedin_note") ?? "";
  check("the retry note names the hype and the overrun", /amazing/.test(note2) && /over the 200-character limit/.test(note2), note2);

  const calls: Array<string | null> = [];
  const passed = await draftWithFormat("email_cold", async (retry) => {
    calls.push(retry);
    return { subject: "Your talk — at Collision!", body: "Hi Priya,\n\nGreat talk — really!" };
  });
  check("a draft with only punctuation to fix is not retried", calls.length === 1);
  eq("its body is scrubbed", passed.body, "Hi Priya,\n\nGreat talk, really.");
  eq("its subject is scrubbed, no trailing period", passed.subject ?? "", "Your talk, at Collision");

  check("an email claiming an attachment needs a retry", /attached/.test(retryNote(scrubDraft("Hi Grace, I've attached my resume.", "email_warm"), "email_warm") ?? ""));
  check("a DM may say attached (no files there either way, but no retry)", retryNote(scrubDraft("Attached is nothing.", "linkedin_dm"), "linkedin_dm") === null);
  check("'detached' is not a claim", !scrubDraft("Hi, a detached house.", "email_warm").attachment);

  const calls2: Array<string | null> = [];
  const retried = await draftWithFormat("email_warm", async (retry) => {
    calls2.push(retry);
    return { body: retry ? "Hi Sam, good seeing you." : "Hi Sam, that was an amazing talk!" };
  });
  check("a hype word buys exactly one retry", calls2.length === 2 && calls2[0] === null && /amazing/.test(calls2[1] ?? ""));
  eq("the retry's draft is kept", retried.body, "Hi Sam, good seeing you.");

  const calls3: number[] = [];
  const stubborn = await draftWithFormat("email_warm", async () => {
    calls3.push(1);
    return { body: "So amazing!" };
  });
  check("never more than one retry", calls3.length === 2);
  eq("the second draft is kept, scrubbed", stubborn.body, "So amazing.");

  eq("a bare first-name sign-off becomes the full name", fullNameSignOff("Hi Priya,\n\nThanks,\nJason", "Jason Pereira"), "Hi Priya,\n\nThanks,\nJason Pereira");
  eq("a full name is left alone", fullNameSignOff("Thanks,\nJason Pereira", "Jason Pereira"), "Thanks,\nJason Pereira");
  eq("a body that ends on a sentence is left alone", fullNameSignOff("See you, Jason", "Jason Pereira"), "See you, Jason");
  const named = await draftWithFormat("email_warm", async () => ({ body: "Hi Sam,\n\nGood seeing you.\n\nBest,\nJason" }), { senderFullName: "Jason Pereira" });
  check("draftWithFormat applies it to emails", named.body.endsWith("Best,\nJason Pereira"));
  const dm = await draftWithFormat("linkedin_dm", async () => ({ body: "Good seeing you.\nJason" }), { senderFullName: "Jason Pereira" });
  check("but not to a DM", dm.body.endsWith("\nJason"));

  console.log("rules");
  const cold = formatRules("email_cold", { senderFullName: "Jason Pereira" });
  check("cold email asks for who-I-am first", /First sentence: who the sender is/.test(cold));
  check("cold email signs off with the full name", cold.includes('then "Jason Pereira" on the next line'));
  check("no name means no sign-off", formatRules("email_warm").includes("no sign-off, no signature"));
  check("warm email has a subject", formatRules("email_warm").includes("Subject: 3 to 7 words"));
  check("the last follow-up offers an easy out", formatRules("email_followup", { lastStep: true }).includes("easy out"));
  check("every kind carries the hard bans", (["email_cold", "email_warm", "email_followup", "linkedin_note", "linkedin_dm", "sms"] as const).every((k) => formatRules(k).includes("Never use em dashes")));
  check("the note rule states the 200 limit", formatRules("linkedin_note").includes("at most 200 characters"));

  console.log("live stream");
  const run = (chunks: string[]) => {
    const s = createDraftStreamScrubber();
    return chunks.map((c) => s.push(c)).join("") + s.flush();
  };
  const answer =
    "I wrote a note — short one.\n```draft linkedin to=x\nHi Priya — I'm Jason! Open to chat?\n```\nAnd an email:\n```draft email\nSubject: Your talk — Collision\n\nHi Priya,\nGreat — truly!\n```\nDone — bye!";
  const want =
    "I wrote a note — short one.\n```draft linkedin to=x\nHi Priya, I'm Jason. Open to chat?\n```\nAnd an email:\n```draft email\nSubject: Your talk, Collision\n\nHi Priya,\nGreat, truly.\n```\nDone — bye!";
  eq("whole answer at once: only draft blocks are scrubbed", run([answer]), want);
  eq("one character at a time gives the same text", run([...answer]), want);
  const odd = run(["I wrote a no", "te — short one.\n``", "`draft linkedin to=x\nHi Priya —", " I'm Jason", "! Open to chat?\n``", "`\nAnd an email:\n```draft email\nSubject: Your talk — Collision\n\nHi Priya,\nGreat — truly!\n```\nDone — bye!"]);
  eq("split mid-dash and mid-fence too", odd, want);
  const s = createDraftStreamScrubber();
  check("prose streams before its line ends", s.push("Here is ") === "Here is ");
  check("a line that may be a fence is held", s.push("\n``") === "\n");
  const other = run(["```ts\nconst a = 1 — 2!\n```\n"]);
  eq("a code fence that is not a draft is untouched", other, "```ts\nconst a = 1 — 2!\n```\n");
  eq("an unclosed draft (cut-off answer) is still scrubbed", run(["```draft email\nHi — there!"]), "```draft email\nHi, there.");

  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll message format checks passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
