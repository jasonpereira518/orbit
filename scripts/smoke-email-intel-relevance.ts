/**
 * Who, out of a person's network, is worth reaching for an email event. Orderings, not
 * literals: the weights are exported and compared against each other. Pure.
 * Run: npx tsx scripts/smoke-email-intel-relevance.ts
 */
import {
  EMAIL_RELEVANCE_WEIGHTS as W,
  scoreEmailContact,
  significantWords,
  stemOf,
  type EmailRelevanceInput,
} from "../src/lib/email-intel/relevance";

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const NORTHWIND = ["northwind"];

type Over = Omit<Partial<EmailRelevanceInput>, "candidate"> & { candidate?: Partial<EmailRelevanceInput["candidate"]> };

function input(over: Over = {}): EmailRelevanceInput {
  const { candidate, ...rest } = over;
  return {
    eventKind: "job_posting",
    eventCompany: "Northwind",
    eventCompanyKeys: NORTHWIND,
    eventRole: "Staff Engineer, Payments",
    candidate: {
      contactId: "c1",
      fullName: "Sam Rowe",
      company: "Northwind",
      title: "Account Coordinator",
      companyKeys: NORTHWIND,
      closenessTier: null,
      ...candidate,
    },
    via: { thread: false, search: false, searchRelevance: 0 },
    targetKeys: new Map(),
    goalFit: 0,
    ...rest,
  };
}
const score = (over?: Over) => scoreEmailContact(input(over)).score;
const codes = (over?: Over) => scoreEmailContact(input(over)).reasons.map((r) => r.code);

console.log("\nWords and stems");
check("seniority words and connectors are dropped", significantWords("Staff Engineer, Payments").join() === "engineer,payments", significantWords("Staff Engineer, Payments").join());
check("a director title keeps its function", significantWords("Director of Engineering").join() === "engineering");
check("repeats are folded", significantWords("Data data Engineer").join() === "data,engineer");
check("nothing in, nothing out", significantWords(null).length === 0 && significantWords("").length === 0);
check("engineer, engineers and engineering share a stem", stemOf("engineer") === stemOf("engineering") && stemOf("engineer") === stemOf("engineers"));
check("payment and payments share a stem", stemOf("payment") === stemOf("payments"));
check("different functions do not", stemOf("design") !== stemOf("engineer") && stemOf("sales") !== stemOf("support"));

console.log("\nOn the thread, at the company");
check("someone on the thread outranks a stranger to it", score({ via: { thread: true, search: false, searchRelevance: 0 } }) > score());
check("the company matters on its own", score() > score({ candidate: { company: "Elsewhere", companyKeys: ["elsewhere"] } }));
check("a company on the target list adds to its people", score({ targetKeys: new Map([["northwind", 2]]) }) > score());
check("a stronger target priority adds more", score({ targetKeys: new Map([["northwind", 1]]) }) > score({ targetKeys: new Map([["northwind", 2]]) }) && score({ targetKeys: new Map([["northwind", 2]]) }) > score({ targetKeys: new Map([["northwind", 3]]) }));
check("the target bonus needs the candidate to work there", score({ candidate: { company: "Elsewhere", companyKeys: ["elsewhere"] }, targetKeys: new Map([["northwind", 1]]) }) === score({ candidate: { company: "Elsewhere", companyKeys: ["elsewhere"] } }));
check("the company is matched through its suffix-less key", score({ candidate: { company: "Northwind, Inc.", companyKeys: ["northwind inc", "northwind"] } }) === score());

console.log("\nWho they are");
check("a recruiter at the company outranks a coordinator for a job", score({ candidate: { title: "Technical Recruiter" } }) > score());
check("a leader outranks an individual contributor", score({ candidate: { title: "VP of Sales" } }) > score());
check("a recruiter is worth nothing for company news", score({ eventKind: "news", candidate: { title: "Technical Recruiter" } }) === score({ eventKind: "news" }));
check("a leader still counts for company news", score({ eventKind: "news", candidate: { title: "VP of Sales" } }) > score({ eventKind: "news" }));
check("seniority is ignored for someone elsewhere", score({ candidate: { company: "Elsewhere", companyKeys: ["elsewhere"], title: "Technical Recruiter" } }) === score({ candidate: { company: "Elsewhere", companyKeys: ["elsewhere"], title: "Account Coordinator" } }));
check("seniority still counts for someone on the thread", score({ via: { thread: true, search: false, searchRelevance: 0 }, candidate: { company: "Elsewhere", companyKeys: ["elsewhere"], title: "Technical Recruiter" } }) > score({ via: { thread: true, search: false, searchRelevance: 0 }, candidate: { company: "Elsewhere", companyKeys: ["elsewhere"], title: "Account Coordinator" } }));

