/**
 * Notion's pure pieces (`src/lib/connectors/notion.ts`): the request's one 429 retry, pages
 * as capture text, and a people-database row as a `PersonRecord`. Fixtures copy Notion's
 * response shapes with made-up people.
 */
import {
  blockLine,
  blocksText,
  guessMapping,
  notionRequest,
  NotionApiError,
  NotionReauthError,
  pageTitle,
  rowToPerson,
  type NotionBlock,
} from "../src/lib/connectors/notion";
import { checker } from "./smoke/check";

const t = checker();
const rt = (text: string) => [{ plain_text: text }];
const block = (type: string, body: Record<string, unknown>, extra: Partial<NotionBlock> = {}): NotionBlock => ({
  id: `${type}-${Math.random().toString(16).slice(2)}`,
  type,
  [type]: body,
  ...extra,
});

async function main() {
  // ── notionRequest ──
  const calls: { headers: Record<string, string> }[] = [];
  const waits: number[] = [];
  const answers = [new Response("{}", { status: 429, headers: { "retry-after": "2" } }), new Response('{"ok":1}', { status: 200 })];
  const res = await notionRequest<{ ok: number }>(
    "tok",
    "/search",
    { method: "POST", body: {} },
    (async (_u: string, init: RequestInit) => {
      calls.push({ headers: init.headers as Record<string, string> });
      return answers.shift()!;
    }) as unknown as typeof fetch,
    async (ms) => void waits.push(ms)
  );
  t.check("a 429 is waited out once, then retried", res.ok === 1 && calls.length === 2 && waits[0] === 2000);
  t.check("every call names the API version", calls[0]?.headers["notion-version"] === "2026-03-11");
  await t.rejects(
    "a 401 means reconnect",
    () => notionRequest("tok", "/x", {}, (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch),
    (e) => e instanceof NotionReauthError
  );
  await t.rejects(
    "a second 429 is not waited out again",
    () =>
      notionRequest("tok", "/x", {}, (async () => new Response("{}", { status: 429 })) as unknown as typeof fetch, async () => {}),
    (e) => e instanceof NotionApiError && e.status === 429
  );

  // ── pages → text ──
  t.check("a database row's title column is its title", pageTitle({ properties: { Person: { type: "title", title: rt("Ana Ruiz") } } }) === "Ana Ruiz");
  t.check("no title reads as Untitled", pageTitle({ properties: {} }) === "Untitled");
  t.check("headings keep their level", blockLine(block("heading_2", { rich_text: rt("Next steps") })) === "## Next steps");
  t.check("to-dos keep their tick", blockLine(block("to_do", { rich_text: rt("Send deck"), checked: true })) === "- [x] Send deck");
  t.check("nested lines indent", blockLine(block("bulleted_list_item", { rich_text: rt("Intro to Sam") }), 1) === "  - Intro to Sam");
  t.check("an empty paragraph is no line", blockLine(block("paragraph", { rich_text: [] })) === null);
  t.check("an image is no line", blockLine(block("image", { caption: [] })) === null);

  const toggle = block("toggle", { rich_text: rt("Ana") }, { has_children: true });
  const child = block("child_page", { title: "Other doc" }, { has_children: true });
  const tree: Record<string, NotionBlock[][]> = {
    root: [[block("heading_1", { rich_text: rt("Coffee chats") }), toggle], [child]],
    [toggle.id]: [[block("paragraph", { rich_text: rt("Works at Stripe, wants an intro.") })]],
    [child.id]: [[block("paragraph", { rich_text: rt("SHOULD NOT APPEAR") })]],
  };
  const listed: string[] = [];
  const text = await blocksText(
    async (id, cursor) => {
      listed.push(`${id}:${cursor ?? ""}`);
      const pages = tree[id] ?? [[]];
      const i = cursor ? Number(cursor) : 0;
      return { results: pages[i]!, has_more: i + 1 < pages.length, next_cursor: String(i + 1) };
    },
    "root",
    10_000
  );
  t.check(
    "blocks read in order, children nested under their parent",
    text === "# Coffee chats\n- Ana\n  Works at Stripe, wants an intro.",
    JSON.stringify(text)
  );
  t.check("the walk follows pagination", listed.includes("root:1"));
  t.check("child pages are their own documents, not read into this one", !listed.some((l) => l.startsWith(child.id)));
  t.check("the text is capped", (await blocksText(async () => ({ results: tree.root![0]!, has_more: false, next_cursor: null }), "root", 5)).length <= 5);

  // ── a people database ──
  const columns = [
    { id: "title", name: "Name", type: "title" },
    { id: "a%3A1", name: "Work email", type: "email" },
    { id: "b%3A2", name: "Company", type: "select" },
    { id: "c%3A3", name: "Role", type: "rich_text" },
    { id: "d%3A4", name: "LinkedIn", type: "url" },
    { id: "e%3A5", name: "How we met", type: "rich_text" },
    { id: "f%3A6", name: "Last contacted", type: "date" },
  ];
  const guess = guessMapping(columns);
  t.check("the title column is the name", guess.fullName === "title");
  t.check("an email column is the email", guess.email === "a%3A1");
  t.check("columns named like the field are guessed", guess.company === "b%3A2" && guess.title === "c%3A3" && guess.linkedinUrl === "d%3A4" && guess.notes === "e%3A5");
  t.check("a date column is never guessed", !Object.values(guess).includes("f%3A6"));

  const row = {
    properties: {
      Name: { id: "title", type: "title", title: rt("Ana Ruiz") },
      "Work email": { id: "a%3A1", type: "email", email: "ana@example.com" },
      Company: { id: "b%3A2", type: "select", select: { name: "Stripe" } },
      Role: { id: "c%3A3", type: "rich_text", rich_text: rt("PM") },
      LinkedIn: { id: "d%3A4", type: "url", url: "https://example.com/not-linkedin" },
      "How we met": { id: "e%3A5", type: "rich_text", rich_text: [] },
    },
  };
  const person = rowToPerson(row, guess);
  t.check("a row reads by property id", person?.fullName === "Ana Ruiz" && person.email === "ana@example.com" && person.company === "Stripe" && person.title === "PM");
  t.check("a non-LinkedIn URL is not a LinkedIn profile", person?.linkedinUrl === null);
  t.check("an empty cell is null, never an empty string", person?.notes === null);
  t.check("a row with no name is skipped", rowToPerson({ properties: { Name: { id: "title", type: "title", title: [] } } }, guess) === null);

  t.done("Notion smoke tests");
}

void main();
