/**
 * Transcription vocabulary selection, and the shaping of a Wispr request. No DOM, no
 * network, no DB — `loadNetworkVocabulary` is the only DB-touching export and is not
 * exercised here; everything it depends on is.
 * Run: npx tsx scripts/smoke-wispr.ts
 */
import {
  MAX_VOCABULARY_TERMS,
  WHISPER_PROMPT_MAX_CHARS,
  collectVocabularyTerms,
  vocabularyToPromptLine,
  vocabularyToWhisperPrompt,
  type VocabularySource,
} from "../src/lib/transcription-vocabulary";
import {
  buildTranscribeBody,
  parseTranscribeResponse,
  type WisprContext,
} from "../src/lib/wispr";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

function contact(partial: Partial<VocabularySource>): VocabularySource {
  return {
    fullName: null,
    preferredName: null,
    company: null,
    school: null,
    ...partial,
  };
}

// ── collectVocabularyTerms ────────────────────────────────────────────────────────────
console.log("\ncollectVocabularyTerms");

check("no contacts is an empty list", collectVocabularyTerms([]).length === 0);

{
  const terms = collectVocabularyTerms([
    contact({ fullName: "Priya Raman", company: "Stripe", school: "IIT Bombay" }),
  ]);
  check("keeps the whole name", terms.includes("Priya Raman"));
  check("keeps the company", terms.includes("Stripe"));
  check("keeps the school", terms.includes("IIT Bombay"));
  // The reason the parts are added at all: people say first names on their own constantly,
  // and biasing toward "Priya Raman" as one string does not reliably fix "Priya" alone.
  check("also adds the first name on its own", terms.includes("Priya"));
  check("also adds the surname on its own", terms.includes("Raman"));
}

{
  const terms = collectVocabularyTerms([
    contact({ fullName: "Sarah Chen", preferredName: "Sarah" }),
    contact({ fullName: "Sarah Chen" }),
  ]);
  const lower = terms.map((t) => t.toLowerCase());
  check(
    "dedupes case-insensitively across rows and fields",
    new Set(lower).size === lower.length,
    terms.join("|"),
  );
}

{
  const terms = collectVocabularyTerms([contact({ fullName: "sarah chen" }), contact({ fullName: "Sarah Chen" })]);
  check("keeps the first spelling seen", terms[0] === "sarah chen", terms[0]);
}

{
  // Junk that really does land in these columns.
  const terms = collectVocabularyTerms([
    contact({ fullName: "  Marcus   Lee  ", company: "Acme Corp (2019)" }),
    contact({ fullName: "", company: "   ", school: "—" }),
    contact({ company: "sarah@acme.com" }),
    contact({ company: "a" }),
    contact({ fullName: "x".repeat(200) }),
  ]);
  check("collapses internal whitespace", terms.includes("Marcus Lee"), terms.join("|"));
  check("drops fields containing digits", !terms.some((t) => /\d/.test(t)), terms.join("|"));
  check("drops email addresses", !terms.some((t) => t.includes("@")));
  check("drops single characters", !terms.includes("a"));
  check("drops punctuation-only values", !terms.includes("—"));
  check("drops absurdly long values", !terms.some((t) => t.length > 100));
  check("drops empty and whitespace-only values", !terms.some((t) => t.trim() === ""));
}

{
  // Particles are ordinary words in several languages; biasing toward them would corrupt
  // normal speech, and the whole-name entry already covers them.
  const terms = collectVocabularyTerms([contact({ fullName: "Joris van der Berg" })]);
  check("keeps the whole name with its particles", terms.includes("Joris van der Berg"));
  check("does not add 'van' as a term", !terms.includes("van"));
  check("does not add 'der' as a term", !terms.includes("der"));
  check("still adds the real name parts", terms.includes("Joris") && terms.includes("Berg"));
}

check(
  "drops initials",
  !collectVocabularyTerms([contact({ fullName: "J. R. Hartley" })]).includes("J."),
);

check(
  "a single-word name adds no separate part",
  collectVocabularyTerms([contact({ fullName: "Cher" })]).filter((t) => t === "Cher").length === 1,
);

