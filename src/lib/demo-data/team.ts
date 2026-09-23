/**
 * The demo team: two synthetic colleagues on the demo account's `orbit.local` domain, the
 * people they know, and four leads that land on every rung of the warmth ladder — so /leads
 * opens full on localhost, and a change that breaks the ranking shows there first.
 *
 * Colleagues are shared by every local account, like the demo recruiters: the first account
 * to seed creates their contacts, later ones only join the team.
 */
export const DEMO_TEAM_DOMAIN = "orbit.local";

export type DemoTeammate = { userId: string; firstName: string; lastName: string; email: string };

export const DEMO_TEAMMATES: readonly DemoTeammate[] = [
  { userId: "demo-teammate-alex", firstName: "Alex", lastName: "Rivera", email: "alex@orbit.local" },
  { userId: "demo-teammate-priya", firstName: "Priya", lastName: "Nair", email: "priya@orbit.local" },
];

export type DemoTeammateContact = {
  teammate: string;
  fullName: string;
  email: string;
  company: string;
  title: string;
  tier: "inner" | "mid" | "outer";
  closeness: number;
};

export const DEMO_TEAMMATE_CONTACTS: readonly DemoTeammateContact[] = [
  { teammate: "demo-teammate-alex", fullName: "Dana Whitfield", email: "dana@northwind.example", company: "Northwind Health", title: "VP Operations", tier: "inner", closeness: 84 },
  { teammate: "demo-teammate-alex", fullName: "Grace Okafor", email: "grace@lumenlabs.example", company: "Lumen Labs", title: "Head of Data", tier: "mid", closeness: 56 },
  { teammate: "demo-teammate-alex", fullName: "Leo Martins", email: "leo@northwind.example", company: "Northwind Health", title: "Procurement Lead", tier: "outer", closeness: 24 },
  { teammate: "demo-teammate-priya", fullName: "Grace Okafor", email: "grace@lumenlabs.example", company: "Lumen Labs", title: "Head of Data", tier: "outer", closeness: 31 },
  { teammate: "demo-teammate-priya", fullName: "Sam Patel", email: "sam@brightpath.example", company: "Brightpath", title: "CTO", tier: "outer", closeness: 22 },
];

export type DemoLead = {
  displayName: string;
  email: string;
  companyName: string;
  title: string;
  /** Where the seed must land it: the smoke checks every rung. */
  expected: "hot" | "warm" | "cool" | "cold";
};

export const DEMO_LEADS: readonly DemoLead[] = [
  // Alex knows Dana well: hot. Alex also knows Leo at Northwind, an account path.
  { displayName: "Dana Whitfield", email: "dana@northwind.example", companyName: "Northwind Health", title: "VP Operations", expected: "hot" },
  // Alex (mid) and Priya (outer) both know Grace: warm.
  { displayName: "Grace Okafor", email: "grace@lumenlabs.example", companyName: "Lumen Labs", title: "Head of Data", expected: "warm" },
  // Nobody knows Ivy, but Priya knows Sam at Brightpath: cool.
  { displayName: "Ivy Chen", email: "ivy@brightpath.example", companyName: "Brightpath", title: "VP Engineering", expected: "cool" },
  { displayName: "Marco Russo", email: "marco@quarry.example", companyName: "Quarry", title: "Founder", expected: "cold" },
];