console.log("\nThe role");
const one = score({ candidate: { title: "Payments Analyst" } });
const two = score({ candidate: { title: "Payments Engineer" } });
check("a title sharing a word with the role scores", one > score());
check("sharing more words scores more", two > one);
check("the match survives a different suffix", score({ candidate: { title: "Director of Engineering" } }) > score({ candidate: { title: "Director of Sales" } }));
check("no role means no match", score({ eventRole: null, candidate: { title: "Payments Engineer" } }) === score({ eventRole: null }));
check("the reason names the shared words", scoreEmailContact(input({ candidate: { title: "Payments Engineer" } })).reasons.some((r) => r.code === "role_match" && /engineer/i.test(r.label)));

console.log("\nYou and them");
check("goal fit adds", score({ goalFit: 1 }) > score());
check("goal fit is capped", score({ goalFit: 50 }) === score({ goalFit: 1 }));
check("knowing them well adds", score({ candidate: { closenessTier: "inner" } }) > score({ candidate: { closenessTier: "mid" } }) && score({ candidate: { closenessTier: "mid" } }) > score({ candidate: { closenessTier: "outer" } }));

console.log("\nFound only by searching their profile");
const searchOnly = (relevance: number, over: Over = {}) =>
  score({ ...over, candidate: { company: "Elsewhere", companyKeys: ["elsewhere"], title: "Account Coordinator", ...(over.candidate ?? {}) }, via: { thread: false, search: true, searchRelevance: relevance } });
check("a profile match is worth something", searchOnly(1) > searchOnly(0));
check("a better match is worth more", searchOnly(1) > searchOnly(0.5));
check("a profile match adds nothing for someone at the company", score({ via: { thread: false, search: true, searchRelevance: 1 } }) === score());
check("nor for someone on the thread", score({ via: { thread: true, search: true, searchRelevance: 1 } }) === score({ via: { thread: true, search: false, searchRelevance: 0 } }));
check("a profile match alone is less than being at the company", searchOnly(1) < score());
check("the search reason is explained", codes({ candidate: { company: "Elsewhere", companyKeys: ["elsewhere"] }, via: { thread: false, search: true, searchRelevance: 1 } }).includes("search_match"));

console.log("\nShape of the answer");
const strongest = scoreEmailContact(input({
  via: { thread: true, search: false, searchRelevance: 0 },
  targetKeys: new Map([["northwind", 1]]),
  goalFit: 1,
  candidate: { title: "Technical Recruiter Payments Engineer", closenessTier: "inner" },
}));
check("a score never passes 100", strongest.score <= 100 && strongest.score > 0);
check("and never drops below 0", scoreEmailContact(input({ candidate: { company: "Elsewhere", companyKeys: ["elsewhere"] } })).score === 0);
check("the strongest case is a must", strongest.bucket === "must");
check("someone with no reasons is skip", scoreEmailContact(input({ candidate: { company: "Elsewhere", companyKeys: ["elsewhere"] } })).bucket === "skip" && scoreEmailContact(input({ candidate: { company: "Elsewhere", companyKeys: ["elsewhere"] } })).reasons.length === 0);
check("buckets rise with the score", (() => {
  const order = ["skip", "maybe", "good", "must"];
  const results = [
    input({ candidate: { company: "Elsewhere", companyKeys: ["elsewhere"] } }),
    input(),
    input({ candidate: { title: "Payments Engineer" } }),
    input({ via: { thread: true, search: false, searchRelevance: 0 }, candidate: { title: "Payments Engineer", closenessTier: "inner" } }),
  ].map((i) => scoreEmailContact(i));
  return results.every((r, i) => i === 0 || r.score >= results[i - 1]!.score) && results.every((r, i) => i === 0 || order.indexOf(r.bucket) >= order.indexOf(results[i - 1]!.bucket));
})());
check("reasons come strongest first", strongest.reasons.every((r, i) => i === 0 || strongest.reasons[i - 1]!.points >= r.points));
check("every reason has a code, a label and points", strongest.reasons.every((r) => r.code && r.label && r.points !== 0));
check("the same input scores the same", JSON.stringify(scoreEmailContact(input({ goalFit: 0.4 }))) === JSON.stringify(scoreEmailContact(input({ goalFit: 0.4 }))));
check("the weights are ordered sensibly", W.onThread > W.sameCompany && W.sameCompany > W.closeness.inner && W.closeness.inner > W.closeness.mid && W.roleMatchMany > W.roleMatchOne);

console.log("\nAll email-intel relevance checks passed.");
