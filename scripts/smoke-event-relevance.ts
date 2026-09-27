/**
 * Who to talk to: the weights, the reasons, and the refusals.
 *
 * `pure` tier — the scorer takes facts and returns a number with reasons, and that is the
 * whole contract.
 *
 * Three properties matter more than any individual weight:
 *
 *   1. **Every point has a reason.** The card shows reasons, not the score, so a point with
 *      nothing to say beside it is a recommendation the user cannot check.
 *   2. **It is deterministic.** A ranking that reshuffles between two page loads is one
 *      people stop trusting, which is the whole argument for scoring rather than prompting.
 *   3. **Relative order, not absolute values.** The assertions below compare scores to each
 *      other; hard-coding 35 would fail on every tuning pass and teach nothing.
 */
import {
  RELEVANCE_WEIGHTS,
  scoreAttendee,
  seniorityOf,
  type RelevanceInput,
} from "../src/lib/events/relevance";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

function input(over: Partial<RelevanceInput> = {}): RelevanceInput {
  return {
    fullName: "Ada Lovelace",
    company: "Stripe",
    title: "Engineer",
    attendeeRole: "attendee",
    connectedHere: false,
    companyKeys: ["stripe"],
    targetKeys: new Map(),
    goalFit: 0,
    eventsTogether: 1,
    network: null,
    knownAtCompany: 0,
    userSchools: [],
    eventKind: null,
    now: new Date("2026-06-01T12:00:00Z"),
    ...over,
  };
}

