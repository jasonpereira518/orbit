/**
 * Deterministic large-network fixture shared by `seed-scale.ts` and the page-budget smoke
 * test. The demo fixture is a handful of contacts, which is exactly the size at which every
 * performance problem is invisible; a real LinkedIn export is thousands.
 */
import type { contacts } from "../../src/db/schema";

type ContactInsert = typeof contacts.$inferInsert;

const FIRST = ["Ada","Grace","Alan","Katherine","Edsger","Barbara","Donald","Margaret","Linus","Radia","Ken","Frances","Tim","Shafi","Vint","Adele","Bjarne","Anita","Guido","Carol","Yukihiro","Sophie","Rasmus","Jean","Dennis","Hedy","Niklaus","Evelyn","Brian","Mary"];
const LAST = ["Lovelace","Hopper","Turing","Johnson","Dijkstra","Liskov","Knuth","Hamilton","Torvalds","Perlman","Thompson","Allen","Berners-Lee","Goldwasser","Cerf","Goldberg","Stroustrup","Borg","van Rossum","Shaw","Matsumoto","Wilson","Lerdorf","Bartik","Ritchie","Lamarr","Wirth","Boyd","Kernighan","Keller"];
const COMPANIES = ["Acme","Northwind","Globex","Initech","Umbrella","Hooli","Stark Industries","Wayne Enterprises","Cyberdyne","Aperture","Black Mesa","Tyrell","Weyland","Soylent","Massive Dynamic","Pied Piper",null];
const TITLES = ["Engineer","Staff Engineer","Design Lead","Product Manager","Founder","CTO","Recruiter","Data Scientist","Researcher","VP Engineering",null];
const CITIES = ["Toronto","New York","London","Berlin","Lisbon","San Francisco","Austin","Singapore","Nairobi","São Paulo",null];
const SCHOOLS = ["Waterloo","MIT","Cambridge","UofT","Stanford","TU Delft",null];

const pick = <T,>(xs: T[], i: number) => xs[i % xs.length];
const DAY = 86400000;

/** ~30 KB of base64-looking filler: the size of a real inline JPEG avatar. */
const INLINE_AVATAR = `data:image/jpeg;base64,${"QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=".repeat(850)}`;
/** ~2 KB of notes, the size a few pasted coffee-chat summaries reach. */
const LONG_NOTES = "Met at the summit; talked hiring, the reorg, and a possible intro to their CTO. ".repeat(24);

export type ScaleFixtureOptions = {
  /** Share of contacts carrying an inline base64 avatar (the no-Blob storage mode). */
  inlineAvatarShare?: number;
  /** Share of contacts carrying multi-KB notes. */
  longNotesShare?: number;
  /** Row indexes whose follow-up is long overdue (sorts first among due follow-ups). */
  dueFollowUpRows?: number[];
};

/** `count` insertable contact rows for `userId`. Same input, same rows, every run. */
export function scaleContactRows(
  userId: string,
  count: number,
  options: ScaleFixtureOptions = {}
): ContactInsert[] {
  const inlineShare = options.inlineAvatarShare ?? 0;
  const notesShare = options.longNotesShare ?? 0;
  const due = new Set(options.dueFollowUpRows ?? []);
  const rows: ContactInsert[] = [];
  for (let i = 0; i < count; i++) {
    // Deterministic spread, so a rerun produces the same network.
    const r = ((i * 2654435761) % 100000) / 100000;
    const r2 = ((i * 40503) % 1000) / 1000;
    const first = pick(FIRST, i);
    const last = pick(LAST, i * 7 + 3);
    const interacted = r > 0.55;
    const hasLinkedIn = r > 0.4;
    rows.push({
      userId,
      fullName: `${first} ${last} ${i}`,
      firstName: first,
      lastName: last,
      company: pick(COMPANIES, i * 3),
      title: pick(TITLES, i * 5),
      location: pick(CITIES, i * 11),
      school: pick(SCHOOLS, i * 13),
      email: r > 0.35 ? `${first.toLowerCase()}.${i}@example.com` : null,
      linkedinUrl: hasLinkedIn
        ? `https://www.linkedin.com/in/${first.toLowerCase()}-${last.toLowerCase().replace(/[^a-z]/g, "")}-${i}/`
        : null,
      profileImageUrl: r2 < inlineShare ? INLINE_AVATAR : null,
      relationshipScore: 1 + Math.floor(r * 5),
      statedCloseness: r > 0.85 ? 1 + Math.floor(r * 5) : null,
      howMet: r > 0.7 ? "Met at a conference" : null,
      aiSummary: r > 0.5
        ? `Works on ${pick(TITLES, i) ?? "things"} at ${pick(COMPANIES, i * 3) ?? "an unlisted company"}.`
        : null,
      notes:
        r2 < notesShare
          ? LONG_NOTES
          : r > 0.75
            ? "Worth following up on the hiring conversation."
            : null,
      keyFacts: r > 0.6 ? ["Runs marathons", "Two kids"] : [],
      sharedInterests: r > 0.8 ? ["sailing", "typography"] : [],
      dateMet: new Date(Date.now() - (100 + r * 1500) * DAY),
      lastInteractionAt: interacted
        ? new Date(Date.now() - r * 400 * DAY)
        : new Date(Date.now() - 900 * DAY),
      nextFollowUpAt: due.has(i)
        ? new Date(Date.now() - 30 * DAY)
        : i % 23 === 0
          ? new Date(Date.now() - 3 * DAY)
          : null,
    });
  }
  return rows;
}
