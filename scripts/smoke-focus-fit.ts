/**
 * focusFitComponent: how well a contact matches the user's skills and watched job titles.
 *
 * The cases are the reasons it is its own function rather than more goals: sixty skills must
 * not dilute, a long list is capped, an unrelated word must not hit, and the recruiting-side
 * bump only exists while the user has job alerts.
 *
 * Pure tier. Run: npx tsx scripts/smoke-focus-fit.ts
 */
import { focusFitComponent, type UserFocus } from "../src/lib/focus-fit";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const focus: UserFocus = {
  skills: ["Software Development", "Product Management", "Artificial Intelligence (AI)", "Go", "Distributed Systems"],
  roleKeywords: ["Software Engineer"],
};
const f = (title: string, industry = "") => focusFitComponent({ title, industry }, focus);

console.log("no signal");
check("no focus is 0", focusFitComponent({ title: "Staff Software Engineer" }, null) === 0);
check("an empty focus is 0", focusFitComponent({ title: "Engineer" }, { skills: [], roleKeywords: [] }) === 0);
check("a contact with no title or industry is 0", f("") === 0);

console.log("\nmatching");
check("a peer in your role family scores", f("Staff Software Engineer") > 0, String(f("Staff Software Engineer")));
check("word stems match: Manager ~ Management", focusFitComponent({ title: "Product Manager" }, { skills: ["Product Management"], roleKeywords: [] }) > 0);
check("an unrelated title scores 0", f("Dental Hygienist") === 0);
check("'Project Management' does not hit on an unrelated 'Report Writer'", focusFitComponent({ title: "Report Writer" }, { skills: ["Project Management"], roleKeywords: [] }) === 0);

console.log("\nscale");
const sixty: UserFocus = { skills: Array.from({ length: 60 }, (_, i) => `Skill${i} Topic${i}`).concat(["Rust"]), roleKeywords: [] };
check(
  "sixty unrelated skills do not dilute one real match",
  focusFitComponent({ title: "Rust Developer" }, sixty) === focusFitComponent({ title: "Rust Developer" }, { skills: ["Rust"], roleKeywords: [] })
);
const many: UserFocus = { skills: ["Rust", "Python", "Kubernetes", "Terraform", "Postgres"], roleKeywords: [] };
const everything = focusFitComponent({ title: "Rust Python Kubernetes Terraform Postgres Engineer" }, many);
check("skills alone are capped at 0.6", everything <= 0.6 + 1e-9 && everything > 0.5, String(everything));

console.log("\nthe job search");
check(
  "recruiters only count while there are job alerts",
  focusFitComponent({ title: "Technical Recruiter" }, { skills: ["Go"], roleKeywords: [] }) === 0 &&
    focusFitComponent({ title: "Technical Recruiter" }, { skills: ["Go"], roleKeywords: ["Software Engineer"] }) > 0
);
check(
  "the total never exceeds 1",
  focusFitComponent(
    { title: "Technical Recruiter, Software Engineer, Rust, Go" },
    { skills: ["Rust", "Go", "Software Engineer", "Recruiter"], roleKeywords: ["Software Engineer"] }
  ) <= 1
);

console.log("\nuntrusted text");
check("markup in a skill is not a word and is ignored", focusFitComponent({ title: "Engineer" }, { skills: ["<b>"], roleKeywords: [] }) === 0);

console.log(failures ? `\n${failures} check(s) failed` : "\nsmoke-focus-fit: all checks passed");
if (failures) process.exit(1);
process.exit(0);