// ── Ordering and caps ─────────────────────────────────────────────────────────────────
console.log("\nordering and caps");

{
  // Load-bearing: every engine truncates, and rows arrive most-recently-seen first. If the
  // cap ever starts biting from the front, the people you actually just met are the ones
  // it drops.
  const rows = [
    contact({ fullName: "Recent Person", company: "RecentCo" }),
    contact({ fullName: "Older Person", company: "OlderCo" }),
  ];
  const terms = collectVocabularyTerms(rows, 2);
  check("respects the limit exactly", terms.length === 2, `${terms.length}`);
  check("keeps the most recent contact first", terms[0] === "Recent Person", terms.join("|"));
  // Both names survive and both companies are dropped, rather than one contact being
  // covered completely and the other not at all — see the whole-names-first block below.
  check("still covers the older contact's name", terms.includes("Older Person"), terms.join("|"));
  check("drops companies before it drops any name", !terms.includes("RecentCo"), terms.join("|"));
}

{
  const terms = collectVocabularyTerms(
    [contact({ fullName: "Recent Person" }), contact({ fullName: "Older Person" })],
    1,
  );
  check("under a cap of 1, the most recent contact is the one kept", terms.join("|") === "Recent Person", terms.join("|"));
}

{
  // Whole names for everyone beat every fragment of the first few — a truncated list
  // should still cover the whole network shallowly rather than one corner deeply.
  const rows = [
    contact({ fullName: "Ana Beatriz Silva" }),
    contact({ fullName: "Kenji Watanabe" }),
    contact({ fullName: "Fatima Al Rashid" }),
  ];
  const terms = collectVocabularyTerms(rows, 3);
  check(
    "fills whole names across all contacts before any name parts",
    terms.join("|") === "Ana Beatriz Silva|Kenji Watanabe|Fatima Al Rashid",
    terms.join("|"),
  );
}

{
  const many = Array.from({ length: 500 }, (_, i) =>
    contact({ fullName: `Person${String.fromCharCode(97 + (i % 26))} Surname${i}` }),
  );
  const terms = collectVocabularyTerms(many);
  check(`never exceeds ${MAX_VOCABULARY_TERMS} terms`, terms.length <= MAX_VOCABULARY_TERMS, `${terms.length}`);
  check("a limit of 0 yields nothing", collectVocabularyTerms(many, 0).length === 0);
}

// ── vocabularyToWhisperPrompt ─────────────────────────────────────────────────────────
console.log("\nvocabularyToWhisperPrompt");

check("no terms is an empty prompt", vocabularyToWhisperPrompt([]) === "");

{
  const prompt = vocabularyToWhisperPrompt(["Priya Raman", "Stripe"]);
  check("names the terms", prompt.includes("Priya Raman") && prompt.includes("Stripe"));
  check("reads as prose, not JSON", !prompt.includes("[") && !prompt.includes("{"));
  check("ends as a sentence", prompt.endsWith("."), prompt);
}

{
  // Whisper caps `prompt` at 224 tokens and truncates from the FRONT, which would drop the
  // most-recent contacts this list is ordered to put first. So the budget is enforced here.
  const many = Array.from({ length: 400 }, (_, i) => `Personname${i}`);
  const prompt = vocabularyToWhisperPrompt(many);
  // Exactly the cap, not the cap plus slack. The `+ 1` this once allowed was hiding a real
  // off-by-one: the terminating "." was appended after the loop had already filled the
  // budget, so the function overran the only limit it enforces.
  check(
    `stays inside the ${WHISPER_PROMPT_MAX_CHARS}-char budget`,
    prompt.length <= WHISPER_PROMPT_MAX_CHARS,
    `${prompt.length}`,
  );
  check("keeps the earliest (most recent) terms", prompt.includes("Personname0"));
  check("drops the tail", !prompt.includes("Personname399"));
  // Half a name is a worse prior than no name.
  check(
    "truncates on whole terms only",
    prompt
      .replace("People and companies mentioned: ", "")
      .replace(/\.$/, "")
      .split(", ")
      .every((t) => many.includes(t)),
    prompt,
  );
}

check(
  "a single term too long for the budget yields nothing rather than a fragment",
  vocabularyToWhisperPrompt(["x".repeat(40)], 20) === "",
);

