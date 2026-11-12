import "../../scripts/smoke/_env";

import { after, before, describe, it, mock } from "node:test";
import { prepareChatContext } from "@/lib/chat-context";
import { expectGolden, freezeClock } from "@/test-support/golden";
import { GOLDEN_USER, seedNetwork } from "@/test-support/fixtures";

/**
 * Characterizes the retrieval / context-assembly half of chat. No model is ever called:
 * `_env` strips every provider key, so the AI gate resolves to "no key" and the query parser,
 * reranker and embedder take their keyword-only fallbacks (the same ground
 * `scripts/smoke-chat-context.ts` stands on). What is pinned is the deterministic structure:
 * routing, retrieved ids/relevance, org rosters, snippets/timelines, allow-lists, the scoped
 * question and the model-facing contact rows. Prose a model would write is out of scope.
 *
 * KNOWN QUIRK (audit B4): `prepareChatContext` calls the server action
 * `loadRecruitersForChat`, which starts with `requireUserId()` and so needs ambient Clerk auth
 * (or demo mode). It is reached only when the router sets `route.recruiters`, which these three
 * questions do not, so the tests run with no auth and never touch it. A recruiter-shaped
 * question WOULD throw here ("Authentication is required"); P6.1 moves the loader into lib
 * taking `userId`, after which this golden must stay unchanged and a recruiter case can be added.
 */
describe("prepareChatContext (golden)", () => {
  before(async () => {
    await seedNetwork();
    freezeClock();
  });
  after(() => mock.timers.reset());

  const cases: Array<[string, string]> = [
    ["company", "Who do I know at Acme?"],
    ["person", "What did Ada Lovelace and I last talk about?"],
    ["generic", "How is my network doing overall?"],
  ];

  for (const [name, question] of cases) {
    it(`pins the ${name} question`, async () => {
      const ctx = await prepareChatContext(GOLDEN_USER, question, {});
      expectGolden(import.meta.url, `chat-context-${name}`, ctx);
    });
  }
});
