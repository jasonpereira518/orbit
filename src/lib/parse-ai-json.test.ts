import "../../scripts/smoke/_env";
/**
 * P5.4: `parseAiJson(schema, raw)` and the schemas of the sites that used to assert a shape
 * with `parseAiJson<T>(raw)`. What matters is the reply a model gets wrong: before, `null`, a
 * string or `{ "text": 5 }` was handed on as `T` and failed later at `.trim()` / `.map()`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import { parseAiJson } from "@/lib/ai";
import {
  chatAnswerJsonSchema,
  chatRefineReplySchema,
  chatTitleReplySchema,
  companyResearchSchema,
  currentRoleAnswerSchema,
  discoveryResearchSchema,
  excerptRetrySchema,
  personResearchSchema,
  recruiterDraftReplySchema,
  rerankReplySchema,
  transcriptJsonSchema,
  workHistoryAnswerSchema,
} from "@/lib/ai-reply-schemas";
import { toPersonDossier } from "@/lib/web-research";

const SUBJECT = { fullName: "Ada Lovelace", company: "Analytical Engines", domain: null, linkedinUrl: null };
const NOW = new Date("2026-10-22T00:00:00Z");

describe("parseAiJson overloads", () => {
  const schema = z.object({ n: z.number() });
  it("keeps the one-argument form", () => {
    assert.deepEqual(parseAiJson('{"a":1}'), { a: 1 });
  });
  it("parses through the same extraction (fences, prose, truncation)", () => {
    assert.deepEqual(parseAiJson(schema, '```json\n{"n": 2}\n```'), { n: 2 });
    assert.deepEqual(parseAiJson(schema, 'Sure! Here you go: {"n": 3} Hope that helps.'), { n: 3 });
    assert.deepEqual(parseAiJson(z.object({ list: z.array(z.number()) }), '{"list": [1, 2'), { list: [1, 2] });
  });
  it("throws one error naming the bad paths, never the values", () => {
    assert.throws(
      () => parseAiJson(schema, '{"n": "sk_live_do_not_echo"}'),
      (err: Error) => /did not match the expected shape: n$/.test(err.message) && !err.message.includes("sk_live"),
    );
    assert.throws(() => parseAiJson(schema, "null"), /did not match the expected shape: \(root\)/);
  });
  it("still throws the parse error for unparseable text", () => {
    assert.throws(() => parseAiJson(schema, "no json here"), /Failed to parse AI JSON/);
  });
});

describe("transcriptJsonSchema", () => {
  it("accepts a text, a null text and no text", () => {
    assert.equal(transcriptJsonSchema.parse({ text: " hi " }).text, " hi ");
    assert.equal(transcriptJsonSchema.parse({ text: null }).text, null);
    assert.equal(transcriptJsonSchema.parse({}).text, undefined);
  });
  it("rejects a non-object reply and a non-string text", () => {
    for (const bad of [null, "text", 5, [], { text: 5 }, { text: { a: 1 } }]) {
      assert.equal(transcriptJsonSchema.safeParse(bad).success, false, JSON.stringify(bad));
    }
  });
});

describe("excerptRetrySchema", () => {
  it("keeps good entries and skips the bad ones", () => {
    const out = excerptRetrySchema.parse({
      excerpts: [{ name: "Ada", source_excerpt: "met at the lab" }, null, "x", { name: 5 }, { name: "Grace" }],
    });
    assert.deepEqual(out.excerpts, [{ name: "Ada", source_excerpt: "met at the lab" }, { name: "Grace" }]);
  });
  it("allows no excerpts, rejects a non-array", () => {
    assert.equal(excerptRetrySchema.parse({}).excerpts, undefined);
    assert.equal(excerptRetrySchema.safeParse({ excerpts: "none" }).success, false);
  });
});

describe("chatAnswerJsonSchema", () => {
  const rec = {
    contact_id: null,
    recruiter_id: "r1",
    name: "Grace",
    reason: "knows the team",
    suggested_action: "email",
    draft_message: null,
  };
  it("passes a well-formed answer through", () => {
    const out = chatAnswerJsonSchema.parse({ answer: "Ask Grace.", recommendations: [rec], proposed_actions: [{ type: "x" }] });
    assert.equal(out.answer, "Ask Grace.");
    assert.deepEqual(out.recommendations, [rec]);
    assert.deepEqual(out.proposed_actions, [{ type: "x" }]);
  });
  it("turns absent or mistyped sections into empty ones instead of a later TypeError", () => {
    assert.deepEqual(chatAnswerJsonSchema.parse({}), { answer: "", recommendations: [], proposed_actions: [] });
    assert.deepEqual(chatAnswerJsonSchema.parse({ answer: 5, recommendations: "none", proposed_actions: {} }), {
      answer: "",
      recommendations: [],
      proposed_actions: [],
    });
  });
  it("drops a malformed recommendation and keeps the others", () => {
    const out = chatAnswerJsonSchema.parse({ answer: "a", recommendations: [rec, null, { name: "x" }, "y"] });
    assert.deepEqual(out.recommendations, [rec]);
  });
  it("rejects a reply that is not an object", () => {
    for (const bad of [null, "answer", 5, []]) {
      assert.equal(chatAnswerJsonSchema.safeParse(bad).success, false, JSON.stringify(bad));
    }
  });
});

describe("web-research toPersonDossier", () => {
  it("reads a confident answer", () => {
    const d = toPersonDossier(SUBJECT, '{"match":"confident","name":"Ada Lovelace","current":{"organization":"Analytical Engines","title":"Countess"}}', [], NOW);
    assert.equal(d.match, "confident");
    assert.equal(d.current?.organization, "Analytical Engines");
  });
  it("treats a mistyped current as no current", () => {
    const d = toPersonDossier(SUBJECT, '{"match":"confident","name":"Ada","current":5}', [], NOW);
    assert.equal(d.current, null);
  });
  it("names the problem when the model answers with something that is not an object", () => {
    for (const reply of ["null", '"unsure"', "[1,2]"]) {
      assert.throws(() => toPersonDossier(SUBJECT, reply, [], NOW), /did not match the expected shape/, reply);
    }
  });
});

describe("replies whose fields are checked where they are used", () => {
  // The outer shape only: every field is `unknown`/optional, so a reply that leaves one out must
  // still parse (zod 4 treats a bare z.unknown() object key as required), and a reply that is
  // not an object must not.
  const cases: Array<[string, z.ZodType, unknown[]]> = [
    ["chatTitleReplySchema", chatTitleReplySchema, [{}, { title: "T" }, { title: 5 }, null]],
    ["chatRefineReplySchema", chatRefineReplySchema, [{}, { draft: "D" }, { draft: ["x"] }, null]],
    ["recruiterDraftReplySchema", recruiterDraftReplySchema, [{}, { subject: "S", body: "B" }, { subject: 5, body: {} }]],
    ["rerankReplySchema", rerankReplySchema, [{}, { scores: [] }, { scores: [{ id: "a", relevance: 3 }, { id: 5 }, {}] }]],
    ["workHistoryAnswerSchema", workHistoryAnswerSchema, [{}, { match: "confident", headline: "h", experiences: [] }, { experiences: "x" }]],
    ["currentRoleAnswerSchema", currentRoleAnswerSchema, [{}, { match: "confident", current: null }, { current: { organization: "O" } }, { current: 5 }]],
    ["companyResearchSchema", companyResearchSchema, [{}, { match: "confident", news: [{}, null], people: "x" }]],
    ["discoveryResearchSchema", discoveryResearchSchema, [{}, { candidates: [] }, { candidates: "none" }]],
    ["personResearchSchema", personResearchSchema, [{}, { match: "none" }, { current: { title: "t" }, talkingPoints: "x" }]],
  ];
  for (const [name, schema, goods] of cases) {
    it(`${name} accepts partial and oddly typed fields`, () => {
      for (const good of goods) assert.equal(schema.safeParse(good).success, true, JSON.stringify(good));
    });
    it(`${name} rejects a reply that is not an object`, () => {
      for (const bad of ["text", 5, true, [], [{}]]) {
        assert.equal(schema.safeParse(bad).success, false, JSON.stringify(bad));
      }
    });
  }
  it("recruiter drafts read a mistyped field as missing", () => {
    assert.deepEqual(recruiterDraftReplySchema.parse({ subject: 5, body: "B" }), { subject: undefined, body: "B" });
  });
  it("a mistyped current is no current", () => {
    assert.equal(currentRoleAnswerSchema.parse({ current: 5 }).current, null);
    assert.equal(personResearchSchema.parse({ current: "x" }).current, null);
  });
});