{
  // Walk the cap across a range so an off-by-one cannot hide in one lucky value.
  const many = Array.from({ length: 200 }, (_, i) => `Personname${i}`);
  for (const cap of [40, 41, 42, 60, 100, 137, 200, 333, 550, 551]) {
    const out = vocabularyToWhisperPrompt(many, cap);
    check(`never exceeds a cap of ${cap}`, out.length <= cap, `${out.length}`);
    if (out) check(`…and still ends as a sentence at ${cap}`, out.endsWith("."), out.slice(-12));
  }
}

// ── vocabularyToPromptLine ────────────────────────────────────────────────────────────
console.log("\nvocabularyToPromptLine");

check("no terms is an empty line", vocabularyToPromptLine([]) === "");

{
  const line = vocabularyToPromptLine(["Priya Raman", "Stripe"]);
  check("lists the terms", line.includes("Priya Raman, Stripe"));
  // Without this the model cheerfully transcribes the word list itself into the note.
  check("tells the model not to invent them", line.includes("do not add them"));
}

// ── buildTranscribeBody ───────────────────────────────────────────────────────────────
console.log("\nbuildTranscribeBody");

const ctx: WisprContext = {
  dictionary_context: ["Priya Raman", "Stripe"],
  app: { name: "Orbit", type: "other" },
};

{
  const body = buildTranscribeBody({ audioBase64: "UklGRiQA", context: ctx });
  check("sends the audio under `audio`", body.audio === "UklGRiQA");
  const context = body.context as Record<string, unknown>;
  check("sends the dictionary", JSON.stringify(context.dictionary_context) === '["Priya Raman","Stripe"]');
  check("sends the app descriptor", JSON.stringify(context.app) === '{"name":"Orbit","type":"other"}');
  check("sends explicit empty textbox contents", JSON.stringify(context.textbox_contents) === '{"before_text":"","selected_text":"","after_text":""}');
  // Empty means autodetect; sending `language: []` would be a different request.
  check("omits `language` when no languages are given", !("language" in body));
  check("omits an absent user first name", !("user_first_name" in context));
}

{
  const body = buildTranscribeBody({
    audioBase64: "AAAA",
    languages: ["en"],
    context: { ...ctx, user_first_name: "Jason", user_last_name: "Pereira" },
  });
  check("forces a single language when one is given", JSON.stringify(body.language) === '["en"]');
  const context = body.context as Record<string, unknown>;
  check("passes the user's first name", context.user_first_name === "Jason");
  check("passes the user's last name", context.user_last_name === "Pereira");
}

check(
  "an empty dictionary is still a valid body",
  Array.isArray(
    (buildTranscribeBody({
      audioBase64: "AAAA",
      context: { ...ctx, dictionary_context: [] },
    }).context as Record<string, unknown>).dictionary_context,
  ),
);

check("the body is JSON-serialisable", typeof JSON.stringify(buildTranscribeBody({ audioBase64: "AAAA", context: ctx })) === "string");

// ── parseTranscribeResponse ───────────────────────────────────────────────────────────
console.log("\nparseTranscribeResponse");

check("reads the documented REST shape", parseTranscribeResponse({ text: "Met Priya." }) === "Met Priya.");
// The WebSocket surface nests under `body`; accepting both turns a schema surprise into a
// working transcript instead of a silent fallback.
check("also reads the nested socket shape", parseTranscribeResponse({ body: { text: "Met Priya." } }) === "Met Priya.");
check("trims surrounding whitespace", parseTranscribeResponse({ text: "  hello  " }) === "hello");

// An empty transcript is a successful call that heard nothing — the caller must try the
// next engine rather than save a blank note.
check("an empty transcript is null", parseTranscribeResponse({ text: "" }) === null);
check("a whitespace transcript is null", parseTranscribeResponse({ text: "   " }) === null);

for (const bad of [null, undefined, "", 0, [], { error: "nope" }, { text: 42 }, { body: {} }]) {
  check(`rejects ${JSON.stringify(bad) ?? "undefined"}`, parseTranscribeResponse(bad) === null);
}

console.log("\nsmoke-wispr: all checks passed");
