/**
 * Whether a question is one the attention brief is for.
 *
 * A leaf on purpose. This predicate is shared by the retrieval path — which decides whether
 * to load the brief — and by the composer's suggestion rules, which use it in reverse, to
 * drop any generated question that would trip it. The composer is a client component, and
 * its sibling in `chat-attention.ts` imports `@/db`, so keeping the two together meant a
 * client bundle reaching `node:fs`: the build fails with a chunking error that names
 * neither file (see `orbit-client-bundle-db-import`). Nothing here may import anything that
 * reaches the database.
 */

/**
 * Questions this brief is for. Deliberately narrow: attaching an attention queue to
 * "who do I know at Google?" would push the model toward answering a question nobody
 * asked. Substring matching on purpose — "follow up", "followed up", "follow-ups" all hit.
 */
export const ATTENTION_PATTERNS = [
  "reconnect",
  "reach out",
  "follow up",
  "follow-up",
  "followup",
  "followed up",
  "catch up",
  "check in",
  "overdue",
  "gone quiet",
  "quiet",
  "dormant",
  "neglect",
  "lost touch",
  "haven't spoken",
  "havent spoken",
  "haven't talked",
  "not talked",
  "who should i",
  "need attention",
  "this week",
  "cold",
];

export function isAttentionQuestion(question: string) {
  const q = question.toLowerCase();
  return ATTENTION_PATTERNS.some((p) => q.includes(p));
}