function main() {
  console.log("\nreading a job title");
  {
    // Recruiter is checked first on purpose: "Technical Recruiting Lead" is a recruiter, and
    // reading it as a "lead" files the most useful person at a fair under a generic rung.
    check("a recruiting lead is a recruiter", seniorityOf("Technical Recruiting Lead") === "recruiter");
    check("a founder", seniorityOf("Co-Founder & CEO") === "founder_exec");
    check("a head of", seniorityOf("Head of Design") === "leader");
    check("an engineer is an IC", seniorityOf("Senior Software Engineer") === "ic");
    check("no title is unknown", seniorityOf(null) === "unknown");
    check("campus recruiting counts", seniorityOf("University Relations") === "recruiter");
  }

  console.log("\nevery point comes with a reason");
  {
    const scored = scoreAttendee(
      input({
        title: "Head of Talent",
        targetKeys: new Map([["stripe", 1]]),
        goalFit: 0.8,
        eventsTogether: 3,
        knownAtCompany: 2,
      })
    );
    check("the score is positive", scored.score > 0, String(scored.score));
    check("and every reason carries points", scored.reasons.every((r) => r.points !== 0));
    check(
      "the points add up to the score",
      scored.reasons.reduce((sum, r) => sum + r.points, 0) === scored.score,
      `${scored.reasons.reduce((sum, r) => sum + r.points, 0)} vs ${scored.score}`
    );
    // Ordered by weight, so "show the top three" shows the three that mattered.
    check(
      "reasons are strongest first",
      scored.reasons.every((r, i) => i === 0 || scored.reasons[i - 1]!.points >= r.points)
    );
    check("a target company is named in words", scored.reasons.some((r) => /target list/i.test(r.label)));
  }

  console.log("\nwhat outranks what");
  {
    const dream = scoreAttendee(input({ targetKeys: new Map([["stripe", 1]]) })).score;
    const curious = scoreAttendee(input({ targetKeys: new Map([["stripe", 3]]) })).score;
    check("a dream company beats a curious one", dream > curious, `${dream} vs ${curious}`);

    const stranger = scoreAttendee(input()).score;
    check("and both beat a stranger with nothing to say", curious > stranger, `${curious} vs ${stranger}`);

    // The signal the feature exists for.
    const repeat = scoreAttendee(input({ eventsTogether: 4 })).score;
    check("someone you keep running into scores", repeat > stranger, String(repeat));
    const capped = scoreAttendee(input({ eventsTogether: 40 })).score;
    check(
      "but repetition is capped",
      capped - stranger <= RELEVANCE_WEIGHTS.repeatCap,
      String(capped - stranger)
    );
  }

  console.log("\na recruiter is worth more at a careers fair");
  {
    const atFair = scoreAttendee(input({ title: "Campus Recruiter", eventKind: "career_fair" }));
    const atParty = scoreAttendee(input({ title: "Campus Recruiter", eventKind: "party" }));
    check("the fair ranks them higher", atFair.score > atParty.score, `${atFair.score} vs ${atParty.score}`);
    check("and says why", atFair.reasons.some((r) => /careers fair/i.test(r.label)));
  }

  console.log("\nthe network cases");
  {
    // Not a slight on them: you do not need a conference to reach someone you speak to weekly.
    const close = scoreAttendee(
      input({
        network: {
          contactId: "c1",
          closenessTier: "inner",
          lastInteractionAt: new Date("2026-05-28T00:00:00Z"),
          schools: [],
        },
      })
    );
    check("someone you speak to weekly is deprioritised", close.score === 0, String(close.score));
    check("and it says why, rather than hiding them", close.reasons.some((r) => /already speak/i.test(r.label)));

    // The most commonly missed opportunity in any room.
    const lapsed = scoreAttendee(
      input({
        network: {
          contactId: "c2",
          closenessTier: "outer",
          lastInteractionAt: new Date("2025-09-01T00:00:00Z"),
          schools: [],
        },
      })
    );
    check("a lapsed contact is surfaced", lapsed.score > 0, String(lapsed.score));
    check("with the reason", lapsed.reasons.some((r) => /haven't spoken/i.test(r.label)));

    const alum = scoreAttendee(
      input({
        userSchools: ["University of North Carolina"],
        network: {
          contactId: "c3",
          closenessTier: "mid",
          lastInteractionAt: new Date("2025-09-01T00:00:00Z"),
          schools: ["UNC"],
        },
      })
    );
    // "University of" and "The" are noise; UNC and University of North Carolina are not the
    // same string and are the same school.
    // People write both forms: "University of North Carolina" on a profile, "UNC" in
    // conversation, and this signal is most useful in exactly that mismatch.
    check("a shared school counts even spelled differently", alum.reasons.some((r) => /same school/i.test(r.label)));
    const mit = scoreAttendee(
      input({
        userSchools: ["MIT"],
        network: {
          contactId: "c5",
          closenessTier: "mid",
          lastInteractionAt: new Date("2025-09-01T00:00:00Z"),
          schools: ["Massachusetts Institute of Technology"],
        },
      })
    );
    check("and the other way round", mit.reasons.some((r) => /same school/i.test(r.label)));
    const different = scoreAttendee(
      input({
        userSchools: ["Duke University"],
        network: {
          contactId: "c6",
          closenessTier: "mid",
          lastInteractionAt: new Date("2025-09-01T00:00:00Z"),
          schools: ["University of North Carolina"],
        },
      })
    );
    check("two different schools do not match", !different.reasons.some((r) => /same school/i.test(r.label)));
  }

  console.log("\nwarm paths, and who they are for");
  {
    const stranger = scoreAttendee(input({ knownAtCompany: 3 }));
    check("knowing people at a stranger's company counts", stranger.reasons.some((r) => /you know 3/i.test(r.label)));
    // For somebody already in the network it is noise: you have a direct line already.
    const known = scoreAttendee(
      input({
        knownAtCompany: 3,
        network: { contactId: "c4", closenessTier: "mid", lastInteractionAt: null, schools: [] },
      })
    );
    check("but not for someone you already know", !known.reasons.some((r) => /you know 3/i.test(r.label)));
  }

  console.log("\npeople already dealt with");
  {
    const done = scoreAttendee(
      input({ connectedHere: true, targetKeys: new Map([["stripe", 1]]) })
    );
    check("a connected attendee drops to the bottom", done.bucket === "skip", `${done.score}`);
    check("and the card filters them out", done.score < 22, String(done.score));
  }

  console.log("\nnothing to say means nothing shown");
  {
    const blank = scoreAttendee(input({ title: null, company: null, companyKeys: [] }));
    check("a stranger with no signal scores zero", blank.score === 0, String(blank.score));
    check("with no reasons to show", blank.reasons.length === 0);
    check("and is bucketed as skip", blank.bucket === "skip");
  }

  console.log("\nthe same inputs always give the same answer");
  {
    const args = input({ title: "Head of Talent", targetKeys: new Map([["stripe", 2]]), eventsTogether: 2 });
    const runs = Array.from({ length: 5 }, () => scoreAttendee(args));
    check("the score is stable", new Set(runs.map((r) => r.score)).size === 1);
    check(
      "and so is the reason order",
      new Set(runs.map((r) => r.reasons.map((x) => x.code).join(","))).size === 1
    );
  }

  console.log(
    failures === 0 ? "\nAll relevance checks passed\n" : `\n${failures} check(s) failed\n`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();
