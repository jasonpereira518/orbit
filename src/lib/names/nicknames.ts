import { nameKey } from "./key";

/**
 * Nickname → the given names it is short for. The union of the two tables that used to live in
 * `duplicates.ts` and `recruiters.ts`.
 * ponytail: a short table, not a nickname database; add pairs as misses show up.
 */
const NICKNAMES: Record<string, string[]> = {
  abby: ["abigail"], alec: ["alexander"], alex: ["alexander", "alexandra", "alexis"],
  andy: ["andrew"], drew: ["andrew"], becky: ["rebecca"], beth: ["elizabeth"], liz: ["elizabeth"],
  ben: ["benjamin"], benny: ["benjamin"], bill: ["william"], billy: ["william"], will: ["william"],
  liam: ["william"], bob: ["robert"], bobby: ["robert"], rob: ["robert"], robbie: ["robert"],
  chris: ["christopher", "christina", "christine"], dan: ["daniel"], danny: ["daniel"],
  dave: ["david"], ed: ["edward"], eddie: ["edward"], greg: ["gregory"], jack: ["john"],
  jamie: ["james"], jim: ["james"], jimmy: ["james"], jeff: ["jeffrey"], jen: ["jennifer"],
  jenny: ["jennifer"], joe: ["joseph"], joey: ["joseph"], jon: ["jonathan", "john"],
  john: ["jonathan"], josh: ["joshua"], kate: ["katherine", "kathryn", "catherine"],
  katie: ["katherine", "kathryn", "catherine"], ken: ["kenneth"], kenny: ["kenneth"],
  larry: ["lawrence"], matt: ["matthew"], meg: ["megan", "margaret"], mick: ["michael"],
  mike: ["michael"], nate: ["nathan", "nathaniel"], nick: ["nicholas", "nicolas"],
  pat: ["patrick", "patricia"], pete: ["peter"], rich: ["richard"], rick: ["richard"],
  sam: ["samuel", "samantha"], sammy: ["samuel", "samantha"], steve: ["steven", "stephen"],
  sue: ["susan"], tim: ["timothy"], tom: ["thomas"], tommy: ["thomas"], tony: ["anthony"],
  vic: ["victor", "victoria"], zach: ["zachary"], zack: ["zachary"],
};

/**
 * Whether two given names can be the same person's: equal, one a nickname of the other, or two
 * nicknames of one name ("Bob" and "Rob"). Takes raw or keyed names.
 */
export function sameGivenName(a: string, b: string): boolean {
  const x = nameKey(a);
  const y = nameKey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const xs = NICKNAMES[x] ?? [];
  const ys = NICKNAMES[y] ?? [];
  return xs.includes(y) || ys.includes(x) || xs.some((g) => ys.includes(g));
}
