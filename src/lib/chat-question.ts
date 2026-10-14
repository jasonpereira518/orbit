/**
 * How long a chat question may be. Pure, so the composers can cap what is typed and the
 * route can refuse what arrives, from one number.
 */

export const CHAT_QUESTION_MAX_CHARS = 4000;

/** Counted in UTF-16 units, like the `maxLength` on the fields — the route refuses exactly what they cannot produce. */
export function isChatQuestionTooLong(question: string): boolean {
  return question.length > CHAT_QUESTION_MAX_CHARS;
}

export const CHAT_QUESTION_TOO_LONG_MESSAGE = `That question is too long — keep it to ${CHAT_QUESTION_MAX_CHARS.toLocaleString("en-US")} characters or fewer`;
