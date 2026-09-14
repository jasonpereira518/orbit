/**
 * Pull the first JSON object or array out of model text. `completeJson` already normalizes its
 * own output; this exists so pure modules can accept any `JsonCompleter` (including fakes and
 * other providers) without importing `ai.ts`.
 */
export function parseJsonObject(raw: string): unknown | null {
  const text = raw.replace(/```(?:json)?/gi, "").trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.search(/[[{]/);
    const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}
